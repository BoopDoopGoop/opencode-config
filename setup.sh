#!/usr/bin/env bash

set -euo pipefail

: "${HOME:?HOME must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="$HOME/.config/opencode"
OPENCODE_LINKS=(opencode.jsonc oh-my-opencode-slim.json tui.json)
CAVEMAN_LINKS=(AGENTS.md plugins)
OPTIONAL_CAVEMAN_SKILLS=(cavecrew caveman-commit caveman-compress caveman-help caveman-review caveman-stats)

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

check_caveman_command() {
  local commands="$OPENCODE_DIR/commands"

  if [ -L "$commands" ]; then
    if [ "$(readlink "$commands")" = "$SCRIPT_DIR/opencode/commands" ]; then
      return
    fi
  elif [ ! -e "$commands" ]; then
    return
  elif [ -d "$commands" ]; then
    check_managed_link "$commands/caveman.md" "$SCRIPT_DIR/opencode/commands/caveman.md"
    return
  fi

  error "Refusing to replace existing path: $commands"
  exit 1
}

remove_managed_link() {
  local target="$1"
  local source="$2"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    rm "$target"
  fi
}

for path in "${OPENCODE_LINKS[@]}"; do
  require_path "$path"
done
for path in "${CAVEMAN_LINKS[@]}"; do
  require_path "$path"
  check_managed_link "$OPENCODE_DIR/$path" "$SCRIPT_DIR/opencode/$path"
done
require_path "commands/caveman.md"
require_path "skills/caveman"
check_caveman_command
check_managed_link "$OPENCODE_DIR/skills/caveman" "$SCRIPT_DIR/opencode/skills/caveman"

install_opencode_links
for path in "${CAVEMAN_LINKS[@]}"; do
  install_managed_link "$OPENCODE_DIR/$path" "$SCRIPT_DIR/opencode/$path"
done
remove_managed_link "$OPENCODE_DIR/agents" "$SCRIPT_DIR/opencode/agents"
remove_managed_link "$OPENCODE_DIR/commands" "$SCRIPT_DIR/opencode/commands"
mkdir -p "$OPENCODE_DIR/commands"
install_managed_link "$OPENCODE_DIR/commands/caveman.md" "$SCRIPT_DIR/opencode/commands/caveman.md"
mkdir -p "$OPENCODE_DIR/skills"
install_managed_link "$OPENCODE_DIR/skills/caveman" "$SCRIPT_DIR/opencode/skills/caveman"
for path in "${OPTIONAL_CAVEMAN_SKILLS[@]}"; do
  remove_managed_link "$OPENCODE_DIR/skills/$path" "$SCRIPT_DIR/opencode/skills/$path"
done

printf '[opencode-config] Installed OpenCode configuration. Restart OpenCode to apply changes.\n'
