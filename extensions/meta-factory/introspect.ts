/**
 * Pure discovery helpers for the meta-factory.
 *
 * These functions read the filesystem but perform no swamp/deno invocation, so
 * they are cheap to unit test. `meta_factory.ts` layers subprocess calls
 * (`swamp model type describe`, `deno doc`) on top.
 *
 * @module
 */
import { dirname, join, relative } from "jsr:@std/path@1";

/** A discovered extension manifest. */
export interface ManifestEntry {
  /** Absolute path to the manifest file. */
  path: string;
  /** Directory containing the manifest (path-resolution base). */
  dir: string;
  /** Path relative to the search root, for display. */
  relative: string;
}

/** Recursively find every `manifest.yaml` under `root`. */
export async function discoverManifests(
  root: string,
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile && e.name === "manifest.yaml") {
        out.push({
          path: full,
          dir: dirname(full),
          relative: relative(root, full),
        });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

/**
 * Turn `git ls-files` output into extension manifest entries.
 *
 * Only paths ending in `manifest.yaml` are kept, so a repo-managed tree
 * (tracked in git) is scored while pulled/generated copies under `.swamp/` are
 * excluded — the caller supplies the list, which keeps this pure and testable.
 * `.swamp/` and `node_modules/` paths are dropped as defence in depth, matching
 * the filesystem walk's exclusions even if a caller's git pathspec is broader.
 *
 * @param root Absolute directory the relative paths are resolved against.
 * @param listed One `git ls-files` path per line, relative to `root`.
 */
export function manifestsFromGitList(
  root: string,
  listed: string[],
): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const rel of listed) {
    const trimmed = rel.trim();
    if (!trimmed || !/(^|\/)manifest\.yaml$/.test(trimmed)) continue;
    if (/(^|\/)(\.swamp|node_modules)\//.test(trimmed)) continue;
    const path = join(root, trimmed);
    out.push({ path, dir: dirname(path), relative: relative(root, path) });
  }
  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}

/**
 * Extract the model/extension type string from a source file.
 *
 * Looks for the first `type: "@collective/name"` literal — the canonical shape
 * used by every model, vault, datastore, and report export. Returns `null`
 * when no type string is present (e.g. a helper module).
 */
export function extractTypeFromSource(source: string): string | null {
  const m = source.match(
    /type:\s*["'`](@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+)["'`]/,
  );
  return m ? m[1] : null;
}

/** Extract exported method names from a source file's `methods:` block. */
export function extractMethodKeysFromSource(source: string): string[] {
  // Find `methods: {` and read only the keys at depth 1 (direct members of the
  // methods object), so nested object keys inside a method are not mistaken for
  // method names.
  const start = source.search(/\bmethods:\s*\{/);
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

    // At depth 1, match `key:` where key starts at the beginning of a line.
    if ((i === 0 || source[i - 1] === "\n")) {
      const rest = source.slice(i);
      const m = rest.match(/^\s*([A-Za-z_$][\w$]*):\s*(\{|[A-Za-z_$])/);
      if (m) {
        const key = m[1];
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
  }
  return keys;
}

/** Sanitize a path into a safe swamp resource instance name. */
export function sanitizeInstanceName(rel: string): string {
  return rel
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
