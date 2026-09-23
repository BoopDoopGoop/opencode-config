# OpenCode Configuration

Global OpenCode configuration and the BTW plugin package.

## Install

Run from a cloned copy of this repo:

```sh
./setup.sh
```

`setup.sh` symlinks the OpenCode configuration into `~/.config/opencode/`.
It also links the official [Caveman](https://github.com/JuliusBrussee/caveman)
OpenCode plugin, commands, agents, and rules. Its Caveman skills are linked
individually, preserving other installed skills. Conflicting files at Caveman
destinations are left alone; the installer refuses to replace them. OpenCode
downloads the other plugins listed in `opencode.jsonc` at startup.

The Caveman files come from the official OpenCode installer, run with
`XDG_CONFIG_HOME` pointing at this repository. To update them, run the
installer from the repository root again, then review its changes before
running `./setup.sh`:

```sh
XDG_CONFIG_HOME="$PWD" npx -y github:JuliusBrussee/caveman -- --only opencode
```

Do not run the upstream installer against `~/.config/opencode` directly:
the live configuration contains symlinks managed by this repository.

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
