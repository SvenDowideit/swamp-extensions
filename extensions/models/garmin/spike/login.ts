/**
 * Spike CLI: run the full Garmin login flow and prove it works end to end.
 *
 * Usage:
 *
 *   # Interactive: prompts for email + password (+ MFA code if challenged).
 *   deno run -A login.ts --out ~/.garminconnect
 *
 *   # Non-interactive (spike only — prefer env over shell history in production):
 *   GARMIN_EMAIL=you@example.com GARMIN_PASSWORD=… \
 *     deno run -A login.ts --out ~/.garminconnect
 *
 *   # Resume a login that returned an MFA challenge:
 *   deno run -A login.ts --out ~/.garminconnect --mfa 123456
 *
 * On success it writes `oauth1_token.json` + `oauth2_token.json` to `--out`
 * (mode 0600) and verifies by fetching `/userprofile-service/socialProfile`.
 * Tokens are never printed; only a redacted summary is logged.
 *
 * @module
 */
import {
  beginLogin,
  completeMfa,
  connectapiGet,
  createSession,
  exchangeOAuth2,
  getOAuth1Token,
  type OAuth2Token,
  redact,
} from "./garmin_auth.ts";

/** Parse `--flag value` / `--flag` pairs from args. */
function parseArgs(args: string[]): Record<string, string> {
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

/** Prompt on the terminal without echoing the value. */
function promptHidden(label: string): string {
  const buf = new Uint8Array(1024);
  const n = Deno.stdin.readSync(buf);
  const value = new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim();
  void label;
  return value;
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
  const mfaCode = args.mfa;

  const email = Deno.env.get("GARMIN_EMAIL") ?? Deno.args[0] ?? "";
  const password = Deno.env.get("GARMIN_PASSWORD") ??
    (Deno.env.get("GARMIN_PASSWORD") ? "" : promptHidden("Garmin password: "));

  if (!email || !password) {
    console.error(
      "error: supply GARMIN_EMAIL + GARMIN_PASSWORD, or run with a TTY to prompt.",
    );
    Deno.exit(2);
  }

  const session = await createSession();
  console.log(`• consumer key ${session.consumer.consumer_key}`);

  console.log("• POST /mobile/api/login …");
  let ticket: string;
  if (mfaCode) {
    console.log("• resuming with MFA code …");
    ticket = await completeMfa(session, mfaCode);
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
  console.log("• service ticket OK");

  console.log("• GET /oauth-service/oauth/preauthorized …");
  const oauth1 = await getOAuth1Token(session, ticket);
  console.log(`• OAuth1 token acquired (len ${oauth1.oauth_token.length})`);

  console.log("• POST /oauth-service/oauth/exchange/user/2.0 (login) …");
  const oauth2: OAuth2Token = await exchangeOAuth2(session, oauth1, true);
  console.log(
    `• OAuth2 bearer acquired: ${JSON.stringify(redact(oauth2))}`,
  );

  console.log("• GET /userprofile-service/socialProfile …");
  const profile = await connectapiGet(
    session,
    oauth2,
    "/userprofile-service/socialProfile",
  ) as Record<string, unknown>;
  console.log(
    `✓ authenticated as ${profile.displayName ?? profile.userName ?? "?"} ` +
      `(${profile.fullName ?? "no name"})`,
  );

  await Deno.mkdir(out, { recursive: true });
  await writeSecret(`${out}/oauth1_token.json`, oauth1);
  await writeSecret(`${out}/oauth2_token.json`, oauth2);
  console.log(`• tokens written to ${out} (0600)`);
}

if (import.meta.main) {
  await main();
}
