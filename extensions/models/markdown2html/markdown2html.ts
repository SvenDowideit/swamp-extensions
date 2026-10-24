import { z } from "npm:zod@4";
import { marked } from "npm:marked@14";
import { basename, join, relative } from "node:path";

const GlobalArgsSchema = z.object({
  sourceDir: z.string().min(1).describe("Directory containing Markdown files"),
  outputDir: z.string().min(1).describe("Directory where the site is written"),
  siteTitle: z.string().min(1).max(200).default("Notes").describe("Site title"),
  templatePath: z.string().min(1).optional().describe(
    "Optional HTML template using {{title}}, {{body}}, {{date}}, {{slug}}, and {{excerpt}}",
  ),
  recursive: z.boolean().default(true).describe("Scan subdirectories"),
});

type PageMeta = {
  title: string;
  date: string;
  slug: string;
  excerpt: string;
  sourcePath: string;
  outputPath: string;
  html: string;
};

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger?: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

const ResultSchema = z.object({
  sourceDir: z.string(),
  outputDir: z.string(),
  generatedAt: z.string(),
  pageCount: z.number(),
  pages: z.array(z.object({
    title: z.string(),
    slug: z.string(),
    date: z.string(),
    excerpt: z.string(),
    outputPath: z.string(),
  })),
});

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "page";
}

function parseFrontmatter(
  text: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    if (!key) continue;
    frontmatter[key] = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: match[2] };
}

function stringArg(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return "";
}

function firstParagraph(value: string): string {
  return value.split(/\n\s*\n/).map((part) => part.trim())
    .find((part) =>
      part.length > 0 && !/^#{1,6}\s/.test(part) && !/^```/.test(part)
    ) || "";
}

async function walkMarkdown(
  root: string,
  recursive: boolean,
): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory && recursive) {
      found.push(...await walkMarkdown(path, recursive));
    } else if (
      entry.isFile &&
      (entry.name.endsWith(".md") || entry.name.endsWith(".markdown"))
    ) {
      found.push(path);
    }
  }
  return found.sort();
}

async function readTemplate(
  path: string | undefined,
  fallback: string,
): Promise<string> {
  if (!path) return fallback;
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function toRssDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toUTCString();
}

