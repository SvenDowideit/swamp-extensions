# systemd-creds Vault

A swamp vault backend that stores secrets encrypted at rest using
`systemd-creds --user`. No root required, no desktop keychain daemon needed —
just systemd v256+.

## Requirements

- **systemd v256 or higher** (the `--user` flag was added in v256)

Check your version:

```bash
systemctl --version
```

## How Secrets Are Encrypted

Secrets are encrypted with **AES256-GCM**. The encryption key is derived from a
combination of:

1. **Your UID** — the credential is scoped to your Linux user identity.
2. **Your machine-id** — the credential is bound to the specific host
   (`/etc/machine-id`).

This means:

- **Root cannot decrypt your secrets** transparently — the `--user` flag scopes
  encryption to your UID. Root would need to explicitly pass `--uid=<your-uid>`
  to decrypt.
- **Copying the `.cred` file to another machine will not work** — the
  machine-id won't match, so decryption fails.
- **Copying the `.cred` file to another user on the same machine will not
  work** — the UID won't match.

Encrypted credential files are stored in `~/.config/credstore/` by default
(configurable via the `credstoreDir` config option).

## When Secrets Are Accessible

Secrets are accessible **any time after login**, as soon as your user session is
active. The `systemd-creds --user` command works in any shell session, SSH
session, or systemd user service. There is no daemon to start and no unlock
step — decryption is transparent as long as you're running as the same user on
the same machine.

## What systemd-creds Does NOT Protect From

- **A compromised user session.** If an attacker gains code execution as your
  user, they can run `systemd-creds --user decrypt` and read all your secrets.
- **Memory scraping.** Decrypted secrets exist in process memory during use.
- **Root with explicit `--uid`.** Root can decrypt your credentials by passing
  `--uid=<your-uid>` to `systemd-creds`.
- **Physical access to a running, unlocked machine.** Anyone with access to your
  logged-in session can decrypt credentials.
- **Backups of the raw `.cred` files.** If you back up the encrypted files and
  the backup is stolen, the attacker still needs your machine-id and UID — but
  if they also compromise the host, the files are decryptable.
- **Supply-chain or kernel-level attacks.** If the kernel or systemd itself is
  compromised, the encryption guarantees are void.

In short: systemd-creds protects **data at rest** — the `.cred` files on disk
are useless without the correct UID + machine-id combination. It does **not**
protect against a live compromise of your user account.

## Configuration

### `.swamp.yaml`

```yaml
vault:
  type: "@svendowideit/systemd-creds"
  config:
    credstoreDir: "~/.config/credstore"  # optional, this is the default
```

### Usage

First, create a named vault instance:

```bash
swamp vault create "@svendowideit/systemd-creds" my-vault
```

Then use it to store and retrieve secrets:

```bash
# Store a secret
swamp vault put my-vault my-api-key "sk-abc123"

# Retrieve a secret
swamp vault read-secret my-vault my-api-key

# List all stored secrets
swamp vault list-keys my-vault
```

## How It Works

Under the hood, this extension shells out to `systemd-creds --user`:

- **`put`** pipes the secret value to `systemd-creds --user encrypt - <path>.cred`
- **`get`** runs `systemd-creds --user decrypt <path>.cred -` and captures stdout
- **`list`** reads the credstore directory for `*.cred` files

No secrets are ever written to disk in plaintext — they are encrypted by
systemd-creds before hitting the filesystem.

## References

- [systemd Credentials documentation](https://systemd.io/CREDENTIALS/)
- [systemd-creds(1) man page](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
