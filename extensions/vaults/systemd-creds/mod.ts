import { z } from "npm:zod@4";

/** Configuration accepted by the vault: where the encrypted `.cred` files live. */
const ConfigSchema = z.object({
  credstoreDir: z
    .string()
    .default("~/.config/credstore")
    .describe("Directory for encrypted .cred files"),
});

/** Injectable runner so tests can stub the `systemd-creds` binary. */
type RunCommand = (
  args: string[],
  stdin?: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Run `systemd-creds --user <args>`, piping `stdin` when supplied.
 *
 * Returns the decoded stdout/stderr and exit code rather than throwing, so
 * callers can attach the secret key to any error message.
 *
 * The stdin write and `child.output()` run concurrently. If `systemd-creds`
 * exits before reading stdin — it does when the plaintext exceeds its 1 MiB
 * credential limit, or on a bad argument — the write fails with a bare
 * `BrokenPipe`. That is swallowed so the process is still awaited and systemd's
 * real diagnostic on stderr is what the caller reports; otherwise the operator
 * would see an opaque "Broken pipe" instead of "Plaintext too long…", and the
 * child would not be deterministically reaped.
 *
 * @param args Arguments after `--user`.
 * @param stdin Value piped to systemd-creds' stdin, when defined.
 * @param binPath The binary to run; defaults to `systemd-creds`. Tests override
 *   it to exercise the broken-pipe path without the real binary.
 */
export async function defaultRunCommand(
  args: string[],
  stdin?: string,
  binPath = "systemd-creds",
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cmd = new Deno.Command(binPath, {
    args: ["--user", ...args],
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  const child = cmd.spawn();

  const writeStdin = (async (): Promise<void> => {
    if (stdin === undefined) return;
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(stdin));
    } catch {
      // systemd-creds closed stdin early; its stderr carries the real reason.
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed by the failed write.
      }
    }
  })();

  const [{ code, stdout, stderr }] = await Promise.all([
    child.output(),
    writeStdin,
  ]);

  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/** Expand a leading `~/` to the user's home directory. */
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

/** Map a secret key to its encrypted file name. */
function credFilename(secretKey: string): string {
  return `${secretKey}.cred`;
}

/**
 * Reject secret keys that could escape `credstoreDir`.
 *
 * The key becomes part of a file path, so a `..`, a path separator, or a null
 * byte would let a caller read or write a `.cred` file anywhere on disk —
 * including outside the configured credstore. This mirrors the validation the
 * built-in `local_encryption` vault applies; swamp does not enforce it
 * centrally, so each provider must.
 */
export function assertSafeSecretKey(secretKey: string): void {
  if (
    secretKey.length === 0 ||
    secretKey.includes("..") ||
    secretKey.includes("/") ||
    secretKey.includes("\\") ||
    secretKey.includes("\0")
  ) {
    throw new Error(
      `Invalid secret key '${secretKey}': must not be empty or contain '..', '/', '\\', or null bytes`,
    );
  }
}

/**
 * systemd-creds vault provider.
 *
 * Stores each secret as an AES256-GCM-encrypted `<key>.cred` file in
 * `credstoreDir`, using `systemd-creds --user` so the file is bound to the
 * caller's UID and the host's machine-id. `get`/`put` throw with the secret key
 * and systemd's stderr on failure; `list` returns sorted key names only.
 */
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
        assertSafeSecretKey(secretKey);
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
        assertSafeSecretKey(secretKey);
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
