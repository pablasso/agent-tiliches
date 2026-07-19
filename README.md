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
  - `code-review/` - `/code-review` runs machine-local, read-only reviewers in parallel, shows lifecycle progress, saves complete run logs outside the repository, and asks the active model to adjudicate validity and proportionality
  - `comment/` - `/comment` opens the latest assistant message in `$VISUAL`/`$EDITOR` so you can annotate it and send feedback back into the session
  - `diff-review/` - `/diff-review` native diff review window powered by Glimpse and Monaco
  - `no-sleep.ts` - `/no-sleep` macOS `caffeinate` integration, copied from Armin Ronacher's `mitsuhiko/agent-stuff`
  - `web-fetch/` - static URL fetch/readable extraction with warnings when browser navigation may be needed
- `skills/` - Agent Skills-compatible skills
  - `browser-tools/` - navigate and debug web pages through Playwright CLI, with checked setup and optional user-approved current-browser attachment via the Playwright Extension
  - `youtube-transcript/` - fetch timestamped YouTube transcripts via `youtube-transcript-plus`
- `prompts/` - Pi prompt templates
  - `artifact.md` - `/artifact` distills a focused outcome into a durable, dated handoff document
- `themes/` - Pi themes

## Code review configuration

`/code-review` deliberately has no repository defaults. Configure reviewers independently on each computer in Pi's user directory:

```text
~/.pi/agent/code-review.json
```

Pi honors `PI_CODING_AGENT_DIR`, so the file follows a custom agent directory when one is configured. An absent file is equivalent to an empty reviewer list.

```json
{
  "reviewers": [
    {
      "name": "Primary reviewer",
      "provider": "your-provider",
      "model": "your-model-id",
      "thinking": "max"
    }
  ],
  "extensions": []
}
```

`extensions` lists child-Pi extension specs needed to load machine-local providers, for example `"npm:your-provider-extension"`. Reviewers report at most five concrete findings each, with a candidate minimal fix and only a coarse `TINY`/`SMALL`/`MEDIUM`/`LARGE` involvement size. After reviewers finish, the active implementation agent adjudicates their feedback using its current model, thinking level, conversation context, and normal tools; no separate lead subprocess is started. The lead performs targeted verification rather than a second whole-patch review, and adds fix sizing/trade-off detail only for recommended work or a real issue rejected because its remedy is disproportionate. Review logs are private machine-local artifacts under `~/.pi/agent/code-review/runs/`. Use `/code-review-logs` to open the newest run or `/code-review-logs path` to print its path.

