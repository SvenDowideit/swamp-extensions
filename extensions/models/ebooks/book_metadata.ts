/**
 * Book metadata — detects and stores bibliographic information (author, title,
 * ISBN, publish dates, publisher, language, etc.) about a book from a file.
 *
 * Detection is best-effort and combines three signals:
 *   1. the file path / filename,
 *   2. filesystem metadata (size, mtime),
 *   3. file contents (epub OPF metadata, PDF info dictionary, ISBN/date regexes).
 *
 * The model is generic so it can also be used for physical books: point `detect`
 * at any file, or use `register` to store metadata you already have by hand.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { strFromU8, unzipSync } from "npm:fflate@0.8.3";
import { basename, dirname, isAbsolute, join, resolve } from "jsr:@std/path@1";

const MAX_READ_BYTES = 128 * 1024 * 1024;

/**
 * Bump this when the detection logic changes in a way that should re-derive
 * stored metadata. `detect-metadata` re-detects any entry whose stored
 * `parserVersion` is below this value.
 */
export const CURRENT_PARSER_VERSION = 3;

/**
 * Bump this when the Wikipedia resolution / classification logic changes in a
 * way that should re-analyse already-resolved names. `resolve-wikipedia`
 * re-resolves any entry whose stored `resolutionVersion` is below this value.
 */
export const CURRENT_RESOLUTION_VERSION = 2;

export const BookMetadataSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  isbn: z.string().nullable(),
  publishedAt: z.string().nullable(),
  editionPublishedAt: z.string().nullable(),
  publisher: z.string().nullable(),
  language: z.string().nullable(),
  description: z.string().nullable(),
  series: z.string().nullable(),
  format: z.string().nullable(),
  detected: z.boolean(),
  confidence: z.number().min(0).max(1),
  parserVersion: z.number().int().nonnegative().optional(),
  authors: z.array(z.string()).optional(),
  sourcePath: z.string(),
  sourceName: z.string(),
  bytes: z.number().nonnegative(),
  modifiedAt: z.string().nullable(),
});

export type BookMetadata = z.infer<typeof BookMetadataSchema>;

/** Resolution status of an author or book against Wikipedia/Wikidata. */
const ResolutionSchema = z.object({
  /** Normalized, canonical name (Wikipedia page title). */
  name: z.string(),
  /** Full Wikipedia URL (absent if not resolved). */
  url: z.string().nullable(),
  /** Short description from Wikidata, used to classify author vs book. */
  description: z.string().nullable(),
  /** "author" | "book" | "other" | "not-found". */
  kind: z.string(),
  /** Whether this was resolved (true) or determined to be unknown (false). */
  resolved: z.boolean(),
  /** Optional: original name we resolved from. */
  from: z.string().nullable(),
  /** ISO timestamp of the last resolution attempt. */
  resolvedAt: z.string(),
  /** Infobox template name detected from the wikitext (e.g. "writer", "book"). */
  infobox: z.string().nullable().optional(),
  /** Wikidata QID (e.g. "Q286116"), absent if the page has no Wikidata item. */
  wikidataId: z.string().nullable().optional(),
  /** Wikidata instance-of (P31) value QIDs, e.g. ["Q5"] for a person. */
  instanceOf: z.array(z.string()).optional(),
  /** Version of the resolution/classification logic that produced this record. */
  resolutionVersion: z.number().int().nonnegative().optional(),
});

export type Resolution = z.infer<typeof ResolutionSchema>;

/** Map of author name -> Wikipedia resolution. */
export const AuthorResolutionMapSchema = z.record(z.string(), ResolutionSchema);
export type AuthorResolutionMap = z.infer<typeof AuthorResolutionMapSchema>;

/** Map of book title -> Wikipedia resolution. */
export const BookResolutionMapSchema = z.record(z.string(), ResolutionSchema);
export type BookResolutionMap = z.infer<typeof BookResolutionMapSchema>;

const GlobalArgsSchema = z.object({}).strict();
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const DetectArgsSchema = z.object({
  file: z.string().describe("Path to the book file to detect metadata from"),
});
type DetectArgs = z.infer<typeof DetectArgsSchema>;

