# @svendowideit/ssh-key-inventory

## What it does

Inventory SSH private keys and authorized_keys entries across reachable hosts,
score each unique key for algorithm, size, age, encryption, permissions, and
reuse, generate a self-contained HTML report, and safely upgrade host sets to a
new key after testing it.

## Install

```sh
# Single-step install from the swamp registry.
swamp extension pull @svendowideit/ssh-key-inventory
```

## Configuration

| Arg | Description |
|---|---|
| sshUser | Default user for bare host entries |
| outputDir | HTML report directory |
| connectTimeoutSec | SSH connect timeout |
| keyPaths | Remote directories searched for private keys |

Create a model instance and configure it once:

```sh
swamp model create @svendowideit/ssh-key-inventory ssh-keys \
  --global-arg outputDir=~/.local/share/ssh-key-inventory
```

## Examples

```sh
# Register hosts; repeated runs accumulate targets instead of replacing them.
swamp model @svendowideit/ssh-key-inventory method run add-hosts ssh-keys \
  --input 'hosts:json=["alice@host1.example"]'

# Collect private and authorized keys over SSH from every known host.
swamp model @svendowideit/ssh-key-inventory method run inventory ssh-keys

# Render the collected inventory as an HTML report.
swamp model @svendowideit/ssh-key-inventory method run report ssh-keys
```

## Upgrade

Upgrade an existing install to a new key with a tested, reversible change:

```sh
swamp workflow run @svendowideit/ssh-key-upgrade \
  --input 'hosts:json=["alice@host1.example"]' \
  --input newKey=~/.ssh/id_ed25519_new
```

## Details

Models: ssh-key-inventory.
Methods: add-hosts, hosts, inventory, report, upgrade.
Reports: @svendowideit/ssh-key-summary.
Workflows: ssh-key-inventory-sweep, ssh-key-upgrade.
