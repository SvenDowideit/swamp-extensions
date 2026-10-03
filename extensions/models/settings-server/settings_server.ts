/**
 * @svendowideit/settings-server
 *
 * Publishes a rendered settings bundle over HTTP(S). It takes the directory
 * produced by `@svendowideit/otel-settings` (or any static document tree),
 * stages it into a stable **webroot** layout (`current` + immutable
 * `v/<hash>`), and verifies that the live URL serves the expected documents.
 *
 * The static-file serving itself is delegated to `@svendowideit/caddy`'s
 * `serveSettings` (so DNS + TLS + file serving are one tested path); this model
 * owns staging, the version pointer, and the HTTP verification.
 *
 * All logic is pure and exported for unit testing except `publish`, which is
 * the only method that touches the filesystem/network.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args & method args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  sourceDir: z.string().describe(
    "Directory containing the rendered documents (e.g. the `current` dir from @svendowideit/otel-settings)",
  ),
  webroot: z.string().default("~/.local/share/settings-server").describe(
    "Directory Caddy serves; `current` and `v/<version>` are staged here",
  ),
  hostname: z.string().describe(
    "Public hostname the documents are served on (e.g. settings.otel.fi.gy)",
  ),
  indexDocument: z.string().default("otel.json").describe(
    "Document fetched to verify the server is live",
  ),
  publishBaseUrl: z.string().default("").describe(
    "Override the base URL for verification; empty derives https://<hostname>",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PublishArgsSchema = z.object({
  sourceDir: z.string().optional().describe(
    "Override the source directory (defaults to global sourceDir)",
  ),
  version: z.string().optional().describe(
    "Override the staged version label; defaults to the source `version.json` hash or a content hash",
  ),
});

const VerifyArgsSchema = z.object({
  expectDocument: z.string().optional().describe(
    "Document path to fetch for verification (defaults to global indexDocument)",
  ),
  timeoutMs: z.number().int().positive().default(5000).describe(
    "Per-request timeout in milliseconds",
  ),
});

const ServeArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const DocumentSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

const PublishOutputSchema = z.object({
  version: z.string(),
  sourceDir: z.string(),
  webroot: z.string(),
  currentDir: z.string(),
  documents: z.array(DocumentSchema),
  publishedAt: z.string(),
});

const VerifyOutputSchema = z.object({
  url: z.string(),
  ok: z.boolean(),
  status: z.number(),
  contentType: z.string(),
  bytes: z.number(),
  verifiedAt: z.string(),
});

const ServeOutputSchema = z.object({
  hostname: z.string(),
  webroot: z.string(),
  currentDir: z.string(),
  url: z.string(),
  method: z.string(),
  servedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A staged document's manifest entry. */
export interface Document {
  /** Path relative to the settings root. */
  path: string;
  /** Byte length. */
  bytes: number;
  /** SHA-256 of the content. */
  sha256: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home?: string): string {
  const h = home ?? Deno.env.get("HOME") ?? "";
  if (path === "~") return h;
  if (path.startsWith("~/")) return `${h}${path.slice(1)}`;
  return path;
}

/** The base URL documents are served from. */
export function baseUrl(hostname: string, override = ""): string {
  return override || `https://${hostname}`;
}