const RegisterArgsSchema = z.object({
  title: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  isbn: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  editionPublishedAt: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  series: z.string().nullable().optional(),
  sourcePath: z.string().default("").describe(
    "Link back to a source file/record",
  ),
  sourceName: z.string().default(""),
});
type RegisterArgs = z.infer<typeof RegisterArgsSchema>;

type MethodContext = {
  logger: { info: (m: string, p?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Expand `~` and relative paths to an absolute path. */
function absolutePath(raw: string): string {
  if (raw.startsWith("~")) {
    const home = Deno.env.get("HOME") ?? "~";
    return join(home, raw.slice(1).replace(/^[/\\]/, "") || "");
  }
  if (!isAbsolute(raw)) return resolve(raw);
  return raw;
}

/** Lowercased, dotless extension. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Strip extension and common junk from a filename to a candidate title. */
function stemName(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim();
}

/** Collapse whitespace and trim. */
function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t;
}

/** Strip trailing parenthetical format/version/omnibus markers from a title. */
function stripTitleJunk(title: string): string {
  let t = title;
  // Repeatedly remove trailing "(epub)", "(mobi)", "(v5.0)", "(Omnibus)" etc.
  const marker = new RegExp(
    "\\s*\\((?:epub|mobi|azw3?|kfx|pdf|fb2|lit|djvu|cbz|cbr|omnibus|anthology|" +
      "complete|v?\\d+(?:\\.\\d+)*|retail|web)[^)]*\\)\\s*$",
    "i",
  );
  let changed = true;
  while (changed) {
    changed = false;
    const next = t.replace(marker, "");
    if (next !== t) {
      t = next;
      changed = true;
    }
  }
  return t.trim();
}

/** Extract an ISBN (10 or 13) from a string, or null. */
function extractIsbn(text: string): string | null {
  // ISBN-13
  const m13 = text.match(/\b97[89][- ]?(?:\d[- ]?){9}\d\b/);
  if (m13) return m13[0].replace(/[- ]/g, "");
  // ISBN-10
  const m10 = text.match(/\b(?:\d[- ]?){9}[\dXx]\b/);
  if (m10) return m10[0].replace(/[- ]/g, "").toUpperCase();
  return null;
}

/** Extract a 4-digit year from a string, or null. */
function extractYear(text: string): string | null {
  const m = text.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  return m ? m[0] : null;
}

/** Normalize a DC date to ISO yyyy-mm-dd or the bare year. */
function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!m) return null;
  if (m[2] && m[3]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[2]) return `${m[1]}-${m[2]}`;
  return m[1];
}

/** Name particles that may be lowercase in a personal name. */
const NAME_PARTICLES = new Set([
  "von",
  "van",
  "de",
  "del",
  "der",
  "la",
  "le",
  "da",
  "di",
  "du",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
]);

/** Heuristic: does this token look like a person's name (not a title)? */
function looksLikeName(s: string): boolean {
  const t = s
    .replace(/[()[\]{}]/g, " ")
    .replace(/[&/_—–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  if (/\d/.test(t)) return false; // sort numbers / years / series numbers
  if (t.includes(",")) return true; // "Last, First" is unambiguous
  const words = t.split(" ");
  if (words.length < 2 || words.length > 4) return false;
  if (["the", "a", "an"].includes(words[0].toLowerCase())) return false;
  for (const w of words) {
    if (NAME_PARTICLES.has(w.toLowerCase())) continue;
    if (!/^[A-Z]/.test(w)) return false;
  }
  return true;
}

/** Does this token look like an author (or a list of authors)? */
function looksLikeAuthor(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.includes(",")) return true;
  if (/[&/]/.test(t)) return true;
  if (/\band\b|\bwith\b/i.test(t)) return true;
  return looksLikeName(t);
}

/** Is this token a series marker like "[Animorphs 42]", "(Galaxy 12)", "Vol 2"? */
function isSeriesToken(s: string): boolean {
  const t = s.trim();
  if (/^[\[(].+[\])]$/.test(t)) return true; // bracketed "[Anything NN]"
  if (/^.+?\s+\d{1,3}$/.test(t)) return true; // "Galaxy 12" / "Vol 2"
  return false;
}

/** Canonicalize an author name to one form: "First Last". */
function canonicalAuthorName(author: string): string {
  const a = author.replace(/\s+/g, " ").trim();
  if (!a) return a;
  // "Last, First" (or "Last, First, Suffix") -> "First ... Last"
  if (a.includes(",")) {
    const parts = a.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return [...parts.slice(1), parts[0]].join(" ");
    }
  }
  return a;
}

