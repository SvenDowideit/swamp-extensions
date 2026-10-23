# @svendowideit/dreamhost

Manage **DreamHost DNS records** through the official API, and publish **static
sites** to DreamHost shared hosting over SSH/rsync, both as swamp models.

## What this does and does not do

DreamHost removed the account, domain, mail, database, and user commands from
their API. As of 2026 the live API (`api.dreamhost.com`) exposes only:

- `dns-list_records`, `dns-add_record`, `dns-remove_record`
- `announcement_list-*`
- `api-list_accessible_cmds`, `api-list_keys`

There is no public successor API, and no way to create or configure sites,
domains, or email addresses programmatically. This extension is honest about
that: it covers the two things that *are* automatable.

| Capability | Model | Mechanism |
| --- | --- | --- |
| DNS records (list/add/remove/reconcile) | `@svendowideit/dreamhost/dns` | Official DreamHost API |
| Publish static sites | `@svendowideit/dreamhost/site` | rsync over SSH |
| Domains, web/email account config | — | No public API exists |

## Installation

```sh
swamp extension pull @svendowideit/dreamhost
```

## DNS: `@svendowideit/dreamhost/dns`

Store the API key in a vault first. Generate a key in the DreamHost panel
(**Home → API**) and grant it the DNS commands you need.

```sh
swamp model create @svendowideit/dreamhost/dns my-dns \
  --global-arg 'authToken=${{ vault.get("dreamhost", "API_KEY") }}'
```

### Methods

| Method | Description |
| --- | --- |
| `listRecords` | Fetch every DNS record, optionally filtered to one `zone`. |
| `listZones` | Derive hosted zones (and their record counts) from the records. |
| `listCommands` | Show which API commands the key may access (diagnostics). |
| `addRecord` | Add one record. |
| `removeRecord` | Remove one record by exact record/type/value. |
| `syncRecords` | Idempotently reconcile a desired record set for a zone. |

Short record names are resolved against the zone: `@` and the bare zone name
are the apex, `www` becomes `www.<zone>`, and a fully-qualified name is kept
as-is.

```sh
# List zones and records
swamp model method run my-dns listZones
swamp model method run my-dns listRecords --input zone=example.com

# Add and remove
swamp model method run my-dns addRecord \
  --input record=www --input type=A --input value=203.0.113.10 \
  --input zone=example.com
swamp model method run my-dns removeRecord \
  --input record=www --input type=A --input value=203.0.113.10 \
  --input zone=example.com

# Reconcile a desired set; prune removes editable records not listed.
swamp model method run my-dns syncRecords \
  --input zone=example.com \
  --input 'records=[{"record":"@","type":"A","value":"203.0.113.10"},{"record":"www","type":"CNAME","value":"example.com"}]' \
  --input prune=true

# Preview the diff
swamp model method run my-dns syncRecords \
  --input zone=example.com --input 'records=[]' \
  --input prune=true --input dryRun=true
```

`syncRecords` never touches records DreamHost manages (`editable: false`);
they are reported as `protectedSkipped`. Writes are sent with a per-call
`unique_id`, so a retried command is not applied twice. When DreamHost rate
limits a call it returns `slow_down_bucko`; the model surfaces this as an
error rather than retrying blindly.

## Site publishing: `@svendowideit/dreamhost/site`

DreamHost shared hosting serves each domain from a directory in a shell user's
home (for example `~/example.com`). This model rsyncs a local directory into
that web root, so only changed files are transferred.

```sh
swamp model create @svendowideit/dreamhost/site my-site \
  --global-arg host=example.com \
  --global-arg user=myshelluser \
  --global-arg remotePath='~/example.com/' \
  --global-arg identityFile='~/.ssh/dreamhost'
```

Key auth is recommended; an inline key can come from a vault:

```sh
--global-arg 'identityContent=${{ vault.get("dreamhost", "SSH_KEY") }}'
```

Password auth is supported (`--global-arg 'password=${{ vault.get(...) }}'` via
`sshpass`) but is best avoided.

### Methods

| Method | Description |
| --- | --- |
| `deploy` | rsync a local directory to the web root; reports added/modified/deleted counts. |
| `check` | Verify SSH connectivity and whether the remote path exists. |
| `inspect` | List the remote web root: file count, directory count, total bytes. |

```sh
# Verify access first
swamp model method run my-site check

# Publish ./dist, deleting remote files absent locally
swamp model method run my-site deploy \
  --input localPath=./dist --input delete=true

# Preview without transferring
swamp model method run my-site deploy \
  --input localPath=./dist --input dryRun=true
```

`deploy` uses `rsync -a --itemize-changes --stats`, and parses the itemized
output into a per-file summary. Directory entries are ignored so the change
count reflects files only. `--delete` is opt-in because deleting from a live
web root is destructive.

### Configuration

| Global argument | Default | Description |
| --- | --- | --- |
| `host` | — | SSH host (domain, server hostname, or SSH config alias). |
| `user` | — | DreamHost shell username. |
| `remotePath` | — | Remote web root, e.g. `~/example.com/`. |
| `port` | `22` | SSH port. |
| `identityFile` | unset | Path to an SSH private key. |
| `identityContent` | unset | Inline private key (vault expression). |
| `password` | unset | SSH password (vault expression; needs `sshpass`). |
| `sshOptions` | `[]` | Extra `ssh -o` options. |
| `excludes` | `[]` | Default rsync exclude patterns. |
| `rsyncArgs` | `[]` | Extra rsync arguments. |
| `remoteCommand` | `rsync` | Remote rsync binary. |