/** Map a document path to its HTTP content type. */
export function contentTypeFor(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return "application/yaml; charset=utf-8";
  }
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".html") || path.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  if (path.endsWith(".env") || path.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

/**
 * The version label for a publish: the source `version.json` hash when present,
 * otherwise a hash of the sorted (path, size) list so identical trees share a
 * label.
 */
export function deriveVersion(
  sourceVersionJson: string | null,
  entries: Array<{ path: string; bytes: number }>,
): string {
  if (sourceVersionJson) {
    try {
      const parsed = JSON.parse(sourceVersionJson);
      if (typeof parsed.version === "string" && parsed.version) {
        return parsed.version;
      }
    } catch {
      // fall through to the computed hash
    }
  }
  const signature = entries
    .map((e) => `${e.path}:${e.bytes}`)
    .sort()
    .join("\n");
  return contentHashHex(signature);
}

/** Stable FNV-1a 128-bit content hash (hex), matching otel-settings' label. */
export function contentHashHex(input: string): string {
  const data = new TextEncoder().encode(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    h1 ^= data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + data[i]) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

/** Cryptographic SHA-256 (hex) for staged-document integrity. */
export async function sha256HexAsync(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Validate the global args, returning human-readable errors. */
export function validateConfig(g: {
  sourceDir: string;
  webroot: string;
  hostname: string;
}): string[] {
  const errors: string[] = [];
  if (!g.sourceDir) errors.push("sourceDir is required");
  if (!g.webroot) errors.push("webroot is required");
  if (!g.hostname) errors.push("hostname is required");
  if (g.hostname.includes("://") || g.hostname.includes("/")) {
    errors.push("hostname must be a bare name like settings.example.com");
  }
  if (g.sourceDir === g.webroot) {
    errors.push("sourceDir and webroot must differ (staging would recurse)");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The swamp model definition for `@svendowideit/settings-server`. */
export const model = {
  type: "@svendowideit/settings-server",
  version: "2026.10.03.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "valid-config": {
      description: "Validate the source directory, webroot, and hostname",
      labels: ["policy"],
      appliesTo: ["publish", "verify", "serve"],
      execute: (context: { globalArgs: GlobalArgs }): {
        pass: boolean;
        errors?: string[];
      } => {
        const errors = validateConfig(context.globalArgs);
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.03.1",
      description:
        "Initial release: stage a rendered settings bundle into a versioned webroot, expose the Caddy serveSettings wiring, and verify the live URL over HTTP.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    publish: {
      description: "Staged settings bundle",
      schema: PublishOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    verify: {
      description: "HTTP verification of the settings URL",
      schema: VerifyOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    serve: {
      description: "Serve wiring description for @svendowideit/caddy",
      schema: ServeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    publish: {
      description:
        "Stage the rendered documents into the webroot's v/<version> and flip the current pointer",
      arguments: PublishArgsSchema,
      execute: async (
        args: z.infer<typeof PublishArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const errors = validateConfig(g);
        if (errors.length > 0) {
          throw new Error(`invalid config: ${errors.join("; ")}`);
        }
        const sourceDir = expandHome(args.sourceDir ?? g.sourceDir);
        const webroot = expandHome(g.webroot);

        // Collect the source tree (skip the version pointer symlink).
        const entries: Array<{ rel: string; abs: string; bytes: number }> = [];
        for await (const entry of walk(sourceDir)) {
          if (entry.rel === "current") continue;
          entries.push(entry);
        }
        let sourceVersion: string | null = null;
        try {
          sourceVersion = await Deno.readTextFile(`${sourceDir}/version.json`);
        } catch {
          sourceVersion = null;
        }
        const version = args.version ??
          deriveVersion(
            sourceVersion,
            entries.map((e) => ({
              path: e.rel,
              bytes: e.bytes,
            })),
          );

        const versionDir = `${webroot}/v/${version}`;
        const currentDir = `${webroot}/current`;

        const documents: Document[] = [];
        for (const entry of entries) {
          const target = `${versionDir}/${entry.rel}`;
          const slash = target.lastIndexOf("/");
          await Deno.mkdir(target.slice(0, slash), { recursive: true });
          const content = await Deno.readTextFile(entry.abs);
          await Deno.writeTextFile(target, content);
          documents.push({
            path: entry.rel,
            bytes: new TextEncoder().encode(content).length,
            sha256: await sha256HexAsync(content),
          });
        }

        await flipPointer(versionDir, currentDir);
        await Deno.mkdir(webroot, { recursive: true });

        context.logger?.info(
          "Staged {count} documents into {dir} (version {version})",
          { count: documents.length, dir: currentDir, version },
        );

        const handle = await context.writeResource("publish", "current", {
          version,
          sourceDir,
          webroot,
          currentDir,
          documents,
          publishedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Fetch the index document from the live settings hostname and report its status",
      arguments: VerifyArgsSchema,
      execute: async (
        args: z.infer<typeof VerifyArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const doc = args.expectDocument ?? g.indexDocument;
        // The hostname already names the settings host (e.g. settings.otel.fi.gy),
        // so documents are served at the root: /otel.json, not /settings/otel.json.
        const url = `${baseUrl(g.hostname, g.publishBaseUrl)}/${doc}`;
        let status = 0;
        let contentType = "";
        let bytes = 0;
        try {
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(args.timeoutMs),
          });
          status = resp.status;
          contentType = resp.headers.get("content-type") ?? "";
          bytes = (await resp.arrayBuffer()).byteLength;
        } catch (err) {
          context.logger?.info("verify failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const ok = status >= 200 && status < 300 && bytes > 0;

        const handle = await context.writeResource("verify", "current", {
          url,
          ok,
          status,
          contentType,
          bytes,
          verifiedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    serve: {
      description:
        "Report the @svendowideit/caddy serveSettings wiring (hostname + current webroot) for a workflow to apply",
      arguments: ServeArgsSchema,
      execute: async (
        _args: z.infer<typeof ServeArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const g = context.globalArgs;
        const webroot = expandHome(g.webroot);
        const currentDir = `${webroot}/current`;
        const handle = await context.writeResource("serve", "current", {
          hostname: g.hostname,
          webroot,
          currentDir,
          url: baseUrl(g.hostname, g.publishBaseUrl),
          method:
            "swamp model method run <caddy-model> serveSettings --input hostname=" +
            `${g.hostname} --input root=${currentDir}`,
          servedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Replace `current` with a symlink (or copied tree) pointing at `versionDir`. */
async function flipPointer(
  versionDir: string,
  currentDir: string,
): Promise<void> {
  try {
    await Deno.remove(currentDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  try {
    await Deno.symlink(versionDir, currentDir);
  } catch {
    await copyDir(versionDir, currentDir);
  }
}

/** Recursively copy a directory. */
async function copyDir(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(src, dst);
    } else {
      await Deno.copyFile(src, dst);
    }
  }
}

/** Walk a directory, yielding relative path, absolute path, and byte size. */
async function* walk(
  root: string,
  prefix = "",
): AsyncGenerator<{ rel: string; abs: string; bytes: number }> {
  for await (const entry of Deno.readDir(root)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(abs, rel);
    } else if (entry.isFile) {
      const stat = await Deno.stat(abs);
      yield { rel, abs, bytes: stat.size };
    }
  }
}