const PAGE_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<link rel="alternate" type="application/rss+xml" href="rss.xml" title="{{siteTitle}}">
<style>
body { font-family: system-ui, sans-serif; line-height: 1.7; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
h1, h2, h3 { line-height: 1.25; }
pre { overflow-x: auto; background: #f4f4f4; padding: 1rem; }
code { background: #f4f4f4; padding: .15rem .3rem; border-radius: 3px; }
.meta { color: #555; font-size: .9rem; }
</style>
</head>
<body>
<article>
<h1>{{title}}</h1>
<p class="meta">{{date}}</p>
{{body}}
</article>
</body>
</html>`;

function applyTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, key: string) => {
      const value = values[key] ?? "";
      return key === "body" ? value : escapeHtml(value);
    },
  );
}

async function renderPages(context: MethodContext): Promise<PageMeta[]> {
  const g = context.globalArgs;
  const sourceDir = g.sourceDir;
  const outputDir = g.outputDir;
  const template = await readTemplate(g.templatePath, PAGE_TEMPLATE);
  await Deno.mkdir(outputDir, { recursive: true });

  const files = await walkMarkdown(sourceDir, g.recursive);
  const pages: PageMeta[] = [];
  const usedSlugs = new Set<string>();

  for (const sourcePath of files) {
    const raw = await Deno.readTextFile(sourcePath);
    const { frontmatter, body } = parseFrontmatter(raw);
    const title = stringArg(frontmatter.title) ||
      body.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      basename(sourcePath, ".md").replaceAll("-", " ");
    const date = stringArg(frontmatter.date);
    const excerpt = stringArg(frontmatter.excerpt) ||
      firstParagraph(body).slice(0, 240);
    let slug = stringArg(frontmatter.slug) ||
      slugify(basename(sourcePath).replace(/\.(md|markdown)$/i, ""));
    if (usedSlugs.has(slug)) {
      let counter = 2;
      while (usedSlugs.has(`${slug}-${counter}`)) counter += 1;
      slug = `${slug}-${counter}`;
    }
    usedSlugs.add(slug);

    const htmlBody = String(marked.parse(body));
    const html = applyTemplate(template, {
      title,
      date,
      slug,
      excerpt,
      body: htmlBody,
      siteTitle: g.siteTitle,
    });
    const outputPath = join(outputDir, `${slug}.html`);
    await Deno.writeTextFile(outputPath, html);
    pages.push({ title, date, slug, excerpt, sourcePath, outputPath, html });
  }

  pages.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.title.localeCompare(b.title);
  });

  const indexItems = pages.map((page) => {
    const rel = relative(outputDir, page.outputPath);
    return `<li><a href="${escapeHtml(rel)}">${escapeHtml(page.title)}</a>${
      page.date ? ` <span class="meta">${escapeHtml(page.date)}</span>` : ""
    }${page.excerpt ? `<p>${escapeHtml(page.excerpt)}</p>` : ""}</li>`;
  }).join("\n");

  const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(g.siteTitle)}</title>
<style>
body { font-family: system-ui, sans-serif; line-height: 1.7; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
h1 { line-height: 1.25; }
ul { padding-left: 1.25rem; }
.meta { color: #555; font-size: .9rem; }
p { margin: .35rem 0 1.1rem; }
</style>
<link rel="alternate" type="application/rss+xml" href="rss.xml" title="${
    escapeHtml(g.siteTitle)
  }">
</head>
<body>
<h1>${escapeHtml(g.siteTitle)}</h1>
<ul>
${indexItems}
</ul>
</body>
</html>`;
  await Deno.writeTextFile(join(outputDir, "index.html"), indexHtml);

  const rssItems = pages.map((page) => {
    const rel = relative(outputDir, page.outputPath);
    const pubDate = toRssDate(page.date);
    return `<item>
<title>${escapeHtml(page.title)}</title>
<link>${escapeHtml(rel)}</link>
<guid isPermaLink="true">${escapeHtml(rel)}</guid>${
      pubDate
        ? `
<pubDate>${escapeHtml(pubDate)}</pubDate>`
        : ""
    }
<description>${escapeHtml(page.excerpt)}</description>
</item>`;
  }).join("\n");

  const lastBuildDate = new Date().toUTCString();
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escapeHtml(g.siteTitle)}</title>
<link>index.html</link>
<description>${escapeHtml(g.siteTitle)}</description>
<lastBuildDate>${escapeHtml(lastBuildDate)}</lastBuildDate>
${rssItems}
</channel>
</rss>`;
  await Deno.writeTextFile(join(outputDir, "rss.xml"), rssXml);

  return pages;
}

export const model = {
  type: "@svendowideit/markdown2html",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Result of rendering Markdown files to an HTML site",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    generate: {
      description:
        "Render all Markdown files in sourceDir to HTML in outputDir and create index.html",
      arguments: z.object({
        sourceDir: z.string().optional().describe("Override source directory"),
        outputDir: z.string().optional().describe("Override output directory"),
        siteTitle: z.string().optional().describe("Override site title"),
        templatePath: z.string().optional().describe("Override template path"),
        recursive: z.boolean().optional().describe("Override recursive scan"),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const resolved = {
          sourceDir: typeof args.sourceDir === "string"
            ? args.sourceDir
            : g.sourceDir,
          outputDir: typeof args.outputDir === "string"
            ? args.outputDir
            : g.outputDir,
          siteTitle: typeof args.siteTitle === "string"
            ? args.siteTitle
            : g.siteTitle,
          templatePath: typeof args.templatePath === "string"
            ? args.templatePath
            : g.templatePath,
          recursive: typeof args.recursive === "boolean"
            ? args.recursive
            : g.recursive,
        };
        const save = (context as MethodContext).writeResource;
        // Reassign global fields through a shallow context copy.
        const innerContext = Object.assign({}, context, {
          globalArgs: resolved,
        });
        const pages = await renderPages(innerContext as MethodContext);
        const handle = await save("result", "site", {
          sourceDir: resolved.sourceDir,
          outputDir: resolved.outputDir,
          generatedAt: new Date().toISOString(),
          pageCount: pages.length,
          pages: pages.map((page) => ({
            title: page.title,
            slug: page.slug,
            date: page.date,
            excerpt: page.excerpt,
            outputPath: page.outputPath,
          })),
        });
        context.logger?.info("Generated {count} pages in {outputDir}", {
          count: pages.length,
          outputDir: resolved.outputDir,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
