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

## Local handoff tools

This plugin also exposes `handoff_plan` and `handoff_execute` tools for a
reviewable local/cloud handoff through an external `oc-handoff` helper. The
tools capture and report the current OpenCode `sessionID`, `directory`, and
`worktree`; those values are never accepted as model arguments. Only the
absolute helper paths `/usr/local/bin/oc-handoff` and
`/opt/homebrew/bin/oc-handoff` are allowed.

`handoff_plan` accepts a direction (`local-to-cloud` or `cloud-to-local`) and
the matching destination (`cloud` or `local`). For cloud-to-local, also pass
the external handoff ID as `handoffId`. Planning is local-only and returns a
short-lived plan ID and confirmation token. `handoff_execute` requires both
values and consumes the plan once, then invokes the helper's documented v1
`cloud <session-id> --source <worktree> --destination
/home/developer/workspace/intangibility` or `receive <id> --output <directory>`
protocol. A helper failure is reported as a failure; the plugin never claims
a transfer succeeded, and never commits, stashes, or resets git state.

For manual receipt, use the command in OpenCode:

```text
/handoff_receive <id>
```

or run the helper directly in a terminal:

```sh
oc-handoff receive <id>
```

The receive ID must be one safe token. Install/configure `oc-handoff` at one
of the allowlisted absolute paths before using these tools.