/**
 * Split a possibly multi-author string ("Robert Jordan & Brandon Sanderson",
 * "Gibson, William; Sterling, Bruce", "Joe Abercrombie and Steven Erikson")
 * into individually canonicalized author names.
 */
function splitAuthors(author: string | null): string[] {
  if (!author) return [];
  const a = author.replace(/\s+/g, " ").trim();
  if (!a) return [];
  // Split on "&", "and", " with ", "/", ";" between names.
  const parts = a
    .split(/\s*(?:&|;|\/)\s*|\s+(?:and|with)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((p) => canonicalAuthorName(p)).filter(Boolean);
}

/** Extract a leading "Series [NN] - Title" / "Series NN: Title" prefix. */
function splitSeries(title: string): { series: string | null; title: string } {
  const t = title.replace(/\s+/g, " ").trim();
  const m = t.match(
    /^(.+?)\s*[\[(]?\s*(\d{1,3})\s*[)\]]?\s*[-–—:]\s+(.+)$/,
  );
  if (m && !/^\d{4}$/.test(m[2])) {
    return { series: clean(m[1]), title: clean(m[3]) ?? t };
  }
  return { series: null, title: t };
}

/**
 * Parse a filename (extension removed) into title/author/year, handling the
 * common layouts:
 *   - "Author - Title (2001)"
 *   - "Title - Author"            (leading sort number / list style)
 *   - "YEAR - Author - Title"
 *   - "Title by Author"
 *   - "Lastname, Firstname - Title"
 *   - "12.01 Title - Author"
 */
function parseFilename(noExt: string): {
  title: string | null;
  author: string | null;
  year: string | null;
} {
  let s = noExt.replace(/[_—–]/g, " ").replace(/\s+/g, " ").trim();

  // Strip a trailing format token ("... EPUB", "... AZW3", "... MOBI") that
  // often leaks into the title when the extension was already split off.
  s = s.replace(
    /\s+(EPUB|MOBI|AZW|AZW3|KFX|PDF|FB2|LIT|DJVU|CBZ|CBR)\s*$/i,
    "",
  ).trim();

  // Leading year: "1985 - " (before stripping sort numbers, so a 4-digit year
  // isn't mistaken for one).
  let year: string | null = extractYear(s);
  const ym = s.match(/^(1[6-9]\d{2}|20\d{2})\s*[-–—]\s*/);
  if (ym) {
    year = ym[1];
    s = s.slice(ym[0].length).trim();
  }

  // Leading sort number: "12.01 " / "12.01_". Requires a dot so it can't
  // swallow a bare number like a year or series index.
  s = s.replace(/^\d+\.\d+\s*[-–—]?\s*/, "");

  // "Title by Author"
  const by = s.split(/\s+by\s+/i);
  if (by.length >= 2) {
    const { title } = splitSeries(clean(by[0]) ?? "");
    return {
      title,
      author: canonicalAuthorName(clean(by.slice(1).join(" by ")) ?? ""),
      year,
    };
  }

  // "Title (by Author)" — parenthesised credit, e.g.
  // "Star Wars - [Galaxy 12] - Priority X (by George R Strayton)".
  const parenBy = s.match(/\s*\(by\s+([^)]+)\)\s*$/i);
  if (parenBy) {
    const rest = s.slice(0, parenBy.index).trim();
    const { title } = splitSeries(rest);
    return {
      title,
      author: canonicalAuthorName(clean(parenBy[1]) ?? ""),
      year,
    };
  }

  const parts = s.split(/\s+[-–—]\s+/).map((p) => clean(p)).filter(Boolean);
  if (parts.length === 0) {
    return { title: null, author: null, year };
  }
  if (parts.length === 1) {
    const { title } = splitSeries(parts[0] ?? "");
    return { title, author: null, year };
  }

  // "Last, First - Title" (comma author at front) or "Title - Last, First".
  const firstComma = parts[0]!.includes(",");
  const lastComma = parts[parts.length - 1]!.includes(",");
  if (firstComma && !lastComma) {
    const { title } = splitSeries(parts.slice(1).join(" - "));
    return { title, author: canonicalAuthorName(parts[0]!), year };
  }
  if (lastComma && !firstComma) {
    const { title } = splitSeries(parts.slice(0, -1).join(" - "));
    return {
      title,
      author: canonicalAuthorName(parts[parts.length - 1]!),
      year,
    };
  }

  const firstIsAuthor = looksLikeAuthor(parts[0]!);
  const lastIsAuthor = looksLikeAuthor(parts[parts.length - 1]!);
  const firstIsSeries = isSeriesToken(parts[0]!);

  // Series token first ("[Animorphs 42] - The Journey") — no author in the name.
  if (firstIsSeries) {
    const { title } = splitSeries(parts.join(" - "));
    return { title, author: null, year };
  }

  // Title-first (author at the end) — "A Memory of Light - Robert Jordan & ...".
  if (lastIsAuthor && !firstIsAuthor) {
    const { title } = splitSeries(parts.slice(0, -1).join(" - "));
    return {
      title,
      author: canonicalAuthorName(parts[parts.length - 1]!),
      year,
    };
  }
  // Author-first (default).
  const { title } = splitSeries(parts.slice(1).join(" - "));
  return { title, author: canonicalAuthorName(parts[0]!), year };
}

