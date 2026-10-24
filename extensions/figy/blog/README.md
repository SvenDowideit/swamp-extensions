# @figy/blog

Render Markdown posts from Obsidian and publish them to Cloudflare Pages. DNS
is managed by a dedicated Caddy DNS model created automatically by the
workflow from your existing Caddy model. No GitHub repository is used.

## What it does

One workflow, `@figy/blog`, provisions its own Python environment, renders
Obsidian Markdown Markdown posts, creates a direct-upload Cloudflare Pages
project, uploads the rendered directory, binds the custom domain, creates an
isolated Caddy DNS model by reading the existing Caddy model, writes the
Pages CNAME, reconciles DNS, and verifies the public URL.

## Install

```sh
swamp extension pull @figy/blog
```

## Configuration

### Cloudflare token creation and permissions

This token is used only for Cloudflare Pages project creation, deployment, and
domain binding. It is not the DNS provider token.

1. Open the Cloudflare Dashboard.
2. Go to Profile -> API Tokens -> Create Token.
3. Choose Create Custom Token.
4. Set a name, for example `figy-blog`.
5. Permissions:
   - Account -> Cloudflare Pages -> Edit
   (Zone permissions are only needed if Cloudflare itself manages DNS; Caddy owns DNS here)
6. Account resources: select the account that owns the Pages project.
7. Zone resources: select the zones needed for metadata or all zones.
8. Create the token and copy it immediately because Cloudflare shows it only
   once.
9. Store it with the account ID:

```sh
swamp vault create local_encryption figy-cloudflare-pages
swamp vault put figy-cloudflare-pages CLOUDFLARE_API_TOKEN
swamp vault put figy-cloudflare-pages CLOUDFLARE_ACCOUNT_ID
```

### Caddy DNS model

Keep the DNS provider secret inside the existing Caddy model's environment
file. The workflow reads `caddyModel`, creates `dnsModel` if it does not exist,
copies base `target`, `serviceName`, `plugins`, `letsEncryptEmail`, and
`environmentFile`, and assigns the Pages CNAME to `dnsRecords`.

You can still point `dnsModel` at an existing Caddy model that already has the
Pages CNAME in its `dnsRecords`.

The Pages CNAME format is:

```json
{"name":"blog.x1yoga.fi.gy","type":"CNAME","value":["figy-blog.pages.dev"],"zone":"fi.gy"}
```

### Workflow inputs

| Input | Meaning |
| --- | --- |
| `blogDir` | Absolute Obsidian directory of Markdown posts |
| `publishDir` | Absolute rendered Pages directory |
| `hostname` | Full blog hostname |
| `vaultName` | Vault name, default `figy-cloudflare-pages` |
| `caddyModel` | Existing Caddy model copied by the workflow |
| `dnsModel` | Isolated Caddy model created by the workflow |
| `cloudflareTokenRef` | Vault key for the token |
| `cloudflareAccountIdRef` | Vault key for the account ID |

## Examples

### Full end-to-end test

Create posts:

```sh
mkdir -p /home/sven/src/obsidian/blog /home/sven/src/swamp-project/blog
cat > /home/sven/src/obsidian/blog/2026-10-24-hello.md <<'MD'
---
title: Hello
date: 2026-10-24
slug: hello
excerpt: First post
---

# Hello
<!-- blog:content:start -->
Hello from Caddy-managed Pages DNS.
<!-- blog:content:end -->
MD
```

Create the token vault and account:

```sh
swamp vault create local_encryption figy-cloudflare-pages
swamp vault put figy-cloudflare-pages CLOUDFLARE_API_TOKEN
swamp vault put figy-cloudflare-pages CLOUDFLARE_ACCOUNT_ID
```

Ensure the existing Caddy model has the provider settings and environment file.

Validate and run:

```sh
swamp workflow validate @figy/blog
swamp workflow run @figy/blog \
  --input blogDir=/home/sven/src/obsidian/blog \
  --input publishDir=/home/sven/src/swamp-project/blog \
  --input hostname=blog.x1yoga.fi.gy \
  --input vaultName=figy-cloudflare-pages \
  --input caddyModel=my-caddy \
  --input dnsModel=blog-caddy
```

Manual verification:

```sh
curl -I https://blog.x1yoga.fi.gy/
```

The workflow provisions Python, renders, creates the Pages project, deploys,
binds the domain, creates the isolated Caddy DNS model, reconciles DNS, and
performs an HTTPS HEAD check.

### Validate the DAG first

```sh
swamp workflow validate @figy/blog
```

Checking the DAG avoids bad inputs before Pages or Caddy changes.

### Test each service directly

```sh
swamp model method run blog-pages createProject --input name=figy-blog
swamp model method run blog-pages deployDirect \
  --input projectName=figy-blog --input directory=/home/sven/src/swamp-project/blog
swamp model method run blog-pages bindDomain \
  --input projectName=figy-blog --input domain=blog.x1yoga.fi.gy
swamp model method run blog-caddy applyDnsRecords
```

Use these only for isolated service debugging.

## Upgrade

```sh
swamp extension update
```

Nothing is installed on the host, so updating code is enough.

## Details

Models driven: `@svendowideit/markdown2html`,
`@svendowideit/cloudflare-pages-wrangler`, `@svendowideit/caddy`, and
`@svendowideit/curl`. Workflow: `@figy/blog`.

The token and account ID are stored in a named vault. Caddy DNS provider
credentials stay in the Caddy environment file. No Git repository, Python, or
drag-and-drop upload is required. Markdown files can use optional frontmatter;
the site also gets a generated index page.
