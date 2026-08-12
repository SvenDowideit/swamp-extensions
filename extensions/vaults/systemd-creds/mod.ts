import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  credstoreDir: z
    .string()
    .default("~/.config/credstore")
    .describe("Directory for encrypted .cred files"),
});

type RunCommand = (
  args: string[],
  stdin?: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

async function defaultRunCommand(
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cmd = new Deno.Command("systemd-creds", {
    args: ["--user", ...args],
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  const child = cmd.spawn();

  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }

  return child.output().then(({ code, stdout, stderr }) => ({
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  }));
}

function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (!home) {
      throw new Error("HOME environment variable is not set");
    }
    return path.replace("~", home);
  }
  return path;
}

function credFilename(secretKey: string): string {
  return `${secretKey}.cred`;
}

export const vault = {
  type: "@svendowideit/systemd-creds",
  name: "systemd-creds Vault",
  description:
    "Stores secrets encrypted at rest using systemd-creds --user (AES256-GCM, bound to UID + machine-id). Requires systemd v256+.",
  configSchema: ConfigSchema,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
    _runCommand?: RunCommand,
  ) => {
    const parsed = ConfigSchema.parse(config);
    const credstoreDir = expandTilde(parsed.credstoreDir);
    const runCommand = _runCommand ?? defaultRunCommand;

    return {
      get: async (secretKey: string): Promise<string> => {
        const filePath = `${credstoreDir}/${credFilename(secretKey)}`;
        const { stdout, stderr, code } = await runCommand([
          "decrypt",
          filePath,
          "-",
        ]);
        if (code !== 0) {
          throw new Error(
            `Failed to decrypt secret '${secretKey}': ${stderr.trim()}`,
          );
        }
        return stdout;
      },
      put: async (secretKey: string, secretValue: string): Promise<void> => {
        await Deno.mkdir(credstoreDir, { recursive: true });
        const filePath = `${credstoreDir}/${credFilename(secretKey)}`;
        const { stderr, code } = await runCommand(
          ["encrypt", "-", filePath],
          secretValue,
        );
        if (code !== 0) {
          throw new Error(
            `Failed to encrypt secret '${secretKey}': ${stderr.trim()}`,
          );
        }
      },
      list: async (): Promise<string[]> => {
        const keys: string[] = [];
        try {
          for await (const entry of Deno.readDir(credstoreDir)) {
            if (entry.isFile && entry.name.endsWith(".cred")) {
              keys.push(entry.name.replace(/\.cred$/, ""));
            }
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            return [];
          }
          throw error;
        }
        return keys.sort();
      },
      getName: (): string => name,
    };
  },
};
