/**
 * Discovery helpers for the test factory.
 *
 * Reads a candidate extension's `manifest.yaml` and source to learn which model
 * types and workflows it declares, so the harness can assert they register and
 * their definitions are valid. Also parses the scenario file and the extension
 * `manifest.yaml` itself (a tiny YAML subset — no dependency is pulled in).
 *
 * @module
 */
import { basename, dirname, extname, join, resolve } from "jsr:@std/path@1";
import type { TypeMethods } from "./coverage.ts";

/** The subset of an extension manifest the factory needs. */
export interface ExtensionManifest {
  name: string;
  version: string;
  /** The manifest `description:` block — the published user manual. */
  description: string;
  models: string[];
  workflows: string[];
  reports: string[];
  vaults: string[];
  datastores: string[];
  webhooks: string[];
  /** Extra files the extension ships, e.g. README and its test-factory.yaml. */
  additionalFiles: string[];
}

/** Parse an extension manifest's list fields and identity. */
export function parseExtensionManifest(text: string): ExtensionManifest {
  const manifest: ExtensionManifest = {
    name: "",
    version: "",
    description: "",
    models: [],
    workflows: [],
    reports: [],
    vaults: [],
    datastores: [],
    webhooks: [],
    additionalFiles: [],
  };
  const lines = text.split("\n");
  let currentList: keyof ExtensionManifest | null = null;
  let inDescription = false;
  const description: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    // Top-level key ending in a list value or opening a block.
    if (/^\S/.test(line)) {
      inDescription = false;
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "description") {
        // A `|`/`>` block scalar, or an empty value, opens a block; an inline
        // value is the whole description.
        inDescription = value.startsWith(">") || value.startsWith("|") ||
          value === "";
        if (!inDescription) description.push(unquote(value));
      }
      switch (key) {
        case "name":
          manifest.name = unquote(value);
          currentList = null;
          break;
        case "version":
          manifest.version = unquote(value);
          currentList = null;
          break;
        case "models":
        case "workflows":
        case "reports":
        case "vaults":
        case "datastores":
        case "webhooks":
        case "additionalFiles": {
          const listKey = key as
            | "models"
            | "workflows"
            | "reports"
            | "vaults"
            | "datastores"
            | "webhooks"
            | "additionalFiles";
          currentList = listKey;
          // Inline list form: `models: [a.ts, b.ts]`
          const inline = /^\[(.*)\]$/.exec(value.trim());
          manifest[listKey] = inline
            ? inline[1]
              .split(",")
              .map((s) => unquote(s.trim()))
              .filter((s) => s.length > 0)
            : [];
          break;
        }
        default:
          currentList = null;
      }
      continue;
    }
    if (inDescription) {
      // Keep the raw indented block; the coverage parser only needs the
      // command lines, and preserving indentation keeps them recognizable.
      description.push(line.replace(/\s+$/, ""));
      continue;
    }
    // Indented list item under the current key.
    if (currentList) {
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item) {
        (manifest[currentList] as string[]).push(unquote(item[1].trim()));
      }
    }
  }
  manifest.description = description.join("\n");
  return manifest;
}

/** Strip surrounding single/double quotes from a scalar. */
function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Extract the `type:` string a model/report/vault source exports.
 *
 * Matches a `type: "<collective>/<name>"` value — the one field whose value has
 * a `collective/name` shape — whether it sits on its own line or inline in the
 * exported object. Requiring that shape stops it mistaking a union member such
 * as `type: "A" | "AAAA" | "CNAME";` for the model type. Robust enough for
 * every extension in this repo and dependency-free.
 */
export function extractTypeFromSource(source: string): string | null {
  const m = /type:\s*["'`](@?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["'`]/.exec(
    source,
  );
  return m ? m[1] : null;
}

/**
 * Extract the keys of the exported `methods:` object from a model source file.
 *
 * Reads only the keys at bracket depth 1 (direct members of the `methods`
 * object), so a nested object inside a method is not mistaken for a method
 * name. Good enough for a coverage count; the load phase is what actually
 * proves the methods register.
 */
export function extractMethodKeys(source: string): string[] {
  const start = source.search(/\bmethods\s*:\s*\{/);
  if (start < 0) return [];
  const open = source.indexOf("{", start);
  let depth = 0;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (i === 0 || source[i - 1] === "\n") {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*[\{A-Za-z_$]/.exec(
        source.slice(i),
      );
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        keys.push(m[1]);
      }
    }
  }
  return keys;
}

/**
 * Read the declared model types and workflow names for an extension.
 *
 * Model types come from the declared `models:` source files; workflows are
 * named from the `name:` field of each declared workflow YAML (falling back to
 * the file's basename without extension, which is also how swamp addresses an
 * unnamed workflow).
 */
export async function inspectExtension(
  manifestPath: string,
): Promise<{
  manifest: ExtensionManifest;
  modelTypes: string[];
  workflowNames: string[];
  /** Each declared model type and the method keys its source exports. */
  typeMethods: TypeMethods[];
  dir: string;
  /**
   * Absolute path to the candidate's `test-factory.yaml`, discovered from the
   * manifest's `additionalFiles:` (any entry whose basename matches). Empty
   * when the candidate ships no acceptance tests.
   */
  testsPath: string;
}> {
  const dir = dirname(resolve(manifestPath));
  const manifest = parseExtensionManifest(
    await Deno.readTextFile(manifestPath),
  );

  const modelTypes: string[] = [];
  const typeMethods: TypeMethods[] = [];
  for (const file of manifest.models) {
    if (extname(file) !== ".ts") continue;
    try {
      const src = await Deno.readTextFile(join(dir, file));
      const type = extractTypeFromSource(src);
      if (!type) continue;
      if (!modelTypes.includes(type)) modelTypes.push(type);
      const methods = extractMethodKeys(src);
      const existing = typeMethods.find((t) => t.type === type);
      if (existing) {
        for (const m of methods) {
          if (!existing.methods.includes(m)) existing.methods.push(m);
        }
      } else {
        typeMethods.push({ type, methods, known: true });
      }
    } catch {
      // Unreadable source — skip; the load phase will fail loudly instead.
    }
  }

  const workflowNames: string[] = [];
  for (const file of manifest.workflows) {
    let name = basename(file, extname(file));
    try {
      const src = await Deno.readTextFile(join(dir, file));
      const m = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(src);
      if (m) name = m[1].trim();
    } catch {
      // keep basename fallback
    }
    workflowNames.push(name);
  }

  const testsEntry = manifest.additionalFiles.find(
    (f) => basename(f) === "test-factory.yaml",
  );
  const testsPath = testsEntry ? resolve(dir, testsEntry) : "";

  return {
    manifest,
    modelTypes,
    workflowNames,
    typeMethods,
    dir,
    testsPath,
  };
}
