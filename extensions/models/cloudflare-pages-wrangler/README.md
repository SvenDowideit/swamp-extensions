# @svendowideit/cloudflare-pages-wrangler

Direct-upload Cloudflare Pages deployment and custom-domain binding without a
Git repository. It wraps the supported Wrangler direct-upload workflow behind
typed swamp methods.

## What it does

This extension creates a direct-upload Pages project, deploys a local directory
through Wrangler, and binds a custom domain. It keeps account and token handling
inside model arguments and writes all results as swamp resources.

## Install

```sh
swamp extension pull @svendowideit/cloudflare-pages-wrangler
```

## Configuration

Global configuration:

| Argument | Required | Meaning |
| --- | --- | --- |
| `accountId` | yes | Cloudflare account ID |
| `apiToken` | yes | Pages-editing Cloudflare API token |
| `productionBranch` | no | Production branch label, default `main` |

Method configuration:

| Method | Arguments |
| --- | --- |
| `createProject` | `name`, optional `productionBranch` |
| `deployDirect` | `projectName`, `directory`, optional `branch` |
| `bindDomain` | `projectName`, `domain` |

## Examples

```sh
# Create a direct-upload Pages project.
swamp model method run pages createProject --input name=figy-blog
```

Run this once per site; it creates an empty direct-upload project with no Git
source.

```sh
# Upload the rendered static directory.
swamp model method run pages deployDirect --input projectName=figy-blog --input directory=/home/me/site
```

Use this after each render; Wrangler handles the actual direct upload.

```sh
# Bind the custom domain to the Pages project.
swamp model method run pages bindDomain --input projectName=figy-blog --input domain=blog.example.com
```

Run after DNS is prepared so Pages can serve the custom domain.

## Details

Model type: `@svendowideit/cloudflare-pages-wrangler`.

Methods:

- `@svendowideit/cloudflare-pages-wrangler.createProject`
- `@svendowideit/cloudflare-pages-wrangler.deployDirect`
- `@svendowideit/cloudflare-pages-wrangler.bindDomain`

## Upgrade

```sh
swamp extension update
```

This extension installs nothing on the host, so updating the code is enough.
