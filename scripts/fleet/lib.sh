#!/usr/bin/env sh
# Shared helpers for the caddy fleet scripts (scripts/fleet/*).
#
# A "fleet item" is one unit of work (e.g. f0.6). The scripts create an isolated
# git worktree on branch `caddy/<slug>` based on origin/main, drive the item
# through a status ledger under `.worktree-status/<slug>.json`, run its
# test-factory dind gate, and open its PR against main.
#
# Everything a script needs is derived here so the scripts stay one-purpose.
set -eu

# --- repo + remote ---------------------------------------------------------

fleet_repo_root() {
  git rev-parse --show-toplevel
}

# owner/repo of the `origin` remote (falls back to gh's view).
fleet_owner_repo() {
  url="$(git remote get-url origin 2>/dev/null || echo "")"
  case "$url" in
    git@github.com:*) printf '%s' "${url#git@github.com:}" | sed 's/\.git$//' ;;
    https://github.com/*) printf '%s' "${url#https://github.com/}" | sed 's/\.git$//' ;;
    *) gh repo view --json nameWithOwner -q .nameWithOwner ;;
  esac
}

# An HTTPS push URL for origin, so pushes work where host SSH is misconfigured
# (gh's credential helper supplies the token). Override with FLEET_PUSH_URL.
fleet_push_url() {
  if [ -n "${FLEET_PUSH_URL:-}" ]; then printf '%s' "$FLEET_PUSH_URL"; return; fi
  printf 'https://github.com/%s.git' "$(fleet_owner_repo)"
}

# --- naming ----------------------------------------------------------------

fleet_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-'
}

fleet_branch() {
  printf 'caddy/%s' "$(fleet_slug "$1")"
}

# Directory that holds item worktrees. Deliberately outside the repo by default,
# but overridable — set FLEET_WORKTREE_DIR=/tmp/opencode for a sandboxed host.
fleet_worktree_dir() {
  printf '%s' "${FLEET_WORKTREE_DIR:-$(dirname "$(fleet_repo_root)")}"
}

fleet_worktree_path() {
  printf '%s/%s-%s' "$(fleet_worktree_dir)" "$(basename "$(fleet_repo_root)")" "$(fleet_slug "$1")"
}

# --- ledger ----------------------------------------------------------------

fleet_ledger_dir() {
  printf '%s/.worktree-status' "$(fleet_repo_root)"
}

fleet_ledger_path() {
  printf '%s/%s.json' "$(fleet_ledger_dir)" "$(fleet_slug "$1")"
}

# fleet_ledger_init <item> <branch> [candidate] [scenario]
fleet_ledger_init() {
  item="$1"; branch="$2"; candidate="${3:-}"; scenario="${4:-}"
  mkdir -p "$(fleet_ledger_dir)"
  jq -n \
    --arg item "$item" --arg branch "$branch" \
    --arg candidate "$candidate" --arg scenario "$scenario" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{item:$item, branch:$branch, phase:"started",
      candidate:$candidate, scenario:$scenario,
      pr:"", testRunId:"", testResult:"",
      updatedAt:$at, notes:"", log:[{at:$at,msg:"started"}]}' \
    > "$(fleet_ledger_path "$item")"
}

# fleet_ledger_set <item> <key> <value>  (value is written as a JSON string)
fleet_ledger_set() {
  item="$1"; key="$2"; value="$3"
  p="$(fleet_ledger_path "$item")"
  tmp="${p}.tmp"
  jq --arg k "$key" --arg v "$value" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.[$k]=$v | .updatedAt=$at | .log += [{at:$at, msg:($k+"="+$v)}]' \
    "$p" > "$tmp" && mv "$tmp" "$p"
}

# fleet_require_item <item>
fleet_require_item() {
  [ -n "${1:-}" ] || { echo "fleet: item required" >&2; exit 2; }
}