/** Parse an epub's OPF metadata (dc:title, dc:creator, identifiers, dates…). */
function parseEpub(bytes: Uint8Array): Record<string, string | null> {
  const out: Record<string, string | null> = {
    title: null,
    author: null,
    isbn: null,
    publishedAt: null,
    publisher: null,
    language: null,
    description: null,
  };
  try {
    const zip = unzipSync(bytes);
    // Locate OPF path via container.xml
    let opfPath: string | null = null;
    const container = zip["META-INF/container.xml"];
    if (container) {
      const xml = strFromU8(container);
      const m = xml.match(/full-path="([^"]+)"/);
      if (m) opfPath = m[1];
    }
    if (!opfPath) {
      // Fall back to the first *.opf
      opfPath = Object.keys(zip).find((k) =>
        k.toLowerCase().endsWith(".opf")
      ) ??
        null;
    }
    if (!opfPath) return out;

    const opfRaw = zip[opfPath];
    if (!opfRaw) return out;
    const opf = strFromU8(opfRaw);

    const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    if (title) out.title = clean(title[1].replace(/<[^>]+>/g, ""));

    const creator = opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
    if (creator) out.author = clean(creator[1].replace(/<[^>]+>/g, ""));

    const publisher = opf.match(
      /<dc:publisher[^>]*>([\s\S]*?)<\/dc:publisher>/i,
    );
    if (publisher) out.publisher = clean(publisher[1].replace(/<[^>]+>/g, ""));

    const language = opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i);
    if (language) out.language = clean(language[1]);

    const description = opf.match(
      /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i,
    );
    if (description) {
      out.description = clean(description[1].replace(/<[^>]+>/g, ""));
    }

    const date = opf.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i);
    if (date) out.publishedAt = normalizeDate(date[1]);

    // Identifiers — prefer an ISBN-scheme identifier
    const ids = [
      ...opf.matchAll(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/gi),
    ];
    for (const idm of ids) {
      const rawId = idm[1].replace(/<[^>]+>/g, "").trim();
      const tag = idm[0];
      const isbn = extractIsbn(rawId);
      if (isbn) {
        out.isbn = isbn;
        break;
      }
      if (/opf:scheme=["']ISBN["']/i.test(tag)) {
        out.isbn = rawId.replace(/[- ]/g, "");
      }
    }
  } catch {
    // Non-zip or malformed epub — leave fields null.
  }
  return out;
}