Inline keys are written to a mode-0600 file for the duration of a run and
removed afterwards. The remote command paths built for `check` and `inspect`
are single-quoted. For `deploy`, rsync's own remote-path escaping is relied on
(it escapes `;`, `$`, backticks, and spaces, so command injection is not
possible); note that rsync leaves glob characters such as `*` unescaped, so
avoid wildcards in `remotePath`.

## Output data

Each method writes a versioned resource that other models and workflows can
reference with CEL:

```yaml
# Count of editable DNS records in the zone
records: ${{ data.latest("my-dns", "records").attributes.editableCount }}
# Whether the last deploy changed anything
changed: ${{ data.latest("my-site", "deploy").attributes.changed }}
# Files deleted by the last deploy
deleted: ${{ data.latest("my-site", "deploy").attributes.deleted }}
```

## Requirements

- DNS: a DreamHost API key with DNS command access; network access to
  `api.dreamhost.com`.
- Site: an SSH/SFTP shell user on the DreamHost account; `rsync` and `ssh`
  locally (`rsync` is preinstalled on DreamHost servers); `sshpass` only for
  password auth.

## License

MIT — see LICENSE for details.

## What it does

This extension inventories DreamHost shell accounts over SSH and manages
DreamHost DNS records through the official API. It focuses on safe,
read-before-retire discovery: home-directory manifests, configuration and
database-reference discovery, mail directory inventory, repository metadata,
special files, and crontab hints. Static site publishing is also available
for rsync-based transfers when a deploy is explicitly requested.

## Install

```sh
swamp extension pull @svendowideit/dreamhost
```

## Configuration

The SSH models use the global arguments `host`, `user`, `port`,
`identityFile`, `identityContent`, `password`, `sshOptions`, `excludes`,
`rsyncArgs`, and `remotePath`. The DNS model requires an `authToken`.
Create models with `--global-arg`, preferably using vault expressions for
secrets.

## Examples

Create the inventory behavior once, then confirm account basics before archive work:

```sh
swamp model create @svendowideit/dreamhost/inventory dreamhost-inventory \
  --global-arg host=dreamhost.example --global-arg user=myshelluser
swamp model method run dreamhost-inventory accountInfo
```

Build the recursive manifest used to verify backup coverage:

```sh
swamp model method run dreamhost-inventory homeManifest \
  --input maxEntries=100000
```

Export DNS records for cutover planning:

```sh
swamp model create @svendowideit/dreamhost/dns dreamhost-dns \
  --global-arg 'authToken=${{ vault.get("dreamhost", "API_KEY") }}'
swamp model method run dreamhost-dns listZones
```

Fan out the full inventory across several shell usernames on one host:

```sh
swamp workflow run @svendowideit/dreamhost-inventory-all \
  --input host=dreamhost.example \
  --input 'usernames=["shell-user-one","shell-user-two"]'
```

Back up one account's remote files to a local directory:

```sh
swamp model method run dreamhost-inventory backup \
  --input localPath=./dreamhost-backup-fosiki
```

Verify the local backup against the recorded inventory manifest:

```sh
swamp model method run dreamhost-inventory verifyBackup \
  --input localPath=./dreamhost-backup-fosiki
```

## Upgrade

Nothing is installed on the host by this extension, so upgrading is limited
to refreshing the extension and its behavior definitions:

```sh
# Refresh an existing install after a release.
swamp extension update @svendowideit/dreamhost
```

Behavior definitions and their global arguments remain valid across releases;
workflow definitions (if any) are recreated and validated with
`swamp workflow validate` when the release notes require it.

## Details

Models:

- `@svendowideit/dreamhost/dns`: `listRecords`, `listZones`,
  `listCommands`, `addRecord`, `removeRecord`, `syncRecords`.
- `@svendowideit/dreamhost/inventory`: `accountInfo`, `homeManifest`,
  `findConfigs`, `databaseRefs`, `mailInventory`, `specialFiles`,
  `repositoryRoots`, `cronHints`, `backup`, `verifyBackup`.
- `@svendowideit/dreamhost/site`: `deploy`, `check`, `inspect`.

Workflow:

- `@svendowideit/dreamhost-inventory-all`: fan out the account, home
  manifest, configuration, database reference, mail, special-file, repository,
  and crontab inventory across several shell usernames on one host.

Inventory resources are intentionally redacted for secret values. The inventory
does not store file content checksums; `verifyBackup` compares recorded size,
modification time, mode, type, and symlink target rather than content hashes.
`backup` checks recorded inventory size against free space in the destination
filesystem and requires `--input approveDiskUsage=true` when the backup would
leave less than 10 percent free. rsync skips unchanged files by size and
modification time by default, so repeat backups do not resend identical files;
`--input checksum=true` forces checksum comparison instead.
Site deployment can delete remote files only when explicitly requested.
