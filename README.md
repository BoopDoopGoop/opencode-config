# OpenCode Configuration

Global OpenCode configuration and the BTW plugin package.

## Setup and disable

Node.js is required for the ownership checks. Run from a cloned copy of this
repo, then restart OpenCode Desktop:

```sh
./setup.sh
```

`setup.sh` links this repo's OpenCode configuration, global `AGENTS.md`,
`/check-practices`, `/grounded-plan`, and `/checkpoint` into `~/.config/opencode/`.
`AGENTS.md` provides the always-on terse writing style. Slim remains disabled;
its settings stay in the repo and its skills stay parked until Slim is enabled
again.

Setup records owned links in
`~/.config/opencode/.opencode-config-owned.json`. It refuses to overwrite
unrelated files, except an existing regular `opencode.jsonc`, which is replaced
by this repo's canonical config link. Re-run setup after changing this repo:
the old Caveman plugin, commands, skills, and mode setting are unlinked while
the global `AGENTS.md` stays linked. Removing Slim from `opencode.jsonc` unlinks
its settings and TUI badge. Slim-owned skills and their manifest are moved to
`~/.local/share/opencode-config/parked-slim/` so they no longer load. Adding
Slim back to the plugin list and rerunning setup restores those same files,
including any local edits.

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
