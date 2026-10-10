# @svendowideit/curl

A tracked `curl` wrapper. Every request records what went out (method, URL,
applied headers, cookies, body) and what came back (status, all response header
blocks including redirects, cookies set, body, timing, argv, exit code, stderr),
with secrets masked by default. A per-instance cookie jar optionally reuses a
session across requests.

## What it does

- **Records the whole exchange** — `request` captures the request method, the
  URL (requested and effective), the headers the wrapper applied, the cookies
  sent and received, every response header block (so a redirect chain is
  visible), the response body, the round-trip time, the exact curl argv, the
  exit code and stderr.
- **Masks secrets by default** — `Authorization`, `Proxy-Authorization`,
  `X-Api-Key`, `Cookie`, `Set-Cookie` and `X-Auth-Token` header values, cookie
  values and the `--user`/`--cookie` arguments are replaced with `***` in the
  record. Configure the list with `redactHeaders` / `redactCookieValues`.
- **Carries a session** — a Netscape cookie jar per model instance
  (`cookieJar`, default `<stateDir>/<modelName>/cookies.txt`) persists cookies
  between runs. `reuseCookies` (default true) sends the jar back on the next
  request, so a login followed by authenticated calls is just two method runs.
  `cookie-jar` inspects or clears it.
- **Any HTTP shape** — arbitrary method, query parameters, raw/JSON/file/form
  bodies, extra headers, basic auth (`user`) and bearer tokens. Choose to fail
  the run on a non-2xx (`failOnHttpError`) or a curl transport error
  (`failOnCurlError`) while still writing the record first.

Side effects: it runs the `curl` binary, reads and writes the cookie jar under
`stateDir`, optionally writes a response body to an `outputFile` path, and
writes swamp resources (`request`, `cookieJar`) and files (`body`). Nothing is
installed on the host.

## Install

```sh
swamp extension pull @svendowideit/curl
```

The `curl` binary must be on `PATH` (or set the `curlPath` global argument).
No other swamp extension is required.

## Configuration

Global arguments (set at model creation with `--global-arg key=value`):

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `curlPath` | string | `curl` | Path to the curl binary, or its name on `PATH`. |
| `stateDir` | string | `~/.swamp/curl` | Root for the derived per-instance cookie jar. |
| `cookieJar` | string | `""` | Explicit jar path; empty derives `<stateDir>/<modelName>/cookies.txt`. |
| `reuseCookies` | boolean | `true` | Send cookies already stored in the jar. |
| `userAgent` | string | `swamp-curl/1.0 (curl wrapper)` | User-Agent when a request sets none. |
| `defaultHeaders` | string[] | `[]` | Headers applied to every request (`"Name: Value"`). |
| `followRedirects` | boolean | `true` | Follow redirects (curl `--location`). |
| `maxRedirects` | number | `10` | Maximum redirects to follow. |
| `insecure` | boolean | `false` | Skip TLS verification (curl `--insecure`). |
| `timeoutMs` | number | `30000` | Total request timeout. |
| `connectTimeoutMs` | number | `10000` | Connection timeout. |
| `maxBodyBytes` | number | `262144` | Bytes of a body recorded in the resource (`0` = none). |
| `redactHeaders` | string[] | `[authorization, …]` | Header names whose values are masked. |
| `redactCookieValues` | boolean | `true` | Mask cookie values in the record. |

Per-call arguments for `request` / `get` / `post`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `url` | string | — | URL to request (required). |
| `method` | string | `""` | HTTP method; empty = POST when a body is supplied, otherwise GET. |
| `headers` | string[] | `[]` | Extra headers for this request. |
| `query` | record | `{}` | Query parameters appended to the URL. |
| `data` | string | — | Raw body, sent byte-for-byte and recorded (truncated). |
| `dataJson` | any | — | Body serialized as JSON; sets `Content-Type: application/json`. |
| `dataFile` | string | — | File sent as the body; its content is not read into the record. |
| `form` | record | — | Form fields as `application/x-www-form-urlencoded`. |
| `cookies` | string[] | `[]` | Cookies to send for this request (`"name=value"`). |
| `user` | string | — | `user:password` for basic auth (sensitive). |
| `bearerToken` | string | — | Bearer token added as `Authorization` (sensitive). |
| `label` | string | `""` | Name for the record / saved body; empty = generated. |
| `saveBody` | boolean | `false` | Store the full body as a `body` file resource. |
| `outputFile` | string | `""` | Also write the body to this path. |
| `maxBodyBytes` | number | — | Override the recorded-body cap. |
| `reuseCookies` / `followRedirects` / `insecure` / `timeoutMs` | — | — | Per-request overrides. |
| `failOnHttpError` | boolean | `false` | Fail on a 400+ final status (record still written). |
| `failOnCurlError` | boolean | `false` | Fail on a non-zero curl exit (record still written). |

`cookie-jar` takes `clear` (boolean, delete the jar) and `raw` (boolean,
include the raw jar text in the record).

