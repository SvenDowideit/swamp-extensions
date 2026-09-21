/**
 * Shared on-disk response cache for the `@svendowideit/garmin` extension family.
 *
 * The transport model (`garmin_connect.ts`) writes raw `connectapi` responses
 * here; domain models (`garmin_devices.ts` and later) read them back and parse
 * them. Keeping the key scheme and file layout in one module means the writer
 * and every reader agree byte-for-byte — the same contract
 * `@svendowideit/web-cache` maintains with `@svendowideit/wikidata`.
 *
 * Layout, under `cacheDir` (default `~/.swamp/garmin-cache`):
 *
 *   <key>/meta.json   fetch metadata (path, status, fetchedAt, size, …)
 *   <key>/body        the raw UTF-8 response body
 *   .last-request     epoch ms of the last origin request, for cross-run pacing
 *
 * `key` is `cacheKey(path)`: a filesystem-safe slug plus an FNV-1a hash of the
 * normalised path, so equivalent requests (query-param order aside) share a key.
 *
 * @module
 */
import { CONNECTAPI_HOST } from "./garmin_auth.ts";

/** Expand a leading `~` to the home directory. */
export function expandHome(raw: string): string {
  if (raw.startsWith("~")) {
    const home = Deno.env.get("HOME") ?? "~";
    return raw === "~" ? home : `${home}${raw.slice(1)}`;
  }
  return raw;
}

/** Deterministic 32-bit FNV-1a hash, stable across runs and processes. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonicalise a `connectapi` path so two spellings of the same request share
 * one cache key: query params sorted, fragment dropped, host fixed.
 */
export function normalizePath(path: string): string {
  const u = new URL(path, `https://${CONNECTAPI_HOST}`);
  u.hash = "";
  const entries = [...u.searchParams.entries()].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : 1;
  });
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.append(k, v);
  u.search = sp.toString();
  return `${u.pathname}${u.search}`;
}

/** Filesystem-safe cache key for a `connectapi` path. */
export function cacheKey(path: string): string {
  const normalized = normalizePath(path);
  const safe = normalized
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

/** Persisted cache metadata for one response. */
export interface CacheEntry {
  key: string;
  path: string;
  url: string;
  status: number;
  ok: boolean;
  fetchedAt: string;
  contentType: string | null;
  size: number;
}

/** Read cache metadata, or null when absent. */
export async function loadEntry(
  dir: string,
  key: string,
): Promise<CacheEntry | null> {
  try {
    return JSON.parse(
      await Deno.readTextFile(`${dir}/${key}/meta.json`),
    ) as CacheEntry;
  } catch {
    return null;
  }
}

/** Read a cached body, or null when absent. */
export async function loadBody(
  dir: string,
  key: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(`${dir}/${key}/body`);
  } catch {
    return null;
  }
}

/**
 * Read a cached body by `connectapi` path.
 *
 * The read path domain models use: they know the path the transport fetched,
 * not the key, so this derives it. Returns null on a miss so a domain model can
 * report "not synced yet" rather than crashing.
 */
export async function readCachedByPath(
  cacheDir: string,
  path: string,
): Promise<{ body: string | null; entry: CacheEntry | null }> {
  const dir = expandHome(cacheDir);
  const key = cacheKey(path);
  const entry = await loadEntry(dir, key);
  if (!entry) return { body: null, entry: null };
  return { body: await loadBody(dir, key), entry };
}

/** Write a cache entry (metadata + body). */
export async function storeEntry(
  dir: string,
  entry: CacheEntry,
  body: string,
): Promise<void> {
  await Deno.mkdir(`${dir}/${entry.key}`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/${entry.key}/meta.json`,
    JSON.stringify(entry),
  );
  await Deno.writeTextFile(`${dir}/${entry.key}/body`, body);
}

/** Read the persisted last-request time (epoch ms), for cross-run pacing. */
export async function readLastRequestAt(dir: string): Promise<number> {
  try {
    const t = parseInt(await Deno.readTextFile(`${dir}/.last-request`), 10);
    return Number.isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

/** Persist the last-request time. */
export async function markRequestAt(dir: string): Promise<void> {
  try {
    await Deno.writeTextFile(`${dir}/.last-request`, String(Date.now()));
  } catch {
    // Best-effort pacing state.
  }
}

/** Sleep for `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when a cached entry is still within its freshness window. */
export function isFresh(
  entry: CacheEntry,
  maxAgeMs: number,
  nowMs: number,
): boolean {
  if (maxAgeMs <= 0) return true;
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched)) return true;
  return nowMs - fetched < maxAgeMs;
}
