import { z } from "npm:zod@4";

/** Configuration accepted by the vault: where the encrypted `.cred` files live. */
const ConfigSchema = z.object({
  credstoreDir: z
    .string()
    .default("~/.config/credstore")
    .describe("Base directory for encrypted .cred files"),
  global: z
    .boolean()
    .default(false)
    .describe(
      "Address the shared global directory (credstoreDir itself) instead of this vault's own subdirectory. This is the pre-per-vault legacy location; use it to inspect or migrate secrets stored before per-vault isolation.",
    ),
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
 * Reject a vault name that could escape the credstore base directory.
 *
 * A per-vault provider stores its secrets in `<credstoreDir>/<name>/`, so the
 * name becomes a path segment. swamp validates vault names (lowercase letters,
 * numbers, hyphens), but the provider must not rely on that: a `..` or a
 * separator would let a vault read or write outside the base directory.
 */
export function assertSafeVaultName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      `Invalid vault name '${name}': must not be empty or contain '..', '/', '\\', or null bytes`,
    );
  }
}

/** The directory a provider reads and writes its own secrets in. */
function vaultDirFor(
  name: string,
  credstoreDir: string,
  global: boolean,
): string {
  if (global) return credstoreDir;
  assertSafeVaultName(name);
  return `${credstoreDir}/${name}`;
}

/** Report whether a path exists as a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** List the `*.cred` key names in one directory (sorted, [] if missing). */
async function listCreds(dir: string): Promise<string[]> {
  const keys: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".cred")) {
        keys.push(entry.name.replace(/\.cred$/, ""));
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return keys.sort();
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
 * Stores each secret as an AES256-GCM-encrypted `<key>.cred` file, using
 * `systemd-creds --user` so the file is bound to the caller's UID and the
 * host's machine-id. `get`/`put` throw with the secret key and systemd's stderr
 * on failure; `list` returns sorted key names only.
 *
 * Storage layout — per-vault by default:
 *
 *   `<credstoreDir>/<vault name>/<key>.cred`
 *
 * Each vault instance owns a subdirectory, so two vaults never share keys. Set
 * `global: true` on a vault to address `<credstoreDir>` itself: that flat
 * directory is the pre-isolation location, kept readable (and writable) so
 * existing installs keep working and can be migrated. A `list` on a per-vault
 * vault shows its own keys plus any same-named keys in the global directory, so
 * the transition is not silent — see the companion `@svendowideit/systemd-creds-admin`
 * model's `migrate` method to move them.
 */
export const vault = {
  type: "@svendowideit/systemd-creds",
  name: "systemd-creds Vault",
  description:
    "Stores secrets encrypted at rest using systemd-creds --user (AES256-GCM, bound to UID + machine-id), one subdirectory per vault. Requires systemd v256+.",
  configSchema: ConfigSchema,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
    _runCommand?: RunCommand,
  ) => {
    const parsed = ConfigSchema.parse(config);
    const credstoreDir = expandTilde(parsed.credstoreDir);
    const runCommand = _runCommand ?? defaultRunCommand;
    const global = parsed.global;
    // The directory this vault stores new secrets in.
    const ownDir = vaultDirFor(name, credstoreDir, global);
    // The shared legacy directory, resolved only when this vault is per-vault.
    const legacyDir = global ? null : credstoreDir;

    /** Resolve the file to read: own dir first, then the legacy global dir. */
    const resolveExisting = async (
      secretKey: string,
    ): Promise<string | null> => {
      const ownFile = `${ownDir}/${credFilename(secretKey)}`;
      if (await isFile(ownFile)) return ownFile;
      if (legacyDir !== null) {
        const legacyFile = `${legacyDir}/${credFilename(secretKey)}`;
        if (await isFile(legacyFile)) return legacyFile;
      }
      return null;
    };

    return {
      get: async (secretKey: string): Promise<string> => {
        assertSafeSecretKey(secretKey);
        const filePath = await resolveExisting(secretKey);
        if (filePath === null) {
          throw new Error(
            `Secret '${secretKey}' not found in vault '${name}'`,
          );
        }
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
        await Deno.mkdir(ownDir, { recursive: true });
        const filePath = `${ownDir}/${credFilename(secretKey)}`;
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
      /**
       * Remove a key from this vault's own directory. A key that lives only in
       * the shared global directory is refused: no single vault owns it, and
       * deleting it from here would silently affect every other vault. Migrate
       * it first (the companion admin model), or manage the global store with a
       * `global: true` vault.
       */
      delete: async (secretKey: string): Promise<void> => {
        assertSafeSecretKey(secretKey);
        const ownFile = `${ownDir}/${credFilename(secretKey)}`;
        if (!(await isFile(ownFile))) {
          if (
            legacyDir !== null &&
            (await isFile(`${legacyDir}/${credFilename(secretKey)}`))
          ) {
            throw new Error(
              `Secret '${secretKey}' lives in the shared global credstore, not in vault '${name}'. ` +
                `Migrate it into this vault first, or delete it via a 'global: true' vault.`,
            );
          }
          return; // already absent — a no-op delete
        }
        await Deno.remove(ownFile);
      },
      /**
       * List this vault's own keys only.
       *
       * Keys in the shared global directory are deliberately NOT included, so
       * `list-keys <vault>` shows exactly what belongs to that vault. Reads
       * still fall back (see `get`), so existing references keep resolving; to
       * see and manage the shared set, address it with a `global: true` vault.
       */
      list: async (): Promise<string[]> => {
        return await listCreds(ownDir);
      },
      getName: (): string => name,
    };
  },
};