## Examples

```sh
# A plain GET. The record lands as a `request` resource on the `http` model.
swamp model @svendowideit/curl method run request http \
  --input url="https://api.github.com/repos/denoland/deno"

# POST JSON and fail the run on a 4xx/5xx (the record is written first).
swamp model @svendowideit/curl method run post http \
  --input url="https://httpbin.org/post" \
  --input 'dataJson:json={"hello":"world"}' \
  --input failOnHttpError=true

# Send an API key without ever storing it in the record (header values are
# masked), and save the full response body as a `body` file resource.
swamp model @svendowideit/curl method run request http \
  --input url="https://api.example.org/things" \
  --input headers='["X-Api-Key: ${{ vault.get(\"api-secrets\",\"KEY\") }}"]' \
  --input saveBody=true

# Reuse a session: log in once, then call an authenticated endpoint. The jar
# persists between the two runs under stateDir.
swamp model @svendowideit/curl method run post http \
  --input url="https://example.org/login" \
  --input 'form:json={"user":"me","pass":"pw"}' \
  --input label=login
swamp model @svendowideit/curl method run get http \
  --input url="https://example.org/me" \
  --input label=whoami

# Inspect the jar (which cookies are stored, and from where), then clear it.
swamp model @svendowideit/curl method run cookie-jar http --input raw=true
swamp model @svendowideit/curl method run cookie-jar http --input clear=true
```

## Upgrade

This extension installs nothing on the host — no services, daemons, cron
triggers or webhooks — so an upgrade has nothing to rebuild or reconcile.
Refresh the pulled model type and its bundled files with one idempotent
command:

```sh
swamp extension update
```

Existing model definitions record the version they were created with; the
model's bundled `upgrades` entry migrates them automatically on the next
method run, and neither swamp data nor the cookie jar is touched.

## Details

`@svendowideit/curl` ships one model type (`@svendowideit/curl`) with four
methods:

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `request` | the per-call table above | a `request` resource (full in/out record); a `body` file when `saveBody` |
| `get` | same as `request` | a `request` resource, method forced to GET |
| `post` | same as `request` | a `request` resource, method forced to POST |
| `cookie-jar` | `clear`, `raw` | a `cookieJar` resource (path, count, parsed cookies) |

### Resources

- **`request`** — one record per call, keyed by `label` (or a generated
  `req-<hash>` name). Fields include `method`, `url`, `effectiveUrl`, `status`,
  `statusText`, `ok`, `requestHeaders`, `requestBody`, `requestBodyBytes`,
  `cookiesSent`, `cookiesReceived`, `responseHeaders`, `redirects`, `body`,
  `bodyBytes`, `bodyTruncated`, `outputFile`, `timingMs`, `curlExitCode`,
  `stderr`, `command`, `startedAt` and `finishedAt`. Query it with
  `data.latest("http", "<label>")`, e.g.
  `data.latest("http", "whoami").attributes.status`.
- **`cookieJar`** — `cookie-jar` output: `path`, `exists`, `count`, `cookies`
  and `cleared` (plus `raw` when requested).
- **`body`** — a file resource holding the full response body when `saveBody`
  is set; reach it via `data.latest("http", "body-<label>").path`.

### Cookie jar layout

```
<stateDir>/<modelName>/cookies.txt
```

`cookieJar` overrides the location. The jar is Netscape format, so it is
readable by curl and by other tools. Cookies received during a request are
always written back; they are only *sent* on later requests when
`reuseCookies` is true.

### Recorded vs. actual request headers

`requestHeaders` lists the headers this wrapper applied (defaults, per-call
headers, User-Agent, and `Authorization`/`Content-Type` injected for
`bearerToken`/`dataJson`). curl additionally adds transport headers of its own
(`Host`, `Content-Length`, `Accept`, …) which are not listed; `command` gives
the exact curl argv if you need to reconstruct the full picture. `cookiesSent`
is exact for explicit cookies and approximate for jar cookies (it applies
domain/path/expiry matching, not curl's full rules).

### Structure and testing

- `curl.ts` — the model. Pure, exported helpers (`parseHeaderBlocks`,
  `parseSetCookie`, `parseCookieJar`, `cookieMatches`, `buildCurlArgs`,
  `redactArgv`, `decodeCapped`, …) carry the parsing and command-building
  logic; `runRequest` wires them to a subprocess. Add a new body source or arg
  in `resolveBody`/`buildCurlArgs` and cover it in the test file.
- `curl_test.ts` — colocated tests. Unit tests cover the parsers and argv
  builder; integration tests start a local `Deno.serve` and run the real `curl`
  binary against it, asserting the recorded status, headers, cookies, redirect
  chain, saved body and failure modes.

```sh
~/.swamp/deno/deno test --allow-read --allow-write --allow-env \
  --allow-run --allow-net --allow-ffi \
  extensions/models/curl/curl_test.ts
```

## License

MIT — see LICENSE.txt.
