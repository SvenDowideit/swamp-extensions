# @svendowideit/wikipedia

A **fetch-free** Wikipedia/Wikidata domain client. It builds URLs and request
plans, reads the shared web cache, and parses the result. It never opens an
HTTPS connection itself.

A page can be cached in **two** places:

- the **public MediaWiki URL** (opensearch, action=parse, REST, query), or
- the synthetic **Wikimedia Enterprise article URL**
  (`/v2/articles/{name}?limit=1&filters=…`).

Every read method checks the public cache first, then the Enterprise cache, and
parses whichever shape it finds.

## What it does

- **Works without an account.** Public-API misses are fetched and cached by
  [`@svendowideit/web-cache`](../web-cache).
- **Upgrades to Wikimedia Enterprise.** When the `enterprise-wikimedia` vault
  holds credentials and the local monthly quota has room,
  `@svendowideit/wikipedia-fetch-page` gets an enterprise article through
  `web-cache` using a 0600 bearer-token file. The login/refresh POST goes
  through [`@svendowideit/curl`](../curl).
- **Knows both cache locations.** `get-page`, `get-infobox` and
  `get-page-props` read the public URL first and fall back to the Enterprise
  URL, converting the Enterprise payload into the public response shape.
- **Respects a run budget.** `web-cache` shares one `budgetId`/`maxFetches`
  budget across every public and Enterprise fetch in an ebook-scan run.
- **Parses many formats.** Wikitext (default), HTML, Parsoid, REST summary,
  action-API JSON, opensearch results, page-props and infoboxes.

## Install

```bash
swamp extension pull @svendowideit/wikipedia
```

`@svendowideit/web-cache` is a declared dependency and is pulled automatically.
`@svendowideit/curl` is needed only for Enterprise login/refresh.

## Examples

```bash
# 1. Read a page that is already in the shared cache (public or Enterprise).
swamp model @svendowideit/wikipedia method run get-page wiki \
  --input title="Alfred Bester" --input format=wikitext
```

```bash
# 2. Fetch + parse through the normal workflow. With no Enterprise credentials
#    the miss is fetched from the public API through web-cache.
swamp workflow run @svendowideit/wikipedia-page \
  --input title="Alfred Bester" --input format=wikitext
```

```bash
# 3. Check whether Enterprise is ready and how much local quota remains.
#    This makes no request and prints no secret.
swamp model @svendowideit/wikipedia method run enterprise-status wiki
```

```bash
# 4. Store Enterprise credentials in the default vault. The values are prompted
#    for (or piped on stdin); swamp vault names cannot contain underscores.
swamp vault create local_encryption enterprise-wikimedia
swamp vault put enterprise-wikimedia username
swamp vault put enterprise-wikimedia password
```

```bash
# 5. The same page workflow now prefers Enterprise on a cache miss, but never
#    fetches directly: web-cache GETs the Enterprise URL with a bearer token,
#    and curl performs the one-off login POST when needed.
swamp workflow run @svendowideit/wikipedia-page \
  --input title="Alfred Bester" --input format=wikitext \
  --input maxFetches=5
```

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `cacheDir` | `~/.swamp/web-cache` | Shared cache dir (web-cache compatible) |
| `apiUrl` | `https://en.wikipedia.org/w/api.php` | Public MediaWiki action API |
| `restUrl` | `https://en.wikipedia.org/api/rest_v1` | Public REST v1 base |
| `enterpriseVaultName` | `enterprise-wikimedia` | Vault checked for credentials |
| `enterpriseUsernameKey` | `username` | Vault key for the username |
| `enterprisePasswordKey` | `password` | Vault key for the password |
| `enterpriseAccessTokenKey` | `access_token` | Vault key for a JWT access token |
| `enterpriseRefreshTokenKey` | `refresh_token` | Vault key for a refresh token |
| `enterpriseApiUrl` | `https://api.enterprise.wikimedia.com` | Enterprise On-demand API |
| `enterpriseAuthUrl` | `https://auth.enterprise.wikimedia.com` | Enterprise auth API |
| `enterpriseProject` | `enwiki` | Enterprise project filter |
| `enterpriseMonthlyQuota` | `50000` | Local monthly lookup budget; `0` = no local cap |

The `wikipedia-page` and `wikipedia-infobox` workflows also take `maxFetches`
(run-level origin budget), `budgetId` (the workflow run id that shares it), and
`runId` (namespaces private plan files).

## Enterprise flow

`@svendowideit/wikipedia-fetch-page` performs:

1. `enterprise-plan` — reads the vault, session and quota; writes a public or
   Enterprise plan. If a login/refresh is needed it writes a 0600 JSON request
   body; if a token is already available it writes a 0600 token file.
2. `curl.request` — POSTs the login/refresh request (request body supplied via
   `dataFile`, so it is not recorded; response body written to a private file).
3. `enterprise-session` — parses the response, updates the sensitive session
   resource and writes the 0600 bearer-token file.
4. `web-cache.get` — GETs the Enterprise article URL with
   `bearerTokenFile`, caching the raw article under the Enterprise URL.
5. `enterprise-record` — counts the successful lookup against the monthly quota.
6. `cleanup` — removes the private plan/token directory.

The public fallback is also a `web-cache.get`. Auth failures and Enterprise
fetch failures set short cooldowns so the next plan backs off.

## Details

### Model: `@svendowideit/wikipedia`

| Method | Description |
| --- | --- |
| `get-page` | Parse a page from the public or Enterprise cache. |
| `get-infobox` | Extract an infobox from either cached wikitext. |
| `get-page-props` | Resolve titles from the public batch cache or a single-title Enterprise entry. |
| `search` | Parse a cached public opensearch response. |
| `page-url` / `search-url` / `page-props-url` | Build public URLs without fetching. |
| `enterprise-plan` | Write a public/Enterprise plan; no request. |
| `enterprise-session` | Persist a login/refresh response and token file. |
| `enterprise-record` | Record one successful Enterprise lookup. |
| `enterprise-failure` | Record an auth or rate-limit cooldown. |
| `enterprise-cleanup` | Remove private plan files. |
| `enterprise-status` | Read-only credential/quota readiness report. |

Results include `source`: `public-cache`, `enterprise-cache`, or `none`.

### Data resources

- `page`, `search`, `infobox`, `page-props` — parsed outputs.
- `url` — a built public URL.
- `enterprise-plan` — the public/Enterprise plan and private file paths.
- `enterprise-session` — JWT session; token fields are sensitive.
- `enterprise-session-result` — login/refresh outcome.
- `enterprise-usage` — monthly counter and cooldown state.
- `enterprise-status` — the readiness report.

### Web-cache compatibility

The cache layout is `@svendowideit/web-cache`'s: `<cacheDir>/<url-slug>-<fnv1a>/`
with `body` and `meta.json`. Public and Enterprise URLs are separate entries.
The run budget lives at `<cacheDir>/.fetch-budget-<budgetId>.json` and is
consumed only by origin fetches, never by cache hits.

## Testing

```bash
~/.swamp/deno/deno test --allow-read --allow-write --allow-env \
  extensions/models/wikipedia/
```

Coverage includes URL builders, parsers, both cache locations, Enterprise
planning (access token/login/refresh), quota/cooldowns, session persistence,
and the `maxFetches` budget in `web-cache`. Tests make no network requests.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
