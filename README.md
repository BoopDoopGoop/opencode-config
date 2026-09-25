# OpenCode Configuration

Global OpenCode configuration and the BTW plugin package.

## Setup and disable

Node.js is required for the ownership checks. Run from a cloned copy of this
repo, then restart OpenCode Desktop:

```sh
./setup.sh
```

`setup.sh` links this repo's OpenCode configuration into
`~/.config/opencode/`. It also links the official
[Caveman](https://github.com/JuliusBrussee/caveman) OpenCode plugin, global
`AGENTS.md`, six commands, and the core and five companion skills. Caveman's
default mode is `ultra`, set by the repo-owned link at
`~/.config/caveman/config.json`. Cavecrew agents/skill and the Caveman proxy
are not installed. `/caveman-compress` calls Claude separately only when
invoked. Slim remains disabled; its settings stay in the repo and its skills
stay parked until Slim is enabled again.

Setup records owned links in
`~/.config/opencode/.opencode-config-owned.json`. It refuses to overwrite
unrelated files, except an existing regular `opencode.jsonc`, which is replaced
by this repo's canonical config link. Re-run setup after changing this repo:
removing Caveman from the plugin list unlinks its global rule, commands, skills,
plugin, and ultra setting. Removing Slim from `opencode.jsonc` unlinks its
settings and TUI badge. Slim-owned skills and their
manifest are moved to `~/.local/share/opencode-config/parked-slim/` so they no
longer load. Adding Slim back to the plugin list and rerunning setup restores
those same files, including any local edits.

Both shell commands use `scripts/ownership.mjs` for link checks and
`scripts/slim-skills.mjs` for reversible Slim-skill parking. The small
`scripts/manage-opencode-config.mjs` coordinates those operations.

To disable all global additions managed by this repo, quit OpenCode Desktop,
then run **before deleting this clone**:

```sh
./disable.sh
```

Restart Desktop afterward. Disable removes only verified owned links
and parks Slim-managed skills. It reports other global configuration rather
than claiming a clean native setup. Project rules, auth, chats, and inert
caches remain untouched. Existing sessions may still contain prior instructions.

To update Caveman, run the [official OpenCode-only installer](https://github.com/JuliusBrussee/caveman/blob/main/INSTALL.md)
against an isolated `XDG_CONFIG_HOME`, then bring the selected official files
into this repo. Do not run it against the live symlinked OpenCode configuration.

## BTW Package Development

The public plugin lives in `packages/opencode-btw`:

```sh
cd packages/opencode-btw
bun install
bun run check
```

To release a new package version, update its `package.json`, run the checks,
and publish from that package directory:

```sh
bun run check
npm publish --access public
```
