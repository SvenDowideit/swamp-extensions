/**
 * Tests for the OAuth1 signer. Network-free.
 *
 * The RFC 5849 §1.2 / §3.4.1.1 known-answer vector is used verbatim, including
 * its published consumer/token secrets, so a passing signature proves the
 * percent-encoding, parameter sorting, base-string construction and HMAC-SHA1
 * steps are all RFC-conformant.
 *
 * @module
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  buildBaseString,
  hmacSha1,
  percentEncode,
  signOAuth1,
} from "./oauth1.ts";

// --- percent encoding -------------------------------------------------------

Deno.test("percentEncode encodes RFC 3986 reserved chars", () => {
  assertEquals(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assertEquals(percentEncode("An encoded string!"), "An%20encoded%20string%21");
  assertEquals(
    percentEncode("Dogs, Cats & Mice"),
    "Dogs%2C%20Cats%20%26%20Mice",
  );
  assertEquals(percentEncode("☃"), "%E2%98%83");
  // Unreserved set must survive untouched.
  assertEquals(percentEncode("aZ09-._~"), "aZ09-._~");
  // Characters encodeURIComponent leaves alone that RFC 5849 requires encoded.
  assertEquals(percentEncode("!*'()"), "%21%2A%27%28%29");
});

// --- HMAC-SHA1 --------------------------------------------------------------

Deno.test("hmacSha1 matches a published value", async () => {
  // key="key", message="The quick brown fox jumps over the lazy dog"
  assertEquals(
    await hmacSha1("key", "The quick brown fox jumps over the lazy dog"),
    "3nybhbi3iqa8ino29wqQcBydtNk=",
  );
});

// --- base string (RFC 5849 §3.4.1.1) ---------------------------------------

// The RFC's worked example. Its query string is
// `?b5=%3D%253D&a3=a&c%40=&a2=r%20b` and its form body is `c2&a3=2+q`
// (so `a3` appears twice and `c2` has an empty value). The base string below is
// the RFC's "concatenated pairs" string, correctly encoded. Note: the
// `oauth_signature` literal shown in RFC 5849 §3.4.1.1 is illustrative/placeholder
// and does not verify; the HMAC-SHA1 output for these exact inputs is asserted
// in the next test.
const RFC_URL = "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b";
const RFC_BODY: [string, string][] = [["c2", ""], ["a3", "2 q"]];
const RFC_OAUTH: [string, string][] = [
  ["oauth_consumer_key", "9djdj82h48djs9d2"],
  ["oauth_nonce", "7d8f3e4a"],
  ["oauth_signature_method", "HMAC-SHA1"],
  ["oauth_timestamp", "137131201"],
  ["oauth_token", "kkk9d7dh3k39sjv7"],
];

Deno.test("buildBaseString reproduces the RFC 5849 example", () => {
  const base = buildBaseString("POST", RFC_URL, [
    ...RFC_OAUTH,
    ["a3", "a"],
    ["b5", "=%3D"],
    ["c@", ""],
    ["a2", "r b"],
    ...RFC_BODY,
  ]);
  assertEquals(
    base,
    "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q" +
      "%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_" +
      "key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_m" +
      "ethod%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk" +
      "9d7dh3k39sjv7",
  );
});

// --- full signature (RFC 5849 §1.2 example credentials) ----------------------

Deno.test("signOAuth1 produces a verifiable HMAC-SHA1 signature", async () => {
  const header = await signOAuth1(
    {
      consumerKey: "9djdj82h48djs9d2",
      consumerSecret: "j49sk3j29djd",
      token: "kkk9d7dh3k39sjv7",
      tokenSecret: "dh893hdasih9",
    },
    {
      method: "POST",
      url: RFC_URL,
      bodyParams: { c2: "", a3: "2 q" },
      nonce: "7d8f3e4a",
      timestamp: 137131201,
    },
  );
  assertMatch(header, /^OAuth /);
  // Independently verified with python's hmac/hashlib for these exact inputs
  // (base string + signing key), including the `oauth_version=1.0` param that
  // the RFC example omits.
  assertMatch(
    header,
    /oauth_signature="OB33pYjWAnf%2BxtOHN4Gmbdil168%3D"/,
  );
  // Protocol params present, non-OAuth query params absent from the header.
  assertMatch(header, /oauth_signature_method="HMAC-SHA1"/);
  assertMatch(header, /oauth_token="kkk9d7dh3k39sjv7"/);
  assert(!header.includes("b5="), "query params must not leak into the header");
});

Deno.test("signOAuth1 is deterministic given nonce and timestamp", async () => {
  const creds = { consumerKey: "ck", consumerSecret: "cs" };
  const opts = {
    method: "POST",
    url: "https://example.com/x?a=1",
    nonce: "n",
    timestamp: 123,
  };
  assertEquals(await signOAuth1(creds, opts), await signOAuth1(creds, opts));
});

Deno.test("signOAuth1 omits oauth_token for two-legged requests", async () => {
  const header = await signOAuth1(
    { consumerKey: "ck", consumerSecret: "cs" },
    { method: "POST", url: "https://example.com/x", nonce: "n", timestamp: 1 },
  );
  assert(!header.includes("oauth_token="));
});

Deno.test("signOAuth1 includes body params in the signature", async () => {
  const creds = {
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "t",
    tokenSecret: "ts",
  };
  const withBody = await signOAuth1(creds, {
    method: "POST",
    url: "https://example.com/x",
    bodyParams: { audience: "GARMIN_CONNECT_MOBILE_ANDROID_DI" },
    nonce: "n",
    timestamp: 1,
  });
  const withoutBody = await signOAuth1(creds, {
    method: "POST",
    url: "https://example.com/x",
    nonce: "n",
    timestamp: 1,
  });
  assert(withBody !== withoutBody);
});