/** Extract PDF info-dictionary metadata via regex. */
function parsePdf(bytes: Uint8Array): Record<string, string | null> {
  const out: Record<string, string | null> = {
    title: null,
    author: null,
    isbn: null,
    publishedAt: null,
    publisher: null,
  };
  // Only scan the first ~4 MiB where the info dict usually lives.
  const head = strFromU8(
    bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)),
  );

  const title = head.match(/\/Title\s*\(([^)]*)\)/);
  if (title) out.title = clean(title[1]);

  const author = head.match(/\/Author\s*\(([^)]*)\)/);
  if (author) out.author = clean(author[1]);

  const creation = head.match(/\/CreationDate\s*\(D:(\d{4})/);
  if (creation) out.publishedAt = creation[1];

  out.isbn = extractIsbn(head);
  return out;
}

/** Generate a stable id: ISBN if present, else a slug of author+title, else path. */
function buildId(
  isbn: string | null,
  author: string | null,
  title: string | null,
  sourcePath: string,
): string {
  if (isbn) return `isbn:${isbn}`;
  const slug = clean(`${author ?? ""} ${title ?? ""}`)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug) return `book:${slug}`;
  return `file:${basename(sourcePath)}`;
}

/**
 * Detect book metadata from a file, combining filename, filesystem metadata and
 * (where parseable) file contents.
 */
export async function detectBookMetadata(
  filePath: string,
): Promise<BookMetadata> {
  const path = absolutePath(filePath);
  const name = basename(path);
  const format = fileExtension(name) || null;

  let bytes = 0;
  let modifiedAt: string | null = null;
  try {
    const st = await Deno.stat(path);
    bytes = st.size ?? 0;
    modifiedAt = st.mtime ? new Date(st.mtime).toISOString() : null;
  } catch {
    // File missing — still produce a record keyed by path, but undetected.
  }

  const noExt = stemName(name);
  const fn = parseFilename(noExt);
  const isbnFromName = extractIsbn(name);

  let contents: Record<string, string | null> = {
    title: null,
    author: null,
    isbn: null,
    publishedAt: null,
    publisher: null,
    language: null,
    description: null,
  };
  if (format === "epub" && bytes <= MAX_READ_BYTES) {
    try {
      contents = { ...contents, ...parseEpub(await Deno.readFile(path)) };
    } catch {
      // ignore
    }
  } else if (format === "pdf" && bytes <= MAX_READ_BYTES) {
    try {
      contents = { ...contents, ...parsePdf(await Deno.readFile(path)) };
    } catch {
      // ignore
    }
  }

  const rawTitle = clean(contents.title) ?? fn.title;
  const title = rawTitle ? stripTitleJunk(rawTitle) || rawTitle : rawTitle;
  // Canonicalize the author name to one form so the same author groups together
  // regardless of "Last, First" vs "First Last" spelling.
  let author = clean(contents.author) ?? fn.author;

  // Fallback: if the filename yields no author, walk up ancestor directory
  // names looking for one that is a plausible personal name (e.g.
  // ".../books/K. A. Applegate/[Animorphs 01] - The Journey/file.pdf").
  // Skip directories that are themselves series tokens.
  if (!author) {
    let dir = dirname(path);
    const stops = new Set(["", "/", ".", "books", "Books", "Unknown"]);
    for (let i = 0; i < 6 && dir && !stops.has(dir); i++) {
      const dirName = basename(dir);
      if (dirName && !isSeriesToken(dirName) && looksLikeName(dirName)) {
        author = canonicalAuthorName(dirName);
        break;
      }
      dir = dirname(dir);
    }
  }

  const authors = splitAuthors(author);
  const authorCanonical = authors.join(" & ") || null;
  const isbn = clean(contents.isbn) ?? isbnFromName;
  const publishedAt = clean(contents.publishedAt) ??
    (fn.year ? fn.year : null);
  const publisher = clean(contents.publisher);
  const language = clean(contents.language);
  const description = clean(contents.description);

  // Edition date: prefer a distinct year in the filename when it differs from
  // the initial publication year; otherwise fall back to the publish date.
  const editionPublishedAt =
    (fn.year && publishedAt && fn.year !== extractYear(publishedAt))
      ? fn.year
      : publishedAt;

  let confidence = 0;
  if (title) confidence += 0.3;
  if (authorCanonical) confidence += 0.3;
  if (isbn) confidence += 0.25;
  if (publishedAt) confidence += 0.15;
  if (confidence < 0.1 && title) confidence = 0.1;

  const detected = !!(title || authorCanonical || isbn || publishedAt);

  return {
    id: buildId(isbn, authorCanonical, title, path),
    title,
    author: authorCanonical,
    authors,
    isbn,
    publishedAt,
    editionPublishedAt,
    publisher,
    language,
    description,
    series: null,
    format,
    detected,
    confidence: Math.round(confidence * 100) / 100,
    parserVersion: CURRENT_PARSER_VERSION,
    sourcePath: path,
    sourceName: name,
    bytes,
    modifiedAt,
  };
}

