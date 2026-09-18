/**
 * CEL-safe text transport.
 *
 * Swamp recursively re-evaluates `${{ ... }}` sequences found in values passed
 * between workflow steps. Collected free text legitimately contains such
 * examples — a swamp release body documenting `${{ env.VAR }}` support is the
 * real case that broke an early run — and re-evaluating them aborts the run
 * with `Invalid expression: No such key: VAR`.
 *
 * Collectors run {@link celEscape} on free-text fields before writing them to
 * resources; the pulse model runs {@link celUnescape} as soon as it reads them
 * back, so all downstream parsing and rendering sees the original text.
 *
 * @module
 */

/** Private-use marker inserted between `$` and `{{`. */
const CEL_GUARD = "\uE000";

/** Neutralise literal `${{` sequences for safe transport through CEL. */
export function celEscape(text: string): string {
  return String(text ?? "").replace(/\$\{\{/g, `$${CEL_GUARD}{{`);
}

/** Restore `${{` sequences neutralised by {@link celEscape}. */
export function celUnescape(text: string): string {
  return String(text ?? "").replace(
    new RegExp(`\\$${CEL_GUARD}\\{\\{`, "g"),
    "${{",
  );
}

/** Recursively {@link celUnescape} every string in a value. */
export function celUnescapeDeep<T>(value: T): T {
  if (typeof value === "string") return celUnescape(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => celUnescapeDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = celUnescapeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
