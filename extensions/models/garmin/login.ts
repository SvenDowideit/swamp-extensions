/**
 * Standalone login helper for `@svendowideit/garmin-connect`.
 *
 * The model's `login` method runs inside swamp, where a password read from a
 * vault and a non-interactive MFA code work well. This helper covers the two
 * cases swamp cannot: an **interactive terminal prompt**, and **producing a
 * `garth`-style token store** to paste into the vault (`GARMIN_TOKEN_STORE`),
 * which is the preferred path because no password is ever handled again.
 *
 * It is not loaded by swamp (it exports no model) — run it directly:
 *
 *   # Interactive: prompts for password (not echoed). Re-run with --mfa <code>
 *   # if Garmin returns an MFA challenge.
 *   ~/.swamp/deno/deno run \
 *     --allow-net=thegarth.s3.amazonaws.com,sso.garmin.com,connectapi.garmin.com \
 *     --allow-read --allow-write=$HOME/.garminconnect --allow-env \
 *     login.ts --out ~/.garminconnect
 *
 *   # Print a base64 token store for the vault after a successful login.
 *   ~/.swamp/deno/deno run ... login.ts --print-store
 *
 * @module
 */
import {
  beginLogin,
  completeLogin,
  completeMfa,
  createSession,
  type TokenPair,
} from "./garmin_auth.ts";

/** Parse `--flag value` / `--flag` pairs from args. */
export function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith("--")) continue;
    const key = args[i]!.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/** Build the base64 `garth` token store for a token pair. */
export function encodeTokenStore(pair: TokenPair): string {
  const payload = [
    {
      oauth_token: pair.oauth1.oauth_token,
      oauth_token_secret: pair.oauth1.oauth_token_secret,
      domain: pair.oauth1.domain,
    },
    {
      scope: pair.oauth2.scope,
      token_type: pair.oauth2.token_type,
      access_token: pair.oauth2.access_token,
      refresh_token: pair.oauth2.refresh_token,
      expires_in: pair.oauth2.expires_in,
      refresh_token_expires_in: pair.oauth2.refresh_token_expires_in,
    },
  ];
  return btoa(JSON.stringify(payload));
}

/** Write a JSON file with owner-only permissions. */
async function writeSecret(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  await Deno.chmod(path, 0o600);
}

/** Main. */
async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const out = args.out ?? `${Deno.env.get("HOME")}/.garminconnect`;

  const email = Deno.env.get("GARMIN_EMAIL") ?? "";
  const password = Deno.env.get("GARMIN_PASSWORD") ?? "";
  if (!email || !password) {
    console.error(
      "error: set GARMIN_EMAIL and GARMIN_PASSWORD in the environment.",
    );
    Deno.exit(2);
  }

  const session = await createSession();
  console.log("• signing in …");
  let ticket: string;
  if (args.mfa) {
    console.log("• completing MFA challenge …");
    ticket = await completeMfa(session, args.mfa);
  } else {
    const result = await beginLogin(session, email, password);
    if (typeof result !== "string") {
      console.error(
        `MFA_REQUIRED (method: ${result.method}). Re-run with --mfa <code>.`,
      );
      Deno.exit(3);
    }
    ticket = result;
  }

  const pair = await completeLogin(session, ticket);
  console.log("• authenticated");

  await Deno.mkdir(out, { recursive: true });
  await writeSecret(`${out}/oauth1_token.json`, pair.oauth1);
  await writeSecret(`${out}/oauth2_token.json`, pair.oauth2);
  console.log(`• tokens written to ${out} (0600)`);

  if (args["print-store"]) {
    console.log("");
    console.log("Base64 token store for the vault (treat as a password):");
    console.log(encodeTokenStore(pair));
    console.log("");
    console.log("Store it with:");
    console.log("  swamp vault put garmin-secrets GARMIN_TOKEN_STORE");
  }
}

if (import.meta.main) {
  await main();
}
