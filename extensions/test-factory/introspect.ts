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

/** The subset of an extension manifest the factory needs. */
export interface ExtensionManifest {
  name: string;
  version: string;
  models: string[];
  workflows: string[];
  reports: string[];
  vaults: string[];
  datastores: string[];
  webhooks: string[];
}

/** Parse an extension manifest's list fields and identity. */
export function parseExtensionManifest(text: string): ExtensionManifest {
  const manifest: ExtensionManifest = {
    name: "",
    version: "",
    models: [],
    workflows: [],
    reports: [],
    vaults: [],
    datastores: [],
    webhooks: [],
  };
  const lines = text.split("\n");
  let currentList: keyof ExtensionManifest | null = null;
  let inDescription = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    // Top-level key ending in a list value or opening a block.
    if (/^\S/.test(line)) {
      inDescription = false;
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      if (value.startsWith(">") || value === "" && /description/.test(key)) {
        inDescription = key === "description";
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
        case "webhooks": {
          const listKey = key as
            | "models"
            | "workflows"
            | "reports"
            | "vaults"
            | "datastores"
            | "webhooks";
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
    if (inDescription) continue;
    // Indented list item under the current key.
    if (currentList) {
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item) {
        (manifest[currentList] as string[]).push(unquote(item[1].trim()));
      }
    }
  }
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
 * Looks for the `type: "@collective/name"` field inside the exported object —
 * robust enough for every extension in this repo and dependency-free.
 */
export function extractTypeFromSource(source: string): string | null {
  const m = /type:\s*["'`]([^"'`]+)["'`]/.exec(source);
  return m ? m[1] : null;
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
  dir: string;
}> {
  const dir = dirname(resolve(manifestPath));
  const manifest = parseExtensionManifest(
    await Deno.readTextFile(manifestPath),
  );

  const modelTypes: string[] = [];
  for (const file of manifest.models) {
    if (extname(file) !== ".ts") continue;
    try {
      const src = await Deno.readTextFile(join(dir, file));
      const type = extractTypeFromSource(src);
      if (type && !modelTypes.includes(type)) modelTypes.push(type);
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

  return { manifest, modelTypes, workflowNames, dir };
}
