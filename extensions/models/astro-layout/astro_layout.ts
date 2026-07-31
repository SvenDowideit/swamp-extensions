/**
 * Astro Layout — generates an Astro static site layout from markdown files.
 */
import { z } from "npm:zod@4";
import {
  basename as basenamePath,
  extname as extnamePath,
  join as joinPath,
  resolve as resolvePath,
} from "jsr:@std/path@1";

const GlobalArgsSchema = z.object({
  siteUrl: z.string().describe("Base URL for the Astro site"),
  sourceDir: z.string().describe("Directory containing markdown files"),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const GenerateArgsSchema = z.object({
  outputDir: z.string()
    .default("./astro-site")
    .describe("Output directory for the generated Astro project"),
  includeDynamicComponents: z.boolean()
    .default(true)
    .describe(
      "Generate placeholder comments for dynamic component islands",
    ),
  layoutDir: z.string()
    .optional()
    .describe(
      "Path to a cloned site directory — reuse its Layout.astro chrome (header, footer, sidebar) for markdown pages",
    ),
}).describe("Arguments for the generate method");

type GenerateArgs = z.infer<typeof GenerateArgsSchema>;

const GeneratedPageSchema = z.object({
  slug: z.string(),
  title: z.string(),
  sourceFile: z.string(),
  hasDynamicComponents: z.boolean(),
  dynamicComponentKeys: z.array(z.string()),
});

const GenerateResultSchema = z.object({
  siteUrl: z.string().url(),
  totalPages: z.number().int().nonnegative(),
  pagesGenerated: z.number().int().nonnegative(),
  skippedFiles: z.array(z.string()),
  errors: z.array(z.object({ file: z.string(), error: z.string() })),
});

const ClonedSiteSchema = z.object({
  sourceUrl: z.string().url(),
  outputDir: z.string(),
  title: z.string(),
  matchedColors: z.array(z.string()),
  fontsLinked: z.array(z.string()),
  componentsGenerated: z.array(z.string()),
  regionsSynthesized: z.array(z.object({
    tag: z.string(),
    id: z.string().optional(),
    cls: z.string(),
  })),
});

const AstroIslandPattern = /\$([A-Za-z_][\w$]*)\$/g;

/** Frontmatter fields extracted from markdown files. */
export interface ParsedFrontmatter {
  title?: string;
  date?: string;
  slug?: string;
  draft?: boolean;
  tags?: string[];
  category?: string;
}

/** Metadata for a generated markdown page. */
export interface MarkdownPageMeta {
  slug: string;
  title: string;
  sourceFile: string;
  hasDynamicComponents: boolean;
  dynamicComponentKeys: string[];
}

/** Detect `$ComponentName$` markers in content for astro islands. */
export function detectDynamicComponents(content: string): Record<string, true> {
  const components: Record<string, true> = {};
  let match: RegExpExecArray | null;
  while ((match = AstroIslandPattern.exec(content)) !== null) {
    const componentName = match[1];
    if (componentName && /^[A-Za-z_][\w$]*$/.test(componentName)) {
      components[componentName] = true;
    }
  }
  return components;
}

/** Parse YAML frontmatter from markdown content. */
export function parseFrontmatter(
  content: string,
  defaultTitle = "Untitled",
): { frontmatter?: ParsedFrontmatter; body: string } {
  if (!content.startsWith("---")) {
    return { body: content.trim(), frontmatter: undefined };
  }
  const endMarkerIndex = content.indexOf("\n---\n", 4);
  if (endMarkerIndex === -1) {
    return { body: content.trim(), frontmatter: undefined };
  }
  const frontmatterStr = content.slice(4, endMarkerIndex);
  const body = content.slice(endMarkerIndex + 5).trim();

  let title = defaultTitle;
  let slug: string | undefined;
  for (const line of frontmatterStr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim().replace(
      /^["']|["']$/g,
      "",
    );
    if (key === "title") title = String(value);
    else if (key === "slug") slug = String(value);
  }
  return { body, frontmatter: { title, slug } };
}

/** Sanitize a string for use as a URL slug. */
export function sanitizeSlug(slug: string): string {
  const result = slug.replace(/[\uE000-\uF8FF<>"\\\/:.*?|]/g, "");
  return result.trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

/** Generate placeholder comment for Astro island components */
export function generateIslandPlaceholder(
  componentName: string,
  mode: "client" | "server",
): string {
  return `<!-- TODO: Replace with ${componentName} Island (${mode}) -->`;
}

const LAYOUT_TEMPLATE = (siteUrl: string) =>
  `---
export interface LayoutProps {
  title?: string;
}

const siteTitle = "${siteUrl}";
---
<div class="layout-container">
  <nav class="site-nav">
    <a href="/">Home</a>
  </nav>
  <main class="site-content"><slot /></main>
</div>`;

function generatePageAstro(slug: string, title: string, mdxFile: string): string {
  const safeSlug = sanitizeSlug(slug);
  return `---
import Layout from "../layouts/Layout.astro";
import Content from "./${mdxFile}";
---
<Layout>
  <Content />
</Layout>`;
}

function generateComponentFile(name: string): string {
  const safeName = sanitizeSlug(name);
  return `// TODO: Implement ${name} Component as an Astro Island
// Props can be defined based on the data source
import type { ComponentProps } from "solid-js";

export interface ${safeName}Props extends ComponentProps<any> {}

export default function ${safeName}(props: ${safeName}Props) {
  return (
    <div class="${safeName}-wrapper">
      {/* TODO: Implement component */}
    </div>
  );
}`;
}

const PACKAGE_JSON = `{
  "name": "astro-site",
  "version": "1.0.0",
  "type": "module"
}`;

const ASTRO_CONFIG = `import { defineConfig } from 'astro/config';
export default defineConfig({ integrations: [] });`;

const TS_CONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Node"
  }
}`;

const CloneArgsSchema = z.object({
  outputDir: z.string()
    .default("./astro-clone")
    .describe("Output directory for the cloned Astro project"),
  includeFonts: z.boolean()
    .default(true)
    .describe("Generate @font-face links extracted from the source page"),
  siteUrl: z.string()
    .optional()
    .describe("Override the model's global siteUrl for this clone run"),
}).describe("Arguments for the clone method");

type CloneArgs = z.infer<typeof CloneArgsSchema>;

/** Result of cloning a URL into an Astro layout. */
export interface ClonedSiteMeta {
  sourceUrl: string;
  outputDir: string;
  title: string;
  matchedColors: string[];
  fontsLinked: string[];
  componentsGenerated: string[];
}

const HEX_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}/g;
const RGB_COLOR_PATTERN =
  /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/gi;

/** Extract unique color strings (hex and rgb()/rgba()) from HTML. */
export function extractColors(html: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = HEX_COLOR_PATTERN.exec(html)) !== null) {
    if (/^#[0-9a-fA-F]{6}$/i.test(match[0])) found.add(match[0].toLowerCase());
  }
  HEX_COLOR_PATTERN.lastIndex = 0;
  while ((match = RGB_COLOR_PATTERN.exec(html)) !== null) {
    const norm = match[0]
      .replace(/\s+/g, " ")
      .replace(/,\s*/g, ",")
      .toLowerCase();
    found.add(norm);
  }
  return [...found];
}

/** Extract external font stylesheet <link href> URLs from HTML.

Only `rel=stylesheet` links are considered; preconnect/dns-prefetch origins (e.g.
https://fonts.gstatic.com) and non-CSS paths like `/styles/main.css` are excluded so emitted
`@import url(...)` statements never try to load an HTML page as a stylesheet (which browsers
reject with MIME type / NS_ERROR_CORRUPTED_CONTENT). */
export function extractFontLinks(html: string): string[] {
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  // Match <link> tags whose rel is exactly "stylesheet" — preconnect/dns-prefetch hosts the font CDN origin but are NOT stylesheet sources.
  const linkPattern = /<link[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi;
  while ((match = linkPattern.exec(html)) !== null) {
    const hrefMatch = /href\s*=\s*["']([^"']+)['"]/i.exec(match[0]);
    const href = hrefMatch?.[1];
    // Only rel=stylesheet hrefs are collected here, so preconnect/dns-prefetch *hosts* (which caused
    // NS_ERROR_CORRUPTED_CONTENT when emitted as @import) never reach this branch. Keep any absolute
    // fonts-hosted stylesheet; bare origins were already excluded because they aren't rel=stylesheet.
    if (href && /^https?:\/\//i.test(href)) {
      links.add(href);
    }
  }
  return [...links];
}

/** Extract element class names from HTML, preserving DOM encounter order (first appearance wins). */
export function extractClassNames(html: string, limit = 24): string[] {
  const classes = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = /class\s*=\s*["']([^"']+)["']/gi;
  while ((match = pattern.exec(html)) !== null) {
    for (const cls of match[1].split(/\s+/).filter(Boolean)) {
      if (!classes.has(cls) && classes.size < limit) classes.add(cls); // insertion order preserved by Set.prototype.values()
    }
    if (classes.size >= limit) break;
  }
  return [...classes];
}

/** Extract the <title> text from HTML. */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return (match?.[1] ?? "Cloned Site").trim();
}

/** Map a class name onto its HTML region tag + role so the layout mirrors recognizable page structure. */
export function regionForClass(
  cls: string,
): { tag: string; id?: string; cls: string } | null {
  switch (cls) {
    case "site-header":
      return { tag: "header", id: "masthead", cls };
    case "entry-content":
      return { tag: "main", id: "primary", cls };
    case "content-area":
      return { tag: "<div>", id: "primary", cls };
    case "widget-area":
      return { tag: "aside", id: "secondary", cls };
    case "site":
    case "no-js":
    case "hfeed":
      return { tag: "<div>", cls };
    case "footer":
    case "colophon":
      return { tag: "footer", id: "colophon", cls };
    default:
      if (cls.startsWith("wp-")) return null; // skip framework-only classes like wp-embed-responsive
      return null;
  }
}

/** Build a scaffold mirroring the page's recognizable regions, in DOM encounter order. */
export function synthesizeRegions(
  orderedClasses: string[],
): Array<{ tag: string; id?: string; cls: string }> {
  const seen = new Set<string>();
  const out: Array<{ tag: string; id?: string; cls: string }> = [];
  for (const c of orderedClasses) {
    if (seen.has(c)) continue;
    const r = regionForClass(c);
    if (r) out.push(r);
    seen.add(c);
  }
  return out;
}

/** Decode HTML entities like &#038; -> & */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#0*38;/g, "&")
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&#0*60;/g, "<")
    .replace(/&#0*62;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Rewrite relative url() references in CSS to absolute, given the stylesheet's URL. */
export function rewriteCssUrls(css: string, stylesheetUrl: string): string {
  const base = stylesheetUrl.replace(/\/[^/]*$/, "/");
  return css.replace(
    /url\(\s*["']?(?!https?:\/\/|data:)([^)"'\s]+)["']?\s*\)/gi,
    (_, path) => {
      try {
        return `url("${new URL(path, base).href}")`;
      } catch {
        return `url("${path}")`;
      }
    },
  );
}

/** Walk the <head> in document order, fetching all CSS (inline + linked)
 * and returning separate <style> blocks preserving the original cascade. */
export async function collectCssInOrder(
  html: string,
  siteUrl: string,
  log: (msg: string) => void,
): Promise<string> {
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (!headMatch) return "";
  const head = headMatch[1];

  const blocks: string[] = [];
  const tagPattern = /<(style|link)([\s\S]*?)>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(head)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrs = match[2];

    if (tagName === "style") {
      const contentMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(
        head.slice(match.index),
      );
      if (contentMatch) {
        blocks.push(`<style is:global>\n${contentMatch[1].trim()}\n</style>`);
        tagPattern.lastIndex = match.index + contentMatch[0].length;
      }
    } else if (tagName === "link") {
      const relMatch = /rel\s*=\s*["']stylesheet["']/i.test(attrs);
      if (!relMatch) continue;
      const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (!hrefMatch?.[1]) continue;
      const decoded = decodeHtmlEntities(hrefMatch[1]);
      const resolved = resolveUrl(decoded, siteUrl);
      try {
        log(`Fetching stylesheet: ${resolved}`);
        const cssResp = await fetch(resolved);
        if (cssResp.ok) {
          const cssText = await cssResp.text();
          const rewritten = rewriteCssUrls(cssText, resolved);
          blocks.push(`<style is:global>\n/* ${resolved} */\n${rewritten}\n</style>`);
        } else {
          log(`  Skipped (HTTP ${cssResp.status}): ${resolved}`);
        }
      } catch (e) {
        log(`  Failed to fetch: ${resolved} — ${(e as Error).message}`);
      }
    }
  }

  return blocks.join("\n");
}

/** Extract the <body> inner HTML, stripping <script> tags. */
export function extractBodyContent(html: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (!bodyMatch) return "";
  return bodyMatch[1]
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .trim();
}

/** Find the main content region in body HTML and split around it.
 * Returns { before, after, wrapperOpen, wrapperClose } where before/after are
 * balanced HTML fragments and the wrapper tags go around the <slot />. */
export function splitBodyContent(
  bodyHtml: string,
): { before: string; after: string; wrapperOpen: string; wrapperClose: string; main: string } {
  const selectors = [
    /<div[^>]*\bid\s*=\s*["']primary["'][^>]*>/i,
    /<div[^>]*\bclass\s*=\s*["'][^"']*\b(?:content-area|entry-content)\b[^"']*["'][^>]*>/i,
    /<main\b[^>]*>/i,
    /<article\b[^>]*>/i,
    /<div[^>]*\bid\s*=\s*["']content["'][^>]*>/i,
    /<div[^>]*\bclass\s*=\s*["'][^"']*\bsite-content\b[^"']*["'][^>]*>/i,
  ];

  for (const pattern of selectors) {
    const match = pattern.exec(bodyHtml);
    if (!match) continue;

    const tagName = (match[0].match(/^<(\w+)/)?.[1] ?? "div").toLowerCase();
    const openTag = match[0];
    const openIndex = match.index;

    let depth = 1;
    let searchFrom = openIndex + openTag.length;
    const closePattern = new RegExp(`<\\/${tagName}\\s*>`, "gi");
    closePattern.lastIndex = searchFrom;

    let closeMatch: RegExpExecArray | null;
    while ((closeMatch = closePattern.exec(bodyHtml)) !== null) {
      const between = bodyHtml.slice(searchFrom, closeMatch.index);
      const nestedOpens = (between.match(
        new RegExp(`<${tagName}\\b[^>]*>`, "gi"),
      ) || []).length;
      const nestedCloses = (between.match(
        new RegExp(`<\\/${tagName}\\s*>`, "gi"),
      ) || []).length;
      depth += nestedOpens - nestedCloses - 1;
      if (depth <= 0) {
        const closeIndex = closeMatch.index + closeMatch[0].length;
        const inner = bodyHtml.slice(openIndex + openTag.length, closeMatch.index).trim();
        const before = bodyHtml.slice(0, openIndex);
        const after = bodyHtml.slice(closeIndex);
        return { before, after, wrapperOpen: openTag, wrapperClose: closeMatch[0], main: inner };
      }
      depth = 1;
      searchFrom = closeMatch.index + closeMatch[0].length;
    }
  }

  return { before: "", after: "", wrapperOpen: "", wrapperClose: "", main: bodyHtml };
}

/** Resolve a relative URL against a base URL. */
export function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/** Generate a Layout component that includes the source site's actual CSS
 * and replaces the main content area with a <slot /> inside the original wrapper. */
export function generateCloneLayout(
  title: string,
  styleBlocks: string,
  bodyClasses: string,
  before: string,
  after: string,
  wrapperOpen: string,
  wrapperClose: string,
): string {
  return `---
import type { Props } from "astro";

export interface LayoutProps extends Record<string, unknown> {}
const siteTitle = ${JSON.stringify(title)};
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{siteTitle}</title>
${styleBlocks}
  </head>
  <body class="${bodyClasses}">
    <Fragment set:html={${JSON.stringify(before)}} />
    <Fragment set:html={${JSON.stringify(wrapperOpen)}} />
    <slot />
    <Fragment set:html={${JSON.stringify(wrapperClose)}} />
    <Fragment set:html={${JSON.stringify(after)}} />
  </body>
</html>`;
}

/** Serialize synthesized regions into valid, slot-bearing Astro HTML (header, main w/ slot, aside, footer). */
function renderRegions(
  regs: Array<{ tag: string; id?: string; cls: string }>,
): string {
  if (regs.length === 0) {
    return `\n    <nav class="site-nav" />\n    <main class="site-content"><slot /></main>`;
  }

  const headerRegions = regs.filter((r) => r.tag === "header");
  const asideRegions = regs.filter((r) => r.tag === "aside");
  const footerRegions = regs.filter((r) => r.tag === "footer");
  const mainCls =
    regs.find((r) => ["main", "content-area"].includes(r.tag))?.cls ??
      "site-content";

  let out = "";
  for (const r of headerRegions) {
    out += `\n    <${r.tag}${r.id ? ` id="${r.id}"` : ""} class="${
      regCls(r.cls)
    }"><slot name="header" /></${r.tag}>`;
  }
  // single primary content region always rendered; entry-content/content-area both become main#primary
  out += `\n    <main id="primary" class="${regCls(mainCls)}"><slot /></main>`;

  for (const r of asideRegions) {
    out += `\n    <${r.tag} id="${r.id ?? "secondary"}" class="${
      regCls(r.cls)
    }">...<slot name="sidebar" />...</${r.tag}>`;
  }
  for (const r of footerRegions) {
    out += `\n    <${r.tag}${r.id ? ` id="${r.id}"` : ""} class="${
      regCls(r.cls)
    }"><slot name="footer" /></${r.tag}>`;
  }
  return out;
}

function regCls(cls: string | undefined): string {
  return cls ?? "";
}

export const model = {
  type: "@svendowideit/astro-layout",
  version: "2026.07.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Result of the Astro site generation",
      schema: GenerateResultSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    page: {
      description: "Generated astro page metadata",
      schema: GeneratedPageSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    clonedSite: {
      description: "Metadata for a site cloned from an existing URL",
      schema: ClonedSiteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    generate: {
      description:
        "Generate an Astro static site layout from markdown files to outputDir",
      arguments: GenerateArgsSchema,
      execute: async (args: GenerateArgs, context: {
        globalArgs: GlobalArgs;
        logger?: { info(msg: string): void };
        writeResource: (
          specName: "page" | "result",
          name: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
      }) => {
        const log = context.logger?.info ?? (() => {});
        const { siteUrl, sourceDir } = context.globalArgs;
        const outputPath = resolvePath(
          Deno.cwd(),
          args.outputDir || "./astro-site",
        );

        // Create directory structure
        await Deno.mkdir(joinPath(outputPath, "src", "layouts"), {
          recursive: true,
        });
        await Deno.mkdir(joinPath(outputPath, "src", "pages"), {
          recursive: true,
        });
        await Deno.mkdir(joinPath(outputPath, "src", "components"), {
          recursive: true,
        });

        // Write base files — use cloned layout if layoutDir is provided
        if (args.layoutDir) {
          const layoutSrc = resolvePath(
            Deno.cwd(),
            joinPath(args.layoutDir, "src", "layouts", "Layout.astro"),
          );
          const layoutContent = await Deno.readTextFile(layoutSrc);
          await Deno.writeTextFile(
            joinPath(outputPath, "src", "layouts", "Layout.astro"),
            layoutContent,
          );
          log(`Using cloned layout from ${layoutSrc}`);
        } else {
          const layoutCode = LAYOUT_TEMPLATE(siteUrl);
          await Deno.writeTextFile(
            joinPath(outputPath, "src", "layouts", "Layout.astro"),
            layoutCode,
          );
        }
        await Deno.writeTextFile(
          joinPath(outputPath, "package.json"),
          PACKAGE_JSON,
        );
        await Deno.writeTextFile(
          joinPath(outputPath, "astro.config.mjs"),
          ASTRO_CONFIG,
        );
        await Deno.writeTextFile(
          joinPath(outputPath, "tsconfig.json"),
          TS_CONFIG,
        );

        let pagesWritten = 0;
        const skipped: string[] = [];
        const errors: Array<{ file: string; error: string }> = [];
        const allDynamicComponents = new Set<string>();

        const absoluteSourceDir = sourceDir.startsWith("~")
          ? resolvePath(Deno.cwd(), sourceDir.slice(1))
          : resolvePath(Deno.cwd(), sourceDir);

        log(`Processing markdown files from ${absoluteSourceDir}`);
        log(`Output will be written to ${outputPath}`);

        try {
          const entries = await Deno.readDir(absoluteSourceDir);
          for await (const entry of entries) {
            if (!entry.isFile) continue;
            const ext = extnamePath(entry.name).toLowerCase();
            const isMarkdown = !ext &&
              entry.name.toLowerCase().endsWith(".markdown");

            if (!isMarkdown && ext !== ".md") continue;

            try {
              const rawContent = await Deno.readTextFile(
                joinPath(absoluteSourceDir, entry.name),
              );
              if (!rawContent.trim()) {
                skipped.push(entry.name);
                continue;
              }

              const parsed = parseFrontmatter(rawContent);
              const frontmatter = parsed.frontmatter ?? {};
              const slug = (frontmatter.slug as string) ??
                sanitizeSlug(
                  basenamePath(entry.name, extnamePath(entry.name)),
                );
              const title = (frontmatter.title as string) ?? "Untitled";

              const dynamicComponents = detectDynamicComponents(parsed.body);
              Object.keys(dynamicComponents).forEach((c) =>
                allDynamicComponents.add(c)
              );

              let processedBody = parsed.body;
              if (
                args.includeDynamicComponents &&
                Object.keys(dynamicComponents).length > 0
              ) {
                for (const comp of Object.keys(dynamicComponents)) {
                  processedBody = processedBody.replace(
                    /\$(\w+)\$/g,
                    (_, name) =>
                      name === comp
                        ? generateIslandPlaceholder(comp, "client")
                        : _,
                  );
                }
              }

              // Write page file if not index
              const isIndex = slug === "index";
              if (!isIndex) {
                const mdxName = `${sanitizeSlug(slug)}.md`;
                await Deno.writeTextFile(
                  joinPath(
                    outputPath,
                    "src",
                    "pages",
                    `${sanitizeSlug(slug)}.astro`,
                  ),
                  generatePageAstro(slug, title, mdxName),
                );

                await Deno.writeTextFile(
                  joinPath(
                    outputPath,
                    "src",
                    "pages",
                    mdxName,
                  ),
                  processedBody.replace(/^---[\s\S]*?---\s*/, ""),
                );
              } else {
                // Write index page separately (or use slug-based routing)
                await Deno.writeTextFile(
                  joinPath(outputPath, "src", "pages", "index.astro"),
                  generatePageAstro("index", title, "index.md"),
                );
                await Deno.writeTextFile(
                  joinPath(outputPath, "src", "pages", "index.md"),
                  processedBody.replace(/^---[\s\S]*?---\s*/, ""),
                );
              }

              // Write resource for tracking
              await context.writeResource("page", slug, {
                slug: sanitizeSlug(slug),
                title,
                sourceFile: joinPath(absoluteSourceDir, entry.name),
                hasDynamicComponents: Object.keys(dynamicComponents).length > 0,
                dynamicComponentKeys: Object.keys(dynamicComponents),
              });

              pagesWritten++;
              log(`Generated page: ${slug} (${title})`);
            } catch (e) {
              const err = e as Error;
              errors.push({
                file: joinPath(absoluteSourceDir, entry.name),
                error: err.message,
              });
              log(`Error processing ${entry.name}: ${err.message}`);
            }
          }
        } catch (e) {
          const err = e as Error;
          log(`Error reading directory: ${err.message}`);
          throw new Error(`Failed to read source directory: ${err.message}`);
        }

        // Write component placeholders for dynamic components detected
        for (const compName of allDynamicComponents) {
          await Deno.writeTextFile(
            joinPath(
              outputPath,
              "src",
              "components",
              `${sanitizeSlug(compName)}.astro`,
            ),
            generateComponentFile(compName),
          );
          log(`Created placeholder for: ${compName}`);
        }

        const resultHandle = await context.writeResource("result", "main", {
          siteUrl,
          totalPages: pagesWritten + skipped.length + errors.length,
          pagesGenerated: pagesWritten,
          skippedFiles: skipped,
          errors,
        });

        log(
          `Generated Astro layout for ${pagesWritten} markdown files to ${outputPath}`,
        );
        return { dataHandles: [resultHandle] };
      },
    },
    clone: {
      description:
        "Clone the visual layout (CSS, fonts, body content) of an existing URL into a starter Astro site",
      arguments: CloneArgsSchema,
      execute: async (args: CloneArgs, context: {
        globalArgs: GlobalArgs;
        logger?: { info(msg: string): void };
        writeResource: (
          specName: "result" | "page" | "clonedSite",
          name: string,
          data: Record<string, unknown>,
        ) => Promise<{ name: string }>;
      }) => {
        const log = context.logger?.info ?? (() => {});
        const outputPath = resolvePath(
          Deno.cwd(),
          args.outputDir || "./astro-clone",
        );
        const siteUrl = args.siteUrl || context.globalArgs.siteUrl;

        await Deno.mkdir(joinPath(outputPath, "src", "layouts"), {
          recursive: true,
        });
        await Deno.mkdir(joinPath(outputPath, "src", "pages"), {
          recursive: true,
        });

        log(`Fetching ${siteUrl}`);
        const resp = await fetch(siteUrl);
        if (!resp.ok) {
          throw new Error(
            `Failed to fetch source URL: ${resp.status} ${resp.statusText}`,
          );
        }
        const html = await resp.text();

        const title = extractTitle(html);
        const colors = extractColors(html);
        const fontLinks = args.includeFonts ? extractFontLinks(html) : [];
        const classNames = extractClassNames(html);

        // Collect CSS in document order: each <style> and <link> becomes a <style is:global> block
        const styleBlocks = await collectCssInOrder(html, siteUrl, log);

        // Extract body classes from the source page
        const bodyClassMatch = /<body[^>]*class\s*=\s*["']([^"']+)["']/i.exec(html);
        const bodyClasses = bodyClassMatch?.[1] ?? "";

        // Extract body content and split into chrome + main
        const bodyContent = extractBodyContent(html);
        const { before, after, main } = splitBodyContent(bodyContent);

        log(
          `Extracted ${colors.length} colors, ${fontLinks.length} font links`,
        );

        const layoutCode = generateCloneLayout(title, styleBlocks, bodyClasses, before, after);
        await Deno.writeTextFile(
          joinPath(outputPath, "src", "layouts", "Layout.astro"),
          layoutCode,
        );

        // Generate index page with the source site's main content
        const indexPage = `---
import Layout from "../layouts/Layout.astro";
---
<Layout>
  <Fragment set:html={${JSON.stringify(main)}} />
</Layout>`;
        await Deno.writeTextFile(
          joinPath(outputPath, "src", "pages", "index.astro"),
          indexPage,
        );

        await Deno.writeTextFile(
          joinPath(outputPath, "package.json"),
          PACKAGE_JSON,
        );
        await Deno.writeTextFile(
          joinPath(outputPath, "astro.config.mjs"),
          ASTRO_CONFIG,
        );
        await Deno.writeTextFile(
          joinPath(outputPath, "tsconfig.json"),
          TS_CONFIG,
        );

        log(`Cloned visual layout to ${outputPath}`);
        const handle = await context.writeResource("clonedSite", title, {
          sourceUrl: siteUrl,
          outputDir: args.outputDir || "./astro-clone",
          title,
          matchedColors: colors,
          fontsLinked: fontLinks,
          componentsGenerated: [],
          regionsSynthesized: [],
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
