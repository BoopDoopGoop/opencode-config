# @boopdoopgoop/opencode-btw

A minimal OpenCode plugin that adds a read-only background side conversation for quick questions. The user-facing result keeps the requested `BTW:` label.

## Install and configure

Add the package to the `plugin` list in your OpenCode configuration. OpenCode
will resolve and install the package automatically; no manual npm installation
is required:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@boopdoopgoop/opencode-btw"]
}
```

Then use the `btw` command with a question. The plugin runs the question in a temporary read-only worker session and delivers the result to the parent conversation as:

```text
BTW: Your question

The answer.
```

## Package development

```sh
bun install
bun run check
```

## Package release

Update the version in `package.json`, verify the package, and publish it publicly:

```sh
bun run check
npm publish --access public
```

The package builds from `src/index.ts` into `dist/` before publishing.