// ---------------------------------------------------------------------------
// Wikipedia resolution
// ---------------------------------------------------------------------------

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

/** Build the opensearch URL for a name. */
export function wikipediaSearchUrl(query: string, limit = 5): string {
  const params = new URLSearchParams({
    action: "opensearch",
    search: query,
    limit: String(limit),
    format: "json",
    origin: "*",
  });
  return `${WIKI_API}?${params}`;
}

/** Build the batched pageprops query URL for candidate titles. */
export function wikipediaQueryUrl(titles: string[]): string {
  const params = new URLSearchParams({
    action: "query",
    redirects: "1",
    prop: "info|pageprops",
    titles: titles.join("|"),
    inprop: "url",
    format: "json",
    origin: "*",
  });
  return `${WIKI_API}?${params}`;
}

/** Build the wikitext parse URL for a page title. */
export function wikipediaWikitextUrl(title: string): string {
  const params = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "wikitext",
    formatversion: "2",
    format: "json",
    origin: "*",
  });
  return `${WIKI_API}?${params}`;
}

/** Build the wbgetentities URL for a QID. */
export function wikidataEntityUrl(qid: string): string {
  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: qid,
    props: "claims|descriptions|labels",
    format: "json",
    origin: "*",
  });
  return `${WIKIDATA_API}?${params}`;
}

// --- shared cache key scheme (must match @svendowideit/web-cache exactly) ---

/** Deterministic 32-bit hash (FNV-1a), identical to web-cache's fnv1a. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Canonicalize a URL, identical to web-cache's normalizeUrl. */
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

