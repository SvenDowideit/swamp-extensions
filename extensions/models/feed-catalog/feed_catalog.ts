/**
 * Feed catalog — manages a curated list of RSS/Atom feeds for the news reader.
 *
 * Store your favorite feeds in a swamp data resource, organized by category
 * (tech, news, programming, podcasting). The news workflow reads this catalog
 * to know which feeds to fetch.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  /** Optional catalog name for multiple catalogs (default: "default"). */
  catalogName: z.string().default("default").describe(
    "Catalog name (for multiple catalogs)",
  ),
}).strict();

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AddFeedArgsSchema = z.object({
  url: z.string().url().describe("RSS/Atom feed URL to add"),
  category: z.string().default("uncategorized").describe(
    "Category tag (e.g., tech, news, programming, podcasting)",
  ),
  name: z.string().optional().describe(
    "Human-readable feed name (defaults to hostname)",
  ),
}).describe("Arguments for adding a feed");

type AddFeedArgs = z.infer<typeof AddFeedArgsSchema>;

const RemoveFeedArgsSchema = z.object({
  url: z.string().url().describe("RSS/Atom feed URL to remove"),
}).describe("Arguments for removing a feed");

type RemoveFeedArgs = z.infer<typeof RemoveFeedArgsSchema>;

const ListFeedsArgsSchema = z.object({
  category: z.string().optional().describe("Filter by category (optional)"),
  limit: z.number().int().min(0).max(500).default(0).describe(
    "Maximum feeds to return. Use 0 for unlimited.",
  ),
}).describe("Arguments for listing feeds");

type ListFeedsArgs = z.infer<typeof ListFeedsArgsSchema>;

const ListCategoriesArgsSchema = z.object({}).describe(
  "Arguments for listing feed categories",
);

type ListCategoriesArgs = z.infer<typeof ListCategoriesArgsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single feed in the catalog. */
export interface Feed {
  /** Feed URL (canonical, no trailing slash). */
  url: string;
  /** Human-readable name (derived from hostname if not provided). */
  name: string;
  /** Category tag for grouping/filtering feeds. */
  category: string;
  /** ISO-8601 timestamp when feed was added. */
  addedAt: string;
}

/** The complete feed catalog. */
export interface FeedCatalog {
  /** Catalog name (for multiple catalogs). */
  name: string;
  /** All feeds in this catalog. */
  feeds: Feed[];
  /** Total count of feeds. */
  totalCount: number;
}

/** Output of the listCategories method. */
export interface CategoriesList {
  /** Catalog name. */
  name: string;
  /** All unique categories in the catalog. */
  categories: string[];
  /** Total count of categories. */
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Extract a human-readable name from a feed URL. */
export function extractFeedName(url: string): string {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, "");
    if (host.endsWith("/")) host = host.slice(0, -1);
    return host;
  } catch {
    return url.replace(/https?:\/\//, "").replace(/\/$/, "");
  }
}

// ---------------------------------------------------------------------------
// Shared context type for all methods
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
};

// ---------------------------------------------------------------------------
// Zod schemas for resources
// ---------------------------------------------------------------------------

const FeedSchema = z.object({
  url: z.string().url(),
  name: z.string(),
  category: z.string(),
  addedAt: z.iso.datetime(),
});

const FeedCatalogSchema = z.object({
  name: z.string(),
  feeds: z.array(FeedSchema),
  totalCount: z.number(),
});

