# Agent Tiliches

The tooling and customizations that I use with [Pi](https://pi.dev). A lot of this is inspired by badlogicgames' configs.

Pi is an agent that encourages customization to fit whatever flows you like. It reminds me of customizing the hell out of Vim or Emacs, and I love that.

## Pi package

This repo is structured as a local Pi package so its resources can be version-tracked here and loaded by Pi in place.

From the repo root:

```bash
pi install .
```

Or from anywhere, pass the absolute path to your local checkout.

After installing, reload Pi resources with `/reload` or restart Pi.

## Layout

- `extensions/` - TypeScript Pi extensions and tools
  - `comment/` - `/comment` opens the latest assistant message in `$VISUAL`/`$EDITOR` so you can annotate it and send feedback back into the session
  - `diff-review/` - `/diff-review` native diff review window powered by Glimpse and Monaco
  - `web-fetch/` - static URL fetch/readable extraction with warnings when browser navigation may be needed
- `skills/` - Agent Skills-compatible skills
  - `browser-tools/` - navigate and debug web pages through Playwright CLI, with checked setup and optional user-approved current-browser attachment via the Playwright Extension
  - `youtube-transcript/` - fetch timestamped YouTube transcripts via `youtube-transcript-plus`
- `prompts/` - Pi prompt templates
  - `artifact.md` - `/artifact` distills a focused outcome into a durable, dated handoff document
- `themes/` - Pi themes

