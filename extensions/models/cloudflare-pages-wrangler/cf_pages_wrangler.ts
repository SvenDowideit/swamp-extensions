import { z } from "npm:zod@4";
import { spawn } from "node:child_process";

const GlobalArgsSchema = z.object({
  accountId: z.string().min(1).describe("Cloudflare account ID"),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Cloudflare API token with Pages Edit and Zone DNS Edit",
  ),
  productionBranch: z.string().min(1).default("main").describe(
    "Production branch name for the Pages project",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type MethodContext = {
  globalArgs: GlobalArgs;
  logger?: {
    info: (message: string, properties?: Record<string, unknown>) => void;
    warning?: (message: string, properties?: Record<string, unknown>) => void;
    error?: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

const ProjectSchema = z.object({
  name: z.string(),
  status: z.string(),
  result: z.unknown().optional(),
  deployedAt: z.string().optional(),
  domain: z.string().optional(),
  boundAt: z.string().optional(),
});

async function cloudflarePages(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the raw text when Cloudflare returns a non-JSON error.
  }
  if (!response.ok) {
    throw new Error(
      `Cloudflare Pages request failed (${response.status}): ${text}`,
    );
  }
  return parsed;
}

/** Cloudflare returns 8000018 when the same custom domain is already attached. */
export function isAlreadyBound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("8000018") ||
    message.toLowerCase().includes("already added this custom domain");
}

/**
 * Run the Wrangler CLI. Kept in one documented helper so the subprocess
 * exception is reviewed once rather than inside every method.
 */
async function runWrangler(
  args: string[],
  env: Record<string, string>,
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        success: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Cloudflare Pages direct-upload helper.
 */
export const model = {
  type: "@svendowideit/cloudflare-pages-wrangler",
  version: "2026.10.24.3",
  upgrades: [
    {
      toVersion: "2026.10.24.2",
      description:
        "Idempotent project creation and typed method arguments; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.24.3",
      description:
        "Treat Cloudflare's already-added custom-domain response (8000018) as an idempotent success in bindDomain",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    project: {
      description: "Cloudflare Pages direct-upload project or deployment state",
      schema: ProjectSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    createProject: {
      description: "Create a direct-upload Pages project without a Git source",
      arguments: z.object({
        name: z.string().min(1).describe("Pages project name"),
        productionBranch: z.string().optional().describe(
          "Production branch for the project",
        ),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const path = `/accounts/${g.accountId}/pages/projects/${args
          .name as string}`;
        const getResponse = await fetch(
          `https://api.cloudflare.com/client/v4${path}`,
          {
            headers: { "Authorization": `Bearer ${g.apiToken}` },
          },
        );
        const getText = await getResponse.text();
        let getResult: unknown = getText;
        try {
          getResult = JSON.parse(getText);
        } catch { /* keep text */ }
        if (getResponse.ok) {
          const handle = await context.writeResource(
            "project",
            args.name as string,
            {
              name: args.name as string,
              status: "exists",
              result: getResult,
            },
          );
          context.logger?.info("Pages project {name} already exists", {
            name: args.name as string,
          });
          return { dataHandles: [handle] };
        }
        if (getResponse.status !== 404) {
          throw new Error(
            `Cloudflare Pages GET failed (${getResponse.status}): ${getText}`,
          );
        }
        const createResult = await cloudflarePages(
          "POST",
          `/accounts/${g.accountId}/pages/projects`,
          g.apiToken,
          {
            name: args.name as string,
            production_branch: (args.productionBranch as string | undefined) ??
              g.productionBranch,
          },
        );
        const handle = await context.writeResource(
          "project",
          args.name as string,
          {
            name: args.name as string,
            status: "created",
            result: createResult,
          },
        );
        context.logger?.info("Created Pages project {name}", {
          name: args.name as string,
        });
        return { dataHandles: [handle] };
      },
    },
    deployDirect: {
      description:
        "Deploy a local directory with Wrangler's supported direct-upload path",
      arguments: z.object({
        projectName: z.string().min(1).describe("Pages project name"),
        directory: z.string().min(1).describe("Local directory to upload"),
        branch: z.string().optional().describe("Deployment branch"),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const stat = await Deno.stat(args.directory as string).catch(() =>
          null
        );
        if (!stat?.isDirectory) {
          throw new Error(`Directory not found: ${args.directory as string}`);
        }
        const output = await runWrangler(
          [
            "pages",
            "deploy",
            args.directory as string,
            "--project-name",
            args.projectName as string,
            "--branch",
            (args.branch as string | undefined) ?? "main",
            "--commit-dirty",
            "true",
          ],
          {
            ...Deno.env.toObject(),
            CLOUDFLARE_API_TOKEN: g.apiToken,
            CLOUDFLARE_ACCOUNT_ID: g.accountId,
          },
        );
        const stdout = output.stdout;
        const stderr = output.stderr;
        if (!output.success) {
          throw new Error(
            `Wrangler direct upload failed (${output.code}): ${
              stderr || stdout
            }`,
          );
        }
        const handle = await context.writeResource(
          "project",
          args.projectName as string,
          {
            name: args.projectName as string,
            status: "deployed",
            deployedAt: new Date().toISOString(),
            result: { stdout, stderr },
          },
        );
        context.logger?.info("Deployed Pages project {name}", {
          name: args.projectName as string,
        });
        return { dataHandles: [handle] };
      },
    },
    bindDomain: {
      description: "Bind a custom domain to a Pages project",
      arguments: z.object({
        projectName: z.string().min(1).describe("Pages project name"),
        domain: z.string().min(1).describe("Custom domain name"),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        let result: unknown;
        try {
          result = await cloudflarePages(
            "POST",
            `/accounts/${g.accountId}/pages/projects/${args
              .projectName as string}/domains`,
            g.apiToken,
            { name: args.domain as string },
          );
        } catch (error) {
          if (!isAlreadyBound(error)) throw error;
          result = {
            alreadyBound: true,
            message: "custom domain already added",
          };
          context.logger?.info(
            "Domain {domain} is already bound to {project}; treating as success",
            {
              domain: args.domain as string,
              project: args.projectName as string,
            },
          );
        }
        const handle = await context.writeResource(
          "project",
          args.projectName as string,
          {
            name: args.projectName as string,
            status: "domain-bound",
            domain: args.domain as string,
            boundAt: new Date().toISOString(),
            result,
          },
        );
        context.logger?.info("Bound domain {domain} to {project}", {
          domain: args.domain as string,
          project: args.projectName as string,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