const CategoriesListSchema = z.object({
  name: z.string(),
  categories: z.array(z.string()),
  totalCount: z.number(),
});

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export const model = {
  type: "@svendowideit/feed-catalog",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    catalog: {
      description: "Feed catalog (list of RSS/Atom feeds with categories)",
      schema: FeedCatalogSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    categories: {
      description: "List of unique categories in the catalog",
      schema: CategoriesListSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    add: {
      description: "Add a feed URL to the catalog",
      arguments: AddFeedArgsSchema,
      execute: async (
        args: AddFeedArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;
        const catalogName = context.globalArgs.catalogName;

        let catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData || catalogData.name !== catalogName) {
          catalogData = { name: catalogName, feeds: [], totalCount: 0 };
        }

        const feedName = args.name ?? extractFeedName(args.url);
        const newFeed: Feed = {
          url: new URL(args.url).href.replace(/\/$/, ""),
          name: feedName,
          category: args.category,
          addedAt: new Date().toISOString(),
        };

        if (catalogData.feeds.some((f) => f.url === newFeed.url)) {
          logger?.info("Feed already in catalog: {name} ({url})", {
            name: newFeed.name,
            url: newFeed.url,
          });
          // No-op — feed already exists, not an error
          const handle = await context.writeResource("catalog", "current", {
            name: catalogData.name,
            feeds: catalogData.feeds,
            totalCount: catalogData.totalCount,
          });
          return { dataHandles: [handle] };
        }

        catalogData.feeds.push(newFeed);
        catalogData.totalCount = catalogData.feeds.length;

        logger?.info("Added feed {name} ({url}) to category '{category}'", {
          name: newFeed.name,
          url: newFeed.url,
          category: newFeed.category,
        });

        const handle = await context.writeResource("catalog", "current", {
          name: catalogData.name,
          feeds: catalogData.feeds,
          totalCount: catalogData.totalCount,
        });

        return { dataHandles: [handle] };
      },
    },
    remove: {
      description: "Remove a feed URL from the catalog",
      arguments: RemoveFeedArgsSchema,
      execute: async (
        args: RemoveFeedArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add a feed first with 'add'.",
          );
        }

        const url = args.url.replace(/\/$/, "");

        const beforeCount = catalogData.feeds.length;
        catalogData.feeds = catalogData.feeds.filter((f) => f.url !== url);
        catalogData.totalCount = catalogData.feeds.length;

        if (catalogData.feeds.length === beforeCount) {
          throw new Error(`Feed not found in catalog: ${url}`);
        }

        logger?.info("Removed feed {url} from catalog", { url });

        const handle = await context.writeResource("catalog", "current", {
          name: catalogData.name,
          feeds: catalogData.feeds,
          totalCount: catalogData.totalCount,
        });

        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "List feeds in the catalog. If category is omitted, all categories are returned. Use limit=0 for unlimited.",
      arguments: ListFeedsArgsSchema,
      execute: async (
        args: ListFeedsArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add feeds first with the 'add' method.",
          );
        }

        let feeds: Feed[] = catalogData.feeds;

        if (args.category) {
          feeds = feeds.filter((f) => f.category === args.category);
        }

        const limit = args.limit ?? 0;
        if (limit > 0 && feeds.length > limit) {
          feeds = feeds.slice(0, limit);
        }

        const output: FeedCatalog = {
          name: catalogData.name,
          feeds,
          totalCount: feeds.length,
        };

        logger?.info(
          "Listing {count} feeds from catalog '{catalog}'{category}",
          {
            count: feeds.length,
            catalog: catalogData.name,
            category: args.category ? ` (category: ${args.category})` : "",
          },
        );

        const handle = await context.writeResource(
          "catalog",
          "list-output",
          { ...output },
        );

        return { dataHandles: [handle] };
      },
    },
    listCategories: {
      description: "List all unique categories in the catalog",
      arguments: ListCategoriesArgsSchema,
      execute: async (
        _args: ListCategoriesArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: [{ name: string }] }> => {
        const logger = context.logger;

        const catalogData = await context.readResource("current") as
          | FeedCatalog
          | null;
        if (!catalogData) {
          throw new Error(
            "No feed catalog found. Add feeds first with the 'add' method.",
          );
        }

        const categories = Array.from(
          new Set(catalogData.feeds.map((f) => f.category)),
        ).sort();

        const output: CategoriesList = {
          name: catalogData.name,
          categories,
          totalCount: categories.length,
        };

        logger?.info(
          "Found {count} categories in catalog '{catalog}'",
          { count: categories.length, catalog: catalogData.name },
        );

        const handle = await context.writeResource(
          "categories",
          "list-output",
          { ...output },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
