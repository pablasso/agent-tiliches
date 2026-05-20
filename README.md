# Agent Tiliches

The tooling and customizations that I use with [Pi](https://pi.dev).

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
  - `web-fetch/` - static URL fetch/readable extraction with warnings when browser navigation may be needed
- `skills/` - Agent Skills-compatible skills
  - `youtube-transcript/` - fetch timestamped YouTube transcripts via `youtube-transcript-plus`; based on Badlogic's [`youtube-transcript` skill](https://github.com/badlogic/pi-skills/tree/main/youtube-transcript) from [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills)
- `prompts/` - Pi prompt templates
- `themes/` - Pi themes
