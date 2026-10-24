/**
 * Shared cache-key and read helpers for `@svendowideit/wikipedia`.
 *
 * The cache layout is byte-for-byte compatible with
 * `@svendowideit/web-cache`: one directory per request URL
 * (`<url-slug>-<fnv1a>`), containing `body` and `meta.json`. `web-cache` is the
 * only writer; this module only derives keys and reads bodies.
 *
 * A response may live under either of two keys for the same page:
 *
 *   - the public MediaWiki URL (`pageUrl` / `searchUrl` / `pagePropsUrl`), or
 *   - the synthetic Wikimedia Enterprise article URL.
 *
 * Both are ordinary `web-cache` entries, so the same reader works for either.
 *
 * @module
 */

/** Expand `~` to the home directory, honouring SWAMP_HOME for `~/.swamp`. */
export function expandHome(raw: string): string {
  if (raw === "~") {
    return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "~";
  }
  if (raw.startsWith("~/")) {
    if (raw === "~/.swamp" || raw.startsWith("~/.swamp/")) {
      const swampHome = Deno.env.get("SWAMP_HOME");
      if (swampHome) {
        const base = swampHome.replace(/\/+$/, "");
        const suffix = raw.slice("~/.swamp".length);
        return suffix ? `${base}${suffix}` : base;
      }
    }
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (home) return `${home}${raw.slice(1)}`;
  }
  return raw;
}

/**
 * Deterministic 32-bit hash (FNV-1a). Identical to
 * `@svendowideit/web-cache`'s `fnv1a`.
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonicalize a URL so equivalent spellings share a cache key. This MUST
 * stay byte-for-byte identical to `@svendowideit/web-cache`'s `normalizeUrl`.
 */
export function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if (u.protocol === "http:" && u.port === "80") u.port = "";
  if (u.protocol === "https:" && u.port === "443") u.port = "";
  u.hash = "";

  const entries = [...u.searchParams.entries()].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : 1;
  });
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.append(k, v);
  u.search = sp.toString();

  return u.toString();
}

/** URL-only cache key, identical to `@svendowideit/web-cache`'s `webCacheKey`. */
export function webCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  const safe = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

/** Read a cached body for a URL, or null when the entry is absent. */
export async function readCachedBody(
  dir: string,
  url: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${dir}/${webCacheKey(url)}/body`);
  } catch {
    return null;
  }
}
