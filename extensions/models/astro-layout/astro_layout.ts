/**
 * Astro Layout — generates an Astro static site layout from markdown files.
 * Scans a directory of markdown files, creates page metadata for each, and
 * detects dynamic component markers to generate placeholder comments for
 * astro islands that users can implement later.
 */
import { z } from "npm:zod@4";
import {
  basename as basenamePath,
  extname as extnamePath,
  join as joinPath,
  resolve as resolvePath,
} from "jsr:@std/path@1";

const GlobalArgsSchema = z.object({
  siteUrl: z.string().describe(
    "Base URL for the Astro site (e.g. https://example.com)",
  ),
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
  errors: z.array(
    z.object({ file: z.string(), error: z.string() }),
  ),
});

const AstroIslandPattern = /\$(\w+)\$/g;

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
  let date: string | undefined;
  let draft = false;
  const tagsList: string[] = [];
  let category: string | undefined;

  for (const line of frontmatterStr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    let value: unknown;

    if (trimmed.includes(": true") || trimmed.includes(": false")) {
      value = trimmed.includes(": true");
    } else if (key !== "tags" && trimmed.startsWith("- ")) {
      const tagMatch = trimmed.match(/^[-\s]*"?([^"]+)"?$/);
      if (tagMatch) tagsList.push(tagMatch[1].replace(/"/g, ""));
      continue;
    } else if (trimmed.includes(":")) {
      value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    }

    switch (key) {
      case "title":
        title = String(value);
        break;
      case "slug":
        slug = String(value);
        break;
      case "date":
        date = String(value);
        break;
      case "draft":
        draft = Boolean(value);
        break;
      case "category":
        category = String(value);
        break;
    }
  }

  const frontmatter: ParsedFrontmatter = { title, slug, date, draft };
  if (tagsList.length > 0) {
    frontmatter.tags = tagsList;
  }
  if (category) {
    frontmatter.category = category;
  }

  return { body, frontmatter };
}

/** Sanitize a string for use as a URL slug. */
export function sanitizeSlug(slug: string): string {
  const result = slug.replace(/[\uE000-\uF8FF<>"\\\/:*?|]/g, "");
  return result.trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

/** Generate Astro island placeholder comment for a component. */
export function generateIslandPlaceholder(
  componentName: string,
  mode: "client" | "server",
): string {
  return `<!-- TODO: Replace with ${componentName} Island (${mode}) -->`;
}

/** Model definition for generating Astro layouts from markdown files. */
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
  },
  methods: {
    generate: {
      description:
        "Generate an Astro static site layout from markdown files with pages for each file and optional dynamic component placeholders",
      arguments: GenerateArgsSchema,
      execute: async (_args: GenerateArgs, context: {
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

        const absoluteSourceDir = resolvePath(
          Deno.cwd(),
          sourceDir.startsWith("~") ? sourceDir.slice(1) : sourceDir,
        );

        log(`Processing markdown files from ${absoluteSourceDir}`);

        let pagesWritten = 0;
        const skipped: string[] = [];
        const errors: Array<{ file: string; error: string }> = [];

        try {
          const entries = await Deno.readDir(absoluteSourceDir);
          for await (const entry of entries) {
            if (!entry.isFile) continue;
            const lowerName = entry.name.toLowerCase();
            const ext = extnamePath(entry.name).toLowerCase();
            if (ext !== ".md" && !lowerName.endsWith(".markdown")) {
              continue;
            }

            try {
              const content = await Deno.readTextFile(
                joinPath(absoluteSourceDir, entry.name),
              );
              if (!content.trim()) {
                skipped.push(entry.name);
                continue;
              }

              const parsed = parseFrontmatter(content);
              const frontmatter = parsed.frontmatter ?? {};
              const slug = (frontmatter.slug as string) ?? sanitizeSlug(
                basenamePath(entry.name, extnamePath(entry.name)),
              );
              const title = (frontmatter.title as string) ?? "Untitled";

              const dynamicComponents = detectDynamicComponents(parsed.body);
              const hasDynamicComponents =
                Object.keys(dynamicComponents).length > 0;

              await context.writeResource(
                "page",
                slug,
                {
                  slug,
                  title,
                  sourceFile: joinPath(absoluteSourceDir, entry.name),
                  hasDynamicComponents,
                  dynamicComponentKeys: Object.keys(dynamicComponents),
                },
              );

              pagesWritten++;
              log(`Processed markdown file: ${slug} (${title})`);
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
          log(`Error reading directory ${absoluteSourceDir}: ${err.message}`);
          throw new Error(`Failed to read source directory: ${err.message}`);
        }

        const resultHandle = await context.writeResource("result", "main", {
          siteUrl,
          totalPages: pagesWritten + skipped.length + errors.length,
          pagesGenerated: pagesWritten,
          skippedFiles: skipped,
          errors,
        });

        log(`Generated Astro layout for ${pagesWritten} markdown files`);

        return { dataHandles: [resultHandle] };
      },
    },
  },
};
