# OpenCode Configuration

Global OpenCode configuration.

## Setup and disable

Node.js is required for the ownership checks. Run from a cloned copy of this
repo, then restart OpenCode Desktop:

```sh
./setup.sh
```

`setup.sh` links this repo's OpenCode configuration, global `AGENTS.md`,
`/ground`, `/plan`, `/implement`, and `/checkpoint` into `~/.config/opencode/`.
`AGENTS.md` provides the always-on terse writing style.

Setup records owned links in
`~/.config/opencode/.opencode-config-owned.json`. It refuses to overwrite
unrelated files, except an existing regular `opencode.jsonc`, which is replaced
by this repo's canonical config link. Re-run setup after changing this repo:
the old Caveman plugin, commands, skills, and mode setting are unlinked while
the global `AGENTS.md` stays linked.

Both shell commands use `scripts/ownership.mjs` for link checks.
`scripts/manage-opencode-config.mjs` coordinates those operations.

To disable all global additions managed by this repo, quit OpenCode Desktop,
then run **before deleting this clone**:

```sh
./disable.sh
```

Restart Desktop afterward. Disable removes only verified owned links.
It reports other global configuration rather
than claiming a clean native setup. Project rules, auth, chats, and inert
caches remain untouched. Existing sessions may still contain prior instructions.
