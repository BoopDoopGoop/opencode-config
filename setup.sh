#!/usr/bin/env bash

set -euo pipefail

: "${HOME:?HOME must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="$HOME/.config/opencode"
OPENCODE_LINKS=(opencode.jsonc oh-my-opencode-slim.json tui.json)
CAVEMAN_LINKS=(AGENTS.md agents commands plugins)
CAVEMAN_SKILLS=(cavecrew caveman caveman-commit caveman-compress caveman-help caveman-review caveman-stats)

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

check_managed_link() {
  local target="$1"
  local source="$2"

  if [ -L "$target" ]; then
    if [ "$(readlink "$target")" = "$source" ] || [ ! -e "$target" ]; then
      return
    fi
  elif [ ! -e "$target" ]; then
    return
  fi

  error "Refusing to replace existing path: $target"
  exit 1
}

install_managed_link() {
  local target="$1"
  local source="$2"

  if [ -L "$target" ]; then
    if [ "$(readlink "$target")" = "$source" ]; then
      return
    fi
    rm "$target"
  fi
  ln -s "$source" "$target"
}

for path in "${OPENCODE_LINKS[@]}"; do
  require_path "$path"
done
for path in "${CAVEMAN_LINKS[@]}"; do
  require_path "$path"
  check_managed_link "$OPENCODE_DIR/$path" "$SCRIPT_DIR/opencode/$path"
done
for path in "${CAVEMAN_SKILLS[@]}"; do
  require_path "skills/$path"
  check_managed_link "$OPENCODE_DIR/skills/$path" "$SCRIPT_DIR/opencode/skills/$path"
done

install_opencode_links
for path in "${CAVEMAN_LINKS[@]}"; do
  install_managed_link "$OPENCODE_DIR/$path" "$SCRIPT_DIR/opencode/$path"
done
mkdir -p "$OPENCODE_DIR/skills"
for path in "${CAVEMAN_SKILLS[@]}"; do
  install_managed_link "$OPENCODE_DIR/skills/$path" "$SCRIPT_DIR/opencode/skills/$path"
done

printf '[opencode-config] Installed OpenCode configuration. Restart OpenCode to apply changes.\n'
