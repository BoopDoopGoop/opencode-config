#!/usr/bin/env bash

set -euo pipefail

: "${HOME:?HOME must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="$HOME/.config/opencode"
OPENCODE_LINKS=(opencode.jsonc oh-my-opencode-slim.json tui.json)

error() {
  printf '[opencode-config] ERROR: %s\n' "$*" >&2
}

require_path() {
  local path="$1"
  if [ ! -e "$SCRIPT_DIR/opencode/$path" ]; then
    error "Missing required path: $SCRIPT_DIR/opencode/$path"
    exit 1
  fi
}

install_opencode_links() {
  if ! mkdir -p "$OPENCODE_DIR"; then
    error "Could not create $OPENCODE_DIR"
    exit 1
  fi

  for path in "${OPENCODE_LINKS[@]}"; do
    if ! rm -rf "$OPENCODE_DIR/$path"; then
      error "Could not replace $path"
      exit 1
    fi
    if ! ln -s "$SCRIPT_DIR/opencode/$path" "$OPENCODE_DIR/$path"; then
      error "Could not link $path"
      exit 1
    fi
  done
}

for path in "${OPENCODE_LINKS[@]}"; do
  require_path "$path"
done

install_opencode_links

printf '[opencode-config] Installed OpenCode configuration. Restart OpenCode to apply changes.\n'
