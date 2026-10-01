# @svendowideit/systemd-creds

A swamp vault backend that stores secrets encrypted at rest using
`systemd-creds --user`, with one subdirectory per vault. No root required, no
desktop keychain daemon needed — just systemd v256+. Ships a companion
`@svendowideit/vault-migrate` model for moving secrets between vaults.

## What it does

Stores swamp vault secrets as AES256-GCM-encrypted `.cred` files via
`systemd-creds --user`. The encryption key is derived from your UID and the
host's machine-id, so an encrypted file copied to another machine or another
user will not decrypt. It protects **data at rest** only: a live compromise of
your user session can still run `systemd-creds --user decrypt`. Use it when you
want secrets that stay encrypted on disk without a running keychain daemon.

Each vault instance owns `<credstoreDir>/<vault name>/`, so two vaults never
share keys. A vault configured with `global: true` instead addresses the shared
`<credstoreDir>` itself — the location used by versions before per-vault
isolation (see [Migrating a pre-isolation install](#migrating-a-pre-isolation-install)).

> **Upgrading from a pre-isolation version:** your existing keys live in the
> shared `<credstoreDir>` root, so `swamp vault list-keys <vault>` will show an
> **empty list** for every vault — the keys belong to no single vault. Reads
> still work (a per-vault `get` falls back to the shared root), so nothing breaks.
> To see and manage the shared keys, create the `global: true` handle and follow
> the migration below.

## Install

```sh
swamp extension pull @svendowideit/systemd-creds
```

Requires **systemd v256 or higher** (the `--user` flag was added in v256):

```bash
systemctl --version
```

## Configuration

Set these when creating the vault, or in `.swamp.yaml` as `vault.config.*`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `credstoreDir` | string | `"~/.config/credstore"` | Base directory for the encrypted `.cred` files. A leading `~/` expands to `$HOME`. Each vault writes to `<credstoreDir>/<vault name>/`. |
| `global` | boolean | `false` | Address the shared `<credstoreDir>` itself instead of a per-vault subdirectory. This is the pre-isolation location, kept for backward compatibility and migration. |

## Examples

Create a named vault instance and store a secret:

```sh
# Create the vault instance backed by this extension.
swamp vault create @svendowideit/systemd-creds my-vault

# Store a secret — it is encrypted before reaching the filesystem, and the
# value is best piped or prompted so it never lands in the process arguments.
swamp vault put my-vault MY_API_KEY
```

Read secrets back and inspect them:

```sh
# Read a stored secret (prompts before revealing it in log mode).
swamp vault read-secret my-vault MY_API_KEY

# List key names only — never the values.
swamp vault list-keys my-vault
```

Configure a custom credstore directory:

```sh
# Point the vault at a project-local credstore instead of the default.
swamp vault create @svendowideit/systemd-creds project-vault \
  --config '{"credstoreDir":"~/.config/credstore-project"}'
```

Address the shared pre-isolation store as a vault and inspect it:

```sh
# Create a handle to the shared legacy directory (create once).
swamp vault create @svendowideit/systemd-creds legacy \
  --config '{"global":true}'

# See the shared keys — the ones every pre-isolation vault used to list.
swamp vault list-keys legacy
```

Migrate **one secret at a time** — the usual case, since the flat store never
recorded which vault each key belonged to. `keys` is a JSON array of key names:

```sh
# Dry run first: show what copying MY_API_KEY would do. Writes nothing.
swamp model method run @svendowideit/vault-migrate plan vault-migrate \
  --input from=legacy --input to=my-vault --input 'keys=["MY_API_KEY"]'

# Move that one key: copy to my-vault, then delete it from the shared store.
swamp model method run @svendowideit/vault-migrate migrate vault-migrate \
  --input from=legacy --input to=my-vault --input 'keys=["MY_API_KEY"]'
```

Repeat per vault — route each shared key to the vault it belongs to. Move
several at once with a longer array, and add `force=true` to overwrite a name
that already exists in the target:

```sh
# Move two keys together; force overwrites a clashing name in the target.
swamp model method run @svendowideit/vault-migrate migrate vault-migrate \
  --input from=legacy --input to=my-vault --input force=true \
  --input 'keys=["API_KEY","API_SECRET"]'

# Or, if you truly want them all in one vault, omit `keys` to move everything.
swamp model method run @svendowideit/vault-migrate migrate vault-migrate \
  --input from=legacy --input to=my-vault
```

## Details

The extension ships **one vault backend** (`@svendowideit/systemd-creds`) and
**one companion model** (`@svendowideit/vault-migrate`).

### Vault backend methods

The provider shells out to `systemd-creds --user`:

| Method | What it does | Notes |
| ------ | ------------ | ----- |
| `put` | `systemd-creds --user encrypt - <vault>/<key>.cred` | Value piped on stdin; encrypted before it hits disk. Always writes to the vault's own subdirectory. |
| `get` | `systemd-creds --user decrypt <file> -` | Reads the vault's own `<key>.cred`, falling back to the shared global dir so pre-isolation keys keep resolving. Throws with systemd's stderr on failure. |
| `list` | reads the vault's own subdirectory for `*.cred` | Returns sorted key names only. A per-vault listing does **not** include global keys; address those with a `global: true` vault. |
| `delete` | removes the vault's own `<key>.cred` | Needed for `swamp vault delete` to work. A key that lives only in the shared global dir is refused — no single vault owns it. |
| `getName` | — | Returns the vault instance name passed to the provider. |

### `@svendowideit/vault-migrate`

A small model for moving or copying secrets **between two vaults**. swamp's own
`swamp vault migrate` only changes a vault's *backend type*; it cannot move keys
between two vaults of the same type, which is what relocating pre-isolation
secrets requires. This model reads values through the vault service, so it works
between **any** two vaults, not only systemd-creds ones.

| Method | Arguments | Produces |
| ------ | --------- | -------- |
| `plan` | `from` (string), `to` (string), `keys` (string[], optional), `force` (boolean, default false) | a `result` resource describing what a migrate would copy, skip, or the source's delete support. Writes nothing. |
| `migrate` | as `plan`, plus `deleteSource` (boolean, default true) | a `result` resource: per-key action, counts, and a summary. Copies then (by default) deletes from the source. |

Behaviour:

- **`deleteSource: true`** (default) moves keys — copy, then delete from source.
- **`deleteSource: false`** copies and leaves the source intact.
- **`force: false`** (default) skips keys already present in the target;
  `force: true` overwrites them.
- If the source vault does not support delete, the move degrades to a copy and
  says so in the summary rather than failing.
- A key that fails to **copy** is recorded with its error and the remaining keys
  still migrate. A key that copies but whose **source-delete** fails is recorded
  as `copied-delete-failed` and counted as copied, not failed — the value is
  already safe in the target.

### Storage layout

```
~/.config/credstore/                  # credstoreDir (shared root, no keys by default)
  my-vault/                           # per-vault directory (this vault's keys)
    MY_API_KEY.cred
  legacy.cred                         # a pre-isolation key (shared, ambiguous owner)
```

- New secrets always go to the vault's own subdirectory.
- `get` falls back to the shared root, so references written before isolation
  keep working.
- `list-keys` reports only the vault's own keys, so each vault shows its own set.
- The shared root is never written to unless the vault is configured
  `global: true`.

### Migrating a pre-isolation install

Before per-vault isolation, every `systemd-creds` vault shared one flat
directory, so every vault listed every key. Because that directory never recorded
which vault a key was intended for, migrate **one secret at a time** — routing
each key to the vault it belongs to.

```sh
# 1. Create a handle to the shared directory and list what is in it.
swamp vault create @svendowideit/systemd-creds legacy --config '{"global":true}'
swamp vault list-keys legacy

# 2. Dry-run one key to the target vault (add `keys` to scope it; without it,
#    plan covers every shared key).
swamp model method run @svendowideit/vault-migrate plan vault-migrate \
  --input from=legacy --input to=my-vault --input 'keys=["MY_API_KEY"]'

# 3. Move that key — copy to my-vault, then delete it from the shared store.
#    Add --input force=true to overwrite a name already present in the target,
#    or --input deleteSource=false to copy and leave the original in place.
swamp model method run @svendowideit/vault-migrate migrate vault-migrate \
  --input from=legacy --input to=my-vault --input 'keys=["MY_API_KEY"]'

# 4. Repeat per vault — route each shared key to the vault it belongs to.
swamp model method run @svendowideit/vault-migrate migrate vault-migrate \
  --input from=legacy --input to=team-vault \
  --input 'keys=["API_KEY","API_SECRET"]'
```

`keys` is a JSON array of key names, so it works for one key or many. Omit it to
target every key in the source at once — only do that when the source is
genuinely owned by one vault. Once `swamp vault list-keys legacy` is empty,
remove the `legacy` vault config.

### What systemd-creds does NOT protect from

- **A compromised user session.** Code running as your user can run
  `systemd-creds --user decrypt` and read every secret.
- **Root with explicit `--uid`.** Root can decrypt by passing `--uid=<your-uid>`.
- **Memory scraping.** Decrypted secrets exist in process memory during use.
- **Physical access to a running, unlocked machine.**
- **Supply-chain or kernel-level attacks.**

In short: the `.cred` files on disk are useless without the correct UID +
machine-id combination, but this is not protection against a live compromise of
your account.

### Extending and testing

The backend lives in `mod.ts` (exporting `vault`) and the migration logic in
`migrate.ts` (exporting `model`). Both take injectable dependencies — the vault
an injectable runner (`_runCommand`) and the model a `vaultService` context
slice — so tests stub the shell and the vault service instead of touching the
host:

```sh
# Type-check both entrypoints.
~/.swamp/deno/deno check mod.ts migrate.ts

# Run the unit tests.
~/.swamp/deno/deno test --allow-read --allow-write --allow-env --allow-run mod_test.ts
~/.swamp/deno/deno test --allow-read --allow-write --allow-env migrate_test.ts
```

`mod_test.ts` covers export metadata, config parsing, per-vault isolation and
the global fallback, `delete` (including the shared-key refusal), path-traversal
guards for both keys and vault names, and a full put/get round-trip.
`migrate_test.ts` covers plan, move vs copy, skip/force, key filters, per-key
failure isolation, and the guards for unknown/identical vaults.

## License

MIT — see LICENSE.txt.

## References

- [systemd Credentials documentation](https://systemd.io/CREDENTIALS/)
- [systemd-creds(1) man page](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
