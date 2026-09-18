/**
 * Documentation-path classification, shared by the GitHub collector (which
 * filters changed files down to docs) and the pulse model (which builds doc
 * links).
 *
 * Kept in its own module so the collector does not have to import the model.
 *
 * @module
 */

/** True when a changed path looks like documentation. */
export function isDocPath(path: string, extraPattern?: string): boolean {
  const p = String(path ?? "");
  if (/\.(md|mdx)$/i.test(p)) return true;
  if (/(^|\/)README(\.[^/]*)?$/i.test(p)) return true;
  if (p.startsWith("design/")) return true;
  if (p.includes("/docs/")) return true;
  if (p.includes("/manual/")) return true;
  if (extraPattern) {
    try {
      return new RegExp(extraPattern, "i").test(p);
    } catch {
      return false;
    }
  }
  return false;
}
