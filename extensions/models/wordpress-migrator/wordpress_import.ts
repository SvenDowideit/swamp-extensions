/**
 * WordPress import — migrates posts from a WordPress site's REST API (WP JSON)
 * into Markdown files under a local directory (typically inside an Obsidian git
 * repo). One Markdown file per post, with YAML frontmatter (title, date, slug,
 * source URL, tags, categories) and the rendered post content converted to
 * Markdown. Downloaded images are saved alongside notes and rewritten as wiki-
 * style embeds so the vault/git history stays self-contained on first import.
 *
 * Posts are fetched from `siteUrl + "/wp-json/wp/v2/posts"`, paginated until no
 * more pages are returned (uses x-wp-totalpages header). Optional bearer-token
 * authentication is supported for password-protected or private posts via the
 * authToken global argument.
 */
import { z } from "npm:zod@4";
import { resolve as resolvePath, join as joinPath } from "jsr:@std/path@1";

const GlobalArgsSchema = z.object({
  siteUrl: z.string().describe("WordPress base URL (e.g. https://jig.tools)"),
  targetDir: z.string().describe(
    "Directory to write Markdown posts into (created if it does not exist)",
  ),
  authToken: z.string().optional().describe(
    "Optional WordPress REST API bearer token for password-protected/private content",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ImportArgsSchema = z.object({
  perPage: z.number().int().min(1).max(100).default(50).describe(
    "Posts per request page (WP REST API max is 100)",
  ),
  categoriesPerPage: z.number().int().min(1).max(100).default(100).describe(
    "Category lookup batch size",
  ),
  downloadImages: z.boolean().default(true).describe(
    "Download <img> and featured-image URLs into an assets folder and rewrite them as local links",
  ),
  imageFolder: z.string().default("assets").describe(
    "Subfolder (inside targetDir) for downloaded images",
  ),
}).describe("Arguments controlling the WordPress import run");

type ImportArgs = z.infer<typeof ImportArgsSchema>;

const PostResourceSchema = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  date: z.iso.datetime(),
  url: z.string().url(),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  excerpt: z.string().optional(),
}).strict();

const ImportResultSchema = z.object({
  siteUrl: z.string().url(),
  totalPosts: z.number().int().nonnegative(),
  notesWritten: z.number().int().nonnegative(),
  imagesDownloaded: z.number().int().nonnegative(),
  skipped: z.array(z.string()),
  errors: z.array(z.string()),
}).strict();

type WpTerm = { id: number; name: string; slug?: string };

/** Fetch a URL with optional bearer auth and retry, returning JSON. */
async function fetchJson(
  url: string,
  token: string | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let attempt = 0;
  for (;;) {
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      if (++attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Resolve all category IDs to names from the WP categories endpoint. */
async function fetchCategoryMap(
  siteUrl: string,
  token: string | undefined,
  perPage: number,
): Promise<Map<number, { name: string; slug?: string }>> {
  const map = new Map<number, { name: string; slug?: string }>();
  let page = 1;
  for (;;) {
    const url = `${siteUrl}/wp-json/wp/v2/categories?per_page=${perPage}&page=${page}`;
    let cats: WpTerm[];
    try {
      cats = await fetchJson(url, token) as unknown as WpTerm[];
    } catch (e) {
      if ((e as Error).message.includes("404")) break;
      throw e;
    }
    for (const c of cats) map.set(c.id, { name: c.name, slug: c.slug });
    const more = cats.length === perPage;
    if (!more || page > 100) break;
    page++;
  }
  return map;
}

/** Sanitize a string for use as (part of) a filename. */
// Sanitize a string for use as (part of) a filename. Exported so extension tests can cover it directly.
export function sanitize(name: string): string {
  return name
    .replace(/[\uE000-\uF8FF<>"\\\/:*?|]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 120) || "untitled";
}


/** Convert WP HTML post content into Markdown, returning body + image list. */
// Convert WP HTML post content into Markdown, returning body + image list. Exported for tests.
export function htmlToMarkdown(html: string): { markdown: string; images: string[] } {
  if (!html) return { markdown: "", images: [] };
  const images: string[] = [];

  // Pre-pass: collect every <img> src first so images nested in <p>/<a>/etc. are not lost
  // when block handlers below collapse wrappers into placeholders. Each image is replaced in
  // place with an index-tagged placeholder {{IMG:n}} that survives the markdown conversion.
  let pre = html.replace(
    /<img\s+([^>]*)>/giu,
    (m: string) => {
      const s = m.match(/src=["']([^"']+)["']/i);
      const src = s ? s[1].trim() : "";
      if (!src || src.startsWith("data:")) return "{{IMG}}";
      images.push(src);
      return `{{IMG:${images.length - 1}}}`;
    },
  );

  let md = pre
    .replace(/<!--\s*wp:[\s\S]*?-->/g, "") // strip Gutenberg block comments (<? wp:... ?>)
    .replace(/<!--[\s\S]*?-->/g, "") // strip any remaining HTML comments
    // Strip wp-block attributes that add noise; keep the tag.
    .replace(/\s+class="wp-element-embed[^"]*"/gi, "")
    .replace(
      /<h[1-6][^>]*>(.*?)<\/h[1-6]>/giu,
      (_m: string, inner: string) => `\n\n## ${inner.trim()}\n\n`,
    )
    .replace(/<p[^>]*>\s*(.*?)\s*<\/p>/giu, (_, i: string) => {
      const t = i.trim();
      if (!t) return "";
      // If the paragraph is just an image, defer to img replacement below.
      if (/^<img/.test(t)) return `\n\n{{IMG}}\n\n`;
      return `\n\n${t}\n\n`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/giu,
      (_m: string, href: string, inner: string) => `[${inner.trim()}](${sanitizeUrl(href)})`,
    )
    // Unordered lists.
    .replace(/(?:^|\n)<ul[^>]*>([\s\S]*?)<\/ul>/giu, (_, i: string) => {
      const items = i.replace(/<li[^>]*>(.*?)<\/li>/giu, "- $1\n").trim();
      return `\n${items}\n`;
    })
    // Ordered lists.
    .replace(/(?:^|\n)<ol[^>]*>([\s\S]*?)<\/ol>/giu, (_, i: string) => {
      let n = 0;
      const items = i.replace(/<li[^>]*>(.*?)<\/li>/giu, () => `${++n}. $1\n`).trim();
      return `\n${items}\n`;
    })
    .replace(
      /<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/giu,
      "**$1**",
    )
    .replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/giu, "*$1*")
    .replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/giu,
      (_, i: string) => i.split("\n").map((l: string) => `> ${l}`).join("\n"),
    )
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/giu, "```\n$1\n```")
    .replace(
      /<pre[^>]*>([\s\S]*?)<\/pre>/giu,
      () => `\`\`\`\n$1\n\`\`\``,
    )
    .replace(/<code[^>]*>(.*?)<\/code>/giu, "`$1`")
    // Images were pre-collected above; remaining {{IMG:n}} placeholders are resolved at the end.
    .replace(/<\/?[^>]+>/g, "") // drop any remaining tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&#[0-9]+;/gi, (m: string) => {
      const n = Number(m.slice(2, -1));
      return String.fromCharCode(n);
    })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;gt;/g, "&gt;")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Normalize image placeholders left over from the pre-pass: bare {{IMG}} (from dropped
  // data-URI images) become empty; indexed ones are returned as-is so callers can swap in
  // downloaded asset paths of the form `assets/<name>.{ext}`.
  md = md.replace(/\{\{IMG(?::(\d+))?\}\}/gu, (_m: string, idx?: string) => {
    if (!idx) return "";      // no downloadable file (e.g. data-URI) -> drop placeholder
    return `{{IMG:${Number(idx)}}}`;
  });

  const finalImages = images.slice();

  return { markdown: md, images: finalImages };
}

function sanitizeUrl(url: string): string {
  return url.replace(/\\\)/g, ")").replace(/^\s+/, "").replace(/\s+$/, "");
}

/** Decode named/numeric HTML entities in post titles/excerpts before YAML emission. */
// Decode named/numeric HTML entities in post titles/excerpts before YAML emission. Exported for tests.
export function decodeEntities(s: string): string {
  if (!s) return "";
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    nbsp: " ", hellip: "...", mdash: "-", ndash: "-", rdquo: '"', ldquo: '"',
    "#8217": "'", "#8216": "\u2019", "#8220": '"', "#8221": '"', // typographic quotes → straight/dumb
  };
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|ldquo|rdquo|#8217|#8216);/gi, (m, k) => named[k] ?? m).replace(
    /&#(\d+);/g,
    (_m: string, n: string) => String.fromCharCode(Number(n)),
  );
}

