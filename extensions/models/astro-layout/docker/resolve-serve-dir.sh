#!/bin/sh
# Resolve a serve directory to its absolute path. Works in plain POSIX sh:
# - accepts both relative (./foo or foo) and already-absolute (/abs/x) inputs,
# - resolves against the calling shell's working directory, just like `realpath .`.
set -eu
input="${1:?usage: resolve_serve_dir <SERVE_DIR>}"
case "$input" in
  /*) dir="$input" ;;                          # already absolute → use verbatim (strip optional trailing slash)
    *) dir="$(pwd)/$input" ;;                  # relative → anchor to caller's CWD
esac
dir="${dir%/}"                                 # drop a single trailing slash if present
# Prefer realpath; fall back to cd-then-pwd so empty/invalid paths surface clearly.
if command -v realpath >/dev/null 2>&1; then
  abs="$(realpath -- "$dir")"
else
  d="${dir%/*}"   # dirname-equivalent (empty for "leaf")
  if [ -z "$d" ]; then cd / ; else cd "$d"; fi
  b="${dir##*/}"    # basename-equivalent
  printf '%s/%s\n' "$(pwd)" "$b" > /tmp/.swamp_serve_abs.$$
  abs="$(cat /tmp/.swamp_serve_abs.$$)"; rm -f /tmp/.swamp_serve_abs.$$. 2>/dev/null || true
fi
printf '%s' "$abs"