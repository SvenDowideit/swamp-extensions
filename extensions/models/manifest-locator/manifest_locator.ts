/**
 * Locates the `manifest.yaml` of the extension this model belongs to.
 *
 * A method receives `ctx.extensionFile()`, the sanctioned way to resolve a path
 * to an asset bundled with the extension. Its resolution root differs by how
 * the extension was loaded: for a source-loaded extension it is the directory
 * holding `manifest.yaml`, while a pulled extension keeps its `additionalFiles`
 * under `<extension-dir>/files/` and its `manifest.yaml` one level up. There is
 * no API that hands back the manifest path directly, so this module anchors on
 * a bundled asset and walks up from it until it finds the `manifest.yaml`.
 *
 * That makes the manifest the single source of truth for the extension's
 * version, with no version literal duplicated in this file.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** No global arguments. */
const GlobalArgsSchema = z.object({});

/** The `location` resource: where this extension's manifest is and what it says. */
const OutputSchema = z.object({
  manifestPath: z.string(),
  exists: z.boolean(),
  version: z.string(),
  manifest: z.string(),
});

/** Directory separator-agnostic parent of an absolute path. */
function parentDir(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

/** Join a directory and a child name with a single separator. */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/${name}`;
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * Find the `manifest.yaml` for a model by resolving a bundled asset and
 * walking up from wherever it lands.
 *
 * `resolve` is `ctx.extensionFile` (or a test double). It is tried with the
 * asset paths this extension always ships (`README.md`, `LICENSE.txt`) and
 * finally with `""`, which resolves to the extension files root itself. From
 * each resolved path the directory tree is walked upward (bounded) until a
 * `manifest.yaml` is found — covering both the source layout (manifest beside
 * the assets) and the pulled layout (`<ext>/files/…` with the manifest one
 * level up).
 *
 * @returns the absolute manifest path, or `""` when none is reachable.
 */
export function findManifestPath(resolve: (relPath: string) => string): string {
  const anchors = ["README.md", "LICENSE.txt", ""];
  for (const anchor of anchors) {
    let dir: string;
    try {
      dir = resolve(anchor);
    } catch {
      continue;
    }
    for (let depth = 0; depth < 6 && dir; depth++) {
      const candidate = joinPath(dir, "manifest.yaml");
      if (isFile(candidate)) return candidate;
      const parent = parentDir(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "";
}

/** The `version:` value from a manifest's YAML text, or `""`. */
export function parseManifestVersion(manifest: string): string {
  const match = manifest.match(/^version:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return match ? match[1].trim() : "";
}

/** Model definition for the manifest locator. */
export const model = {
  type: "@svendowideit/manifest-locator",
  version: "2026.10.10.3133",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.10.3133",
      description:
        "Locate manifest.yaml robustly for pulled extensions: anchor on a bundled additionalFile (or the extension files root) and walk up to the manifest, instead of assuming the manifest sits beside the resolved asset. No global arguments change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    location: {
      description:
        "Absolute path to, and contents of, this extension's manifest.yaml",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    locate: {
      description:
        "Print the manifest.yaml path this model was loaded from and its version",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          extensionFile: (relPath: string) => string;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger?: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const manifestPath = findManifestPath(context.extensionFile);

        let manifest = "";
        try {
          manifest = manifestPath ? Deno.readTextFileSync(manifestPath) : "";
        } catch {
          // Reported as exists=false below.
        }

        const version = parseManifestVersion(manifest);

        context.logger?.info("manifest.yaml: {path}", { path: manifestPath });
        context.logger?.info("manifest.yaml version: {version}", { version });

        const handle = await context.writeResource("location", "manifest", {
          manifestPath,
          exists: manifestPath !== "",
          version,
          manifest,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
