# Rex

Gives Pi the startup context that [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill)'s SessionStart hook gives Claude Code and Codex. Pi has no command hooks, so `rex skill setup` installs only the skill for Pi and reports its hook as `unsupported`. This extension fills that gap.

## Behavior

When an interactive Pi session starts in a Rex terminal, the extension runs the same command as Rex's hook:

```sh
rex __internal session-start --agent pi
```

It adds the output to the system prompt as a `<rex>` section. The output says that Pi runs in Rex, gives its `REX_SESSION`, `REX_BLOCK`, and `REX_SERVER`, and points to the `/skill:rex` skill.

- The text comes from the installed Rex, so upgrading Rex updates it without changing this extension.
- It is a prompt section, not a transcript message, so it survives compaction and follows the pane when a session is resumed somewhere else.
- It loads once per session in the background and doesn't delay startup.
- It does nothing outside Rex (no `REX_SESSION`), and nothing if `rex` is missing, fails, or takes more than five seconds.
- It does nothing in print, JSON, or RPC mode. Background subagents inherit the parent's `REX_SESSION`, and this keeps them from acting on or renaming your Rex session.

It prefers the `rex` in `REX_BIN_DIR`, the copy that matches the server that opened the terminal, and falls back to `rex` on `PATH`.

## Tab naming

With `rex skill setup --session-naming`, Rex's hook asks the agent to name the Rex session after its task. Several agents can share one session, so each would rename it and overwrite your name. Rex can't tell a label you set from one an agent set, so this extension asks Pi to name only its own tab instead:

- Pi finds its tab from `.block.window_id` in `rex block inspect "$REX_BLOCK"` and renames it with `rex window rename`. It follows Rex's wording and label rules: two to four lowercase words joined by hyphens, kept if they already describe the work.
- Pi is told to leave the session's name alone unless you ask, and to apply the rex skill's session-naming guidance to its tab.
- The extension reads the installed choice from `rex skill status --json`. When naming is off, it passes `--feature-session-naming=false` and uses Rex's output as is, so no tab naming either. When Rex can't report the choice, naming is treated as on, Rex's default.
- To find Rex's naming text without matching its wording, the extension runs the hook with naming on and off and drops the paragraphs that appear only with naming on. It also drops the paragraphs that appear only with naming off, such as the "setup is out of date" note the mismatched flag causes. If either run fails, it adds no context.

Claude Code and Codex still get Rex's own hook, so they still rename the session. Run `rex skill setup --session-naming=false` to turn naming off for every agent.

## Not covered here

Pi already reports its status to Rex with the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status) (OSC 7501), so Rex shows its working, blocked, done, and error states without this extension.

`rex skill status` keeps reporting Pi's hook as `unsupported`, and `rex skill remove` doesn't remove this extension. If a later Rex adds a hook for Pi, remove this extension so the context isn't given twice.

## Configuration

Set `PI_REX_CONTEXT=0` to turn the extension off.
