# Agent Tiliches

My personal collection of extensions, skills, and prompt templates for [Pi](https://pi.dev). It is the kind of setup I enjoy customizing as deeply as Vim or Emacs.

Much of it is inspired by [Mario Zechner's Pi projects](https://github.com/badlogic).

## Installation

From the repository root:

```bash
pi install .
```

Then run `/reload` in an existing Pi session, or restart Pi.

## What's included

### Extensions

- **[Clone tab](extensions/clone-tab/README.md)** — `/clone-tab` opens the active conversation branch as an independent Pi session in a new Ghostty tab.
- **[Code review](extensions/code-review/README.md)** — `/code-review` runs configured read-only reviewers in parallel, then has the current agent verify and prioritize their findings.
- **[Codex usage](extensions/codex-usage/README.md)** — shows Codex login limits in the footer and through `/codex-usage`.
- **[Comment](extensions/comment/)** — `/comment` opens the latest assistant response in `$VISUAL` or `$EDITOR` for annotation.
- **[Diff review](extensions/diff-review/)** — `/diff-review` opens a native window for reviewing Git changes and returns the feedback to Pi.
- **[No sleep](extensions/no-sleep.ts)** — `/no-sleep` controls macOS sleep prevention while Pi is running, copied from [Armin Ronacher's agent-stuff](https://github.com/mitsuhiko/agent-stuff).
- **[Web fetch](extensions/web-fetch/README.md)** — adds the static `web_fetch` tool for extracting readable content from a URL.

### Skills

- **[Brave Search](skills/brave-search/SKILL.md)** — searches the web and extracts readable page content through the Brave Search API.
- **[Browser tools](skills/browser-tools/SKILL.md)** — navigates and debugs web pages with Playwright CLI.
- **[YouTube transcript](skills/youtube-transcript/SKILL.md)** — fetches timestamped transcripts from YouTube videos.

### Prompt templates

- **[Artifact](prompts/artifact.md)** — `/artifact` turns a focused session outcome into a durable handoff document.