/** URL-only cache key, identical to web-cache's webCacheKey. */
export function webCacheKey(url: string): string {
  const normalized = normalizeUrl(url);
  const safe = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe}-${fnv1a(normalized)}`;
}

/** Read a cached body for a URL from the shared cache dir (read-only). */
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

/**
 * Extract the raw wikitext string from a cached `action=parse&prop=wikitext`
 * response body (handles both formatversion=1 `{"*": ...}` and formatversion=2
 * plain-string shapes).
 */
export function parseWikitext(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      parse?: { wikitext?: string | { "*"?: string } };
    };
    const wt = parsed.parse?.wikitext;
    if (typeof wt === "string") return wt;
    if (wt && typeof wt === "object" && typeof wt["*"] === "string") {
      return wt["*"];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the instance-of (P31) value QIDs from a cached `wbgetentities`
 * response body for a given QID. Returns an empty array when absent/malformed.
 */
export function parseInstanceOf(body: string | null, qid: string): string[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as {
      entities?: Record<string, {
        claims?: Record<string, unknown[]>;
      }>;
    };
    const claims = parsed.entities?.[qid]?.claims?.["P31"] ?? [];
    const out: string[] = [];
    for (const claim of claims) {
      const mainsnak = (claim as Record<string, unknown>)["mainsnak"] as
        | { datavalue?: { value?: { id?: string } } }
        | undefined;
      const id = mainsnak?.datavalue?.value?.id;
      if (id) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

interface WikiPage {
  title: string;
  ns: number;
  index?: number;
  fullurl?: string;
  canonicalurl?: string;
  pageid?: number;
  pageprops?: { "wikibase-shortdesc"?: string; "wikibase_item"?: string };
  missing?: boolean;
}

/**
 * Map an infobox template name to a coarse kind. These are the common
 * people-creative infoboxes (see
 * https://en.wikipedia.org/wiki/Wikipedia:List_of_infoboxes). Anything not
 * listed here contributes no signal.
 */
const AUTHOR_INFOBOXES = new Set([
  "infobox writer",
  "infobox author",
  "infobox novelist",
  "infobox person",
  "infobox poet",
  "infobox artist",
  "infobox comics creator",
  "infobox comedian",
  "infobox journalist",
  "infobox officeholder",
  "infobox scientist",
  "infobox philosopher",
  "infobox academic",
  "infobox military person",
  "infobox musician",
]);

const BOOK_INFOBOXES = new Set([
  "infobox book",
  "infobox short story",
  "infobox novel",
  "infobox comic book title",
  "infobox graphic novel",
  "infobox play",
  "infobox television episode",
  "infobox film",
  "infobox video game",
  "infobox song",
  "infobox album",
  "infobox musical composition",
]);

/**
 * Extract the (first) infobox template name from raw wikitext. Handles the
 * common spellings: `{{Infobox writer`, `{{Infobox writer|`, and the
 * capitalized `{{Infobox Writer` form (case-insensitive on the template name).
 */
export function detectInfobox(wikitext: string | null): string | null {
  if (!wikitext) return null;
  const m = wikitext.match(/\{\{\s*([Ii]nfobox[ _][A-Za-z _-]+)/);
  if (!m) return null;
  return m[1].replace(/_/g, " ").trim().toLowerCase();
}

/**
 * Classify a page as author / book / other from its short description alone.
 * (Used during candidate selection, before the wikitext/wikidata signals are
 * available. The full classification happens later in `classifyResolved`.)
 */
function classifyKind(description: string | undefined): string {
  if (!description) return "other";
  const d = description.toLowerCase();
  if (
    /\b(author|writer|novelist|poet|artist|journalist|editor)\b/.test(d)
  ) {
    return "author";
  }
  if (
    /\b(novel|book|series|short story|trilogy|play|comic)\b/.test(d)
  ) {
    return "book";
  }
  return "other";
}

/** QIDs commonly used as instance-of (P31) for people vs. creative works. */
const AUTHOR_INSTANCE_QIDS = new Set([
  "Q5", // human
]);

const BOOK_INSTANCE_QIDS = new Set([
  "Q7725634", // literary work
  "Q47461344", // written work
  "Q571", // book
  "Q8261", // novel
  "Q49084", // short story
  "Q7318358", // book series
  "Q277759", // book series (series of creative works)
]);

/**
 * Parse a cached opensearch response body into candidate titles/urls. Returns
 * null when the body is absent or malformed.
 */
export function parseOpenSearch(body: string | null): {
  titles: string[];
  urls: string[];
} | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as [string, string[], string[], string[]];
    const titles = (parsed[1] ?? []).filter((t) => t && t.trim().length > 0);
    const urls = parsed[3] ?? [];
    return { titles, urls };
  } catch {
    return null;
  }
}

/**
 * Parse a cached `query` (pageprops) response body into a map of candidate
 * page title -> { url, shortdesc, wikidataId }.
 */
export function parsePageProps(body: string | null): Record<
  string,
  { url: string | null; shortdesc: string | null; wikidataId: string | null }
> {
  const out: Record<
    string,
    { url: string | null; shortdesc: string | null; wikidataId: string | null }
  > = {};
  if (!body) return out;
  try {
    const parsed = JSON.parse(body) as {
      query?: {
        pages?: Record<string, WikiPage>;
        redirects?: { from: string; to: string }[];
      };
    };
    const redirects = new Map(
      (parsed.query?.redirects ?? []).map((r) => [r.from, r.to]),
    );
    for (const page of Object.values(parsed.query?.pages ?? {})) {
      const title = redirects.get(page.title) ?? page.title;
      out[title] = {
        url: page.canonicalurl ?? page.fullurl ?? null,
        shortdesc: page.pageprops?.["wikibase-shortdesc"] ?? null,
        wikidataId: page.pageprops?.["wikibase_item"] ?? null,
      };
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Choose the best candidate for a name given its opensearch results and its
 * pageprops. Prefers a candidate whose infobox-free short-description matches
 * the expected kind; falls back to the first candidate. Returns the chosen
 * title/url/description/wikidataId, or null when there are no candidates.
 */
export function chooseCandidate(
  name: string,
  expectKind: "author" | "book",
  os: { titles: string[]; urls: string[] } | null,
  pageProps: Record<
    string,
    { url: string | null; shortdesc: string | null; wikidataId: string | null }
  >,
): {
  name: string;
  title: string;
  url: string | null;
  description: string | null;
  wikidataId: string | null;
} | null {
  if (!os || os.titles.length === 0) return null;

  const candidates = os.titles.map((title, i) => ({
    title,
    url: pageProps[title]?.url ?? os.urls[i] ?? null,
    shortdesc: pageProps[title]?.shortdesc ?? null,
    wikidataId: pageProps[title]?.wikidataId ?? null,
  }));

  let chosen = candidates[0]!;
  for (const c of candidates) {
    const k = classifyKind(c.shortdesc ?? undefined);
    if (expectKind === "author" && k === "author") {
      chosen = c;
      break;
    }
    if (expectKind === "book" && k === "book") {
      chosen = c;
      break;
    }
  }

  return {
    name,
    title: chosen.title,
    url: chosen.url,
    description: chosen.shortdesc,
    wikidataId: chosen.wikidataId,
  };
}

/**
 * Classify a name using the decisions specific to the ebooks extension: the
 * Wikipedia infobox template name and the Wikidata instance-of (P31) values.
 * This keeps ebook-specific classification here (tweakable without touching
 * the generalised wikipedia/wikidata models) while the *fetching* of those two
 * signals is delegated to the web-cache + wikipedia/wikidata models.
 */
export function classifyResolved(
  infobox: string | null,
  instanceOf: string[] | null,
): "author" | "book" | "other" {
  if (infobox) {
    if (AUTHOR_INFOBOXES.has(infobox)) return "author";
    if (BOOK_INFOBOXES.has(infobox)) return "book";
  }
  if (instanceOf) {
    for (const qid of instanceOf) {
      if (AUTHOR_INSTANCE_QIDS.has(qid)) return "author";
      if (BOOK_INSTANCE_QIDS.has(qid)) return "book";
    }
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Generic book-metadata model, reusable for ebooks and physical books. */
export const model = {
  type: "@svendowideit/book-metadata",
  version: "2026.09.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    book: {
      description: "Detected or registered bibliographic metadata for a book",
      schema: BookMetadataSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    detect: {
      description:
        "Detect book metadata from a file (path/filename, file metadata, " +
        "and contents) and store a book record keyed by ISBN (or slug).",
      arguments: DetectArgsSchema,
      execute: async (
        args: DetectArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const md = await detectBookMetadata(args.file);
        const handle = await context.writeResource("book", md.id, md);
        context.logger.info(
          "Detected {title} by {author} ({confidence})",
          {
            title: md.title ?? "(untitled)",
            author: md.author ?? "(unknown)",
            confidence: md.confidence,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    register: {
      description:
        "Store bibliographic metadata you already have (e.g. for a physical book).",
      arguments: RegisterArgsSchema,
      execute: async (
        args: RegisterArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const title = clean(args.title ?? null);
        const author = clean(args.author ?? null);
        const isbn = clean(args.isbn ?? null);
        const id = buildId(isbn, author, title, args.sourcePath || "manual");

        const md: BookMetadata = {
          id,
          title,
          author,
          isbn,
          publishedAt: clean(args.publishedAt ?? null),
          editionPublishedAt: clean(args.editionPublishedAt ?? null),
          publisher: clean(args.publisher ?? null),
          language: clean(args.language ?? null),
          description: clean(args.description ?? null),
          series: clean(args.series ?? null),
          format: null,
          detected: !!(title || author || isbn),
          confidence: 1,
          parserVersion: CURRENT_PARSER_VERSION,
          authors: splitAuthors(author),
          sourcePath: args.sourcePath,
          sourceName: args.sourceName || args.sourcePath,
          bytes: 0,
          modifiedAt: null,
        };

        const handle = await context.writeResource("book", id, md);
        context.logger.info("Registered book {id}", { id });
        return { dataHandles: [handle] };
      },
    },
  },
};