/** Download a single image, returning the local relative path used in markdown. */
async function downloadImage(
  imgUrl: string,
  pageSlug: string,
  index: number,
  destFolder: string,
): Promise<string | null> {
  const clean = imgUrl.split("?")[0];
  let ext = "jpg";
  const m = clean.match(/\.(png|jpe?g|gif|webp|avif)(?:\b|\?)/i);
  if (m) ext = m[1].replace("jpeg", "jpg");
  const fileName = `${sanitize(pageSlug)}-${index}.${ext}`;
  const outPath = joinPath(destFolder, fileName);
  try {
    const resp = await fetch(clean);
    if (!resp.ok) return null;
    const data = new Uint8Array(await resp.arrayBuffer());
    await Deno.writeFile(outPath, data);
    return `assets/${fileName}`;
  } catch {
    return null;
  }
}

/** Swamp model that imports WordPress posts from the REST API into Markdown files. */
export const model = {
  type: "@svendowideit/wordpress-import",
  version: "2026.07.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Import summary",
      schema: ImportResultSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    post: {
      description: "Individual imported post",
      schema: PostResourceSchema.strict(),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    import: {
      description:
        "Fetch all posts from the configured WordPress site via its REST API and write one Markdown file per post into targetDir",
      arguments: ImportArgsSchema,
      execute: async (args: ImportArgs, context: {
        globalArgs: GlobalArgs;
        logger?: { info(msg: string): void };
        writeResource: (
          specName: "post" | "result",
          name: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
      }) => {
        const log = context.logger?.info ?? (() => {});
        const { siteUrl, targetDir, authToken } = context.globalArgs;

        const base = resolvePath(Deno.cwd(), targetDir);
        await Deno.mkdir(base, { recursive: true });

        // Category lookup.
        const catMap = await fetchCategoryMap(siteUrl, authToken, args.categoriesPerPage);

        let page = 1;
        let totalPages = Infinity;
        let postsWritten = 0;
        let imagesDownloaded = 0;
        const skipped: string[] = [];
        const errors: string[] = [];

        log(`Importing from ${siteUrl} into ${base}`);

        // Count via first request to read x-wp-totalpages.
        const imageFolderAbs = joinPath(base, args.imageFolder);
        if (args.downloadImages) await Deno.mkdir(imageFolderAbs, { recursive: true });

        while (page <= totalPages && page <= 100) {
          let posts;
          try {
            // Fetch page to also discover pagination headers.
            const url = `${siteUrl}/wp-json/wp/v2/posts?per_page=${args.perPage}&page=${page}` +
              (authToken ? `&_embed` : "");
            const resp = await fetch(url, authToken ? {
              headers: { Authorization: `Bearer ${authToken}` },
            } : undefined);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const totalPagesHeader = resp.headers.get("x-wp-totalpages");
            if (totalPagesHeader) totalPages = parseInt(totalPagesHeader, 10);
            posts = await resp.json() as unknown[];
          } catch (e) {
            errors.push(`Page ${page} failed: ${(e as Error).message}`);
            break;
          }

          for (const post of posts as Array<{
            id: number; slug: string; date: string; link: string;
            title?: { rendered?: string }; content?: { rendered?: string };
            excerpt?: { rendered?: string }; categories?: number[]; tags?: number[];
          }>) {
            try {
              const postSlug = post.slug || `${post.id}`;
              const date = new Date(post.date).toISOString();
              if (!post.title?.rendered) skipped.push(`${post.id} (no title)`);

              // Resolve categories from map. If a category id is unknown, fall back to "Uncategorized".
              const postCats: string[] = [];
              for (const cid of post.categories || []) {
                const c = catMap.get(cid);
                if (c) {
                  const sl = sanitize(c.slug ?? "");
                  postCats.push(sl === "" ? c.name : `category/${sl}`);
                }
              }

              // Tags: jig.tools returns tags as IDs only — resolve via term taxonomy when present. If empty, omit.
              const postTags: string[] = [];
              for (const tid of post.tags || []) {
                const t = catMap.get(tid);
                if (t) {
                  const sl = sanitize(`tag-${t.slug ?? ""}`);
                  postTags.push(sl === "tag-" ? t.name : `tags/${sl.replace(/^tag-/, "")}`);
                }
              }

              // Build markdown body.
              let body: string;
              let images: string[];
              const html = post.content?.rendered ?? "";
              if (authToken) {
                ({ markdown: body, images } = htmlToMarkdown(html));
              } else {
                ({ markdown: body, images } = htmlToMarkdown(html));
              }

              // Download images and rewrite embeds to point at assets/.
              if (args.downloadImages && images.length > 0) {
                for (let i = 0; i < images.length; i++) {
                  const localPath = await downloadImage(images[i], postSlug, i, imageFolderAbs);
                  if (localPath) {
                    body = body.replace(`{{IMG:${i}}}`, `![${post.title?.rendered ?? ""}](${localPath})`);
                    imagesDownloaded++;
                  } else {
                    // leave as raw URL link on failure
                    const clean = images[i].split("?")[0];
                    body = body.split(`{{IMG:${i}}}`).join(
                      `![image](${clean})`,
                    );
                  }
                }
              }

              // Frontmatter YAML. Decode HTML entities first, then escape quotes/newlines for YAML.
              const rawTitle = decodeEntities(post.title?.rendered ?? postSlug);
              const safeTitle = rawTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                .replace(/\n/g, " ");
              const fm: string[] = [
                "---",
                `title: "${safeTitle}"`,
                `date: ${date}`,
                `slug: ${post.slug || ""} `,
                `source: wordpress`,
                `url: "${post.link}"`,
                `wp_id: ${post.id}`,
              ];
              if (postTags.length) {
                fm.push("tags:");
                for (const t of postTags) fm.push(`  - "${t.replace(/"/g, '\\"')}"`);
              } else {
                fm.push("tags:");
              }
              if (postCats.length) {
                fm.push("categories:");
                for (const c of postCats) fm.push(`  - ${c}`);
              }
              const excerpt = post.excerpt?.rendered ?? "";
               if (excerpt && excerpt.trim().length > 0) {
                // Strip WP's auto-appended "Continue reading" HTML anchor / more-link from the rendered excerpt.
                const strippedExcerpt = decodeEntities(excerpt).replace(
                  /<a[^>]*>\s*continue\s+reading[\s\S]*?<\/a>/gi, "",
                ).replace(/<span class="screen-reader-text">[\s\S]*<\/span>/gi, "");
                const cleanExcerpt = htmlToMarkdown(strippedExcerpt).markdown.replace(/\n{3,}/g, "\n\n").trim();
                fm.push(`excerpt: "${cleanExcerpt.replace(/"/g, '\\"').substring(0,500)}"`);
              }
              fm.push("---", "");

              const content = `${fm.join("\n")}\n${body}`;
              const fileName = `${date.split("T")[0]}-${sanitize(postSlug)}.md`;
              await Deno.writeTextFile(joinPath(base, fileName), content);
              postsWritten++;

              await context.writeResource(
                "post",
                post.slug || `wp-${post.id}`,
                {
                  id: post.id,
                  slug: post.slug || "",
                  title: post.title?.rendered ?? "",
                  date,
                  url: post.link,
                  tags: postTags,
                  categories: postCats,
                  excerpt: post.excerpt?.rendered ?? undefined,
                },
              );

              log(`Wrote ${fileName}`);
            } catch (e) {
              errors.push(`${post.id}: ${(e as Error).message}`);
            }
          }

          if (!posts || posts.length === 0) break;
          page++;
        }

        const handle = await context.writeResource("result", "main", {
          siteUrl,
          totalPosts: postsWritten + skipped.length + errors.length,
          notesWritten: postsWritten,
          imagesDownloaded,
          skipped,
          errors,
        });

        log(`Done — ${postsWritten} posts written; ${imagesDownloaded} images`);
        return { dataHandles: [handle] };
      },
    },
  },
};