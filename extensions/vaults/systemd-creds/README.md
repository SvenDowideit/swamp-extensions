# @svendowideit/systemd-creds

A swamp vault backend that stores secrets encrypted at rest using
`systemd-creds --user`. No root required, no desktop keychain daemon needed —
just systemd v256+.

## What it does

Stores swamp vault secrets in a directory of AES256-GCM-encrypted `.cred` files
via `systemd-creds --user`. The encryption key is derived from your UID and the
host's machine-id, so an encrypted file copied to another machine or another
user will not decrypt. It protects **data at rest** only: a live compromise of
your user session can still run `systemd-creds --user decrypt`. Use it when you
want secrets that stay encrypted on disk without a running keychain daemon.

## Install

```sh
swamp extension pull @svendowideit/systemd-creds
```

Requires **systemd v256 or higher** (the `--user` flag was added in v256):

```bash
systemctl --version
```

## Configuration

Set the optional `credstoreDir` when creating the vault, or in `.swamp.yaml` as
`vault.config.credstoreDir`:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `credstoreDir` | string | `"~/.config/credstore"` | Directory for the encrypted `.cred` files. A leading `~/` expands to `$HOME`. |

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

## Details

`@svendowideit/systemd-creds` ships one vault backend
(`@svendowideit/systemd-creds`). It implements the standard swamp vault
interface by shelling out to `systemd-creds --user`:

| Operation | What it runs | Notes |
| --------- | ------------ | ----- |
| `put` | `systemd-creds --user encrypt - <key>.cred` | Secret value piped on stdin; encrypted before it hits disk. |
| `get` | `systemd-creds --user decrypt <key>.cred -` | Returns the decrypted value on stdout; throws with systemd's stderr on failure. |
| `list` | reads `credstoreDir` for `*.cred` | Returns sorted key names only, never values. A missing directory lists as empty. |
| `getName` | — | Returns the vault instance name passed to the provider. |

Encrypted files are stored in `~/.config/credstore/` by default (configurable
via `credstoreDir`).

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

The backend lives in `mod.ts` and exposes a single `vault` object. It takes an
injectable runner (`_runCommand`) so tests stub `systemd-creds` instead of
touching the host:

```sh
# Type-check and run the unit tests.
~/.swamp/deno/deno check mod.ts
~/.swamp/deno/deno test --allow-read --allow-env --allow-run mod_test.ts
```

`mod_test.ts` covers the export metadata, config parsing, the `put`/`get`/`list`
code paths (success and failure), tilde expansion, and a full round-trip with a
mocked `systemd-creds`.

## License

MIT — see LICENSE.txt.

## References

- [systemd Credentials documentation](https://systemd.io/CREDENTIALS/)
- [systemd-creds(1) man page](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
