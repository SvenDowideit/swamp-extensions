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
import type { Props } from "react";

export interface LayoutProps {
  children?: JSX.Element;
}

const siteTitle = "${siteUrl}";
---
<div class="layout-container">
  <nav class="site-nav">
    <a href="/">Home</a>
  </nav>
  <main class="site-content">{children}</main>
</div>`;

function generatePageAstro(slug: string, title: string): string {
  const safeSlug = sanitizeSlug(slug);
  return `---
import Layout from "../../layouts/Layout.astro";

export const frontmatter = {
  title: "${title}",
  slug: "${safeSlug}"
};
---
<Layout>
  <article class="prose mx-auto py-8">
    <h1>${title}</h1>
    <!-- Content from markdown rendered here -->
  </article>
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
const RGB_COLOR_PATTERN = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/gi;

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

/** Extract <link rel="stylesheet"> href URLs from HTML. */
export function extractFontLinks(html: string): string[] {
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  const linkPattern = /<link[^>]*rel=["'](?:stylesheet|preconnect|dns-prefetch)['"][^>]*>/gi;
  while ((match = linkPattern.exec(html)) !== null) {
    const hrefMatch = /href\s*=\s*["']([^"']+)['"]/i.exec(match[0]);
    if (hrefMatch?.[1]?.includes("font")) links.add(hrefMatch[1]);
  }
  return [...links];
}

/** Extract element class names from HTML for layout structuring. */
export function extractClassNames(html: string, limit = 24): string[] {
  const classes = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = /class\s*=\s*["']([^"']+)["']/gi;
  while ((match = pattern.exec(html)) !== null) {
    for (const cls of match[1].split(/\s+/).filter(Boolean)) {
      classes.add(cls);
      if (classes.size >= limit) return [...classes];
    }
  }
  return [...classes];
}

/** Extract the <title> text from HTML. */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return (match?.[1] ?? "Cloned Site").trim();
}

/** Generate a Layout component that replicates source colors, fonts and classes. */
export function generateCloneLayout(
  title: string,
  colors: string[],
  fontLinks: string[],
): string {
  const cssVars = colors.slice(0, 8).map((c, i) => `--clone-color-${i + 1}: ${c};`).join("\n  ");
  const fontStyles = fontLinks.map((f) => `@import url('${f}');`).join("\n");
  return `---
export interface LayoutProps { children?: import('react').JSX.Element }
const siteTitle = "${title.replace(/"/g, '\\"')}";
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{siteTitle}</title>${fontStyles ? `\n    <style>\n${fontStyles}\n</style>` : ""}
    <style>
      .layout-container { ${cssVars} }
    </style>
  </head>
  <body class="clone-layout">
    <nav class="site-nav" />
    <main class="site-content">{children}</main>
  </body>
</html>`;
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

        // Write base files
        const layoutCode = LAYOUT_TEMPLATE(siteUrl);
        await Deno.writeTextFile(
          joinPath(outputPath, "src", "layouts", "Layout.astro"),
          layoutCode,
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
                await Deno.writeTextFile(
                  joinPath(
                    outputPath,
                    "src",
                    "pages",
                    `${sanitizeSlug(slug)}.astro`,
                  ),
                  generatePageAstro(slug, title),
                );

                await Deno.writeTextFile(
                  joinPath(
                    outputPath,
                    "src",
                    "pages",
                    `${sanitizeSlug(slug)}.mdx`,
                  ),
                  processedBody.replace(/^---[\s\S]*?---\s*/, ""),
                );
              } else {
                // Write index page separately (or use slug-based routing)
                await Deno.writeTextFile(
                  joinPath(outputPath, "src", "pages", "index.astro"),
                  generatePageAstro("index", title),
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
        "Clone the visual layout (colors, fonts, classes) of an existing URL into a starter Astro site",
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

        await Deno.mkdir(joinPath(outputPath, "src", "layouts"), {
          recursive: true,
        });
        await Deno.mkdir(joinPath(outputPath, "src", "pages"), {
          recursive: true,
        });

        log(`Fetching ${context.globalArgs.siteUrl}`);
        const resp = await fetch(context.globalArgs.siteUrl);
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

        log(`Extracted ${colors.length} colors, ${fontLinks.length} font links`);
        log(
          `Found ${classNames.length} unique classes — generating component stubs`,
        );

        const layoutCode = generateCloneLayout(title, colors, fontLinks);
        await Deno.writeTextFile(
          joinPath(outputPath, "src", "layouts", "Layout.astro"),
          layoutCode,
        );

        // Generate stub components for the first few classes so consumers can implement them
        const componentNames = classNames.slice(0, 12).map((cls) => {
          const safeName = sanitizeSlug(cls);
          return `${safeName.charAt(0).toUpperCase()}${safeName.slice(1)}`;
        }).filter(Boolean);

        for (const compName of componentNames) {
          await Deno.writeTextFile(
            joinPath(outputPath, "src", "components", `${sanitizeSlug(compName)}.astro`),
            generateComponentFile(compName),
          );
        }

        // Generate an index page that mirrors the cloned site's title and color palette
        const indexPage = `---
import Layout from "../layouts/Layout.astro";
const colors = ${JSON.stringify(colors.slice(0, 16))};
---
<Layout>
  <article class="prose mx-auto py-8">
    <h1>${title}</h1>
    {colors.map((c) => (
      <span style={\`background: \${c}\`}></span>
    ))}
  </article>
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
          sourceUrl: context.globalArgs.siteUrl,
          outputDir: args.outputDir || "./astro-clone",
          title,
          matchedColors: colors,
          fontsLinked: fontLinks,
          componentsGenerated: componentNames,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
