---
name: browser-tools
description: Navigate and debug web pages with Playwright CLI. Use for browser automation, local web-app debugging, screenshots, snapshots, console/network inspection, tracing, video, storage state, and optional user-approved attachment to an existing authenticated Chrome/Edge/Chromium/Arc browser session via the Playwright Extension.
---
# Browser Tools

Use Playwright CLI through the checked wrapper in this skill to navigate websites and debug web apps.

## Mandatory tooling check

Before using this skill for a task, verify the tooling first:

```bash
{baseDir}/browser-tools doctor
```

If `doctor` fails, **stop** and tell the user what is missing plus the install command printed by the script. Do not try browser automation until the check passes.

The wrapper resolves Playwright CLI in this order:

1. skill-local install: `{baseDir}/node_modules/.bin/playwright-cli`
2. global `playwright-cli`
3. current-project local `npx --no-install playwright-cli`

Use the wrapper for all commands instead of calling `playwright-cli` directly:

```bash
{baseDir}/browser-tools <playwright-cli args...>
```

## Setup if tooling is missing

Preferred self-contained setup:

```bash
cd {baseDir}
npm install
{baseDir}/browser-tools doctor
```

Alternative global setup:

```bash
npm install -g @playwright/cli@latest
{baseDir}/browser-tools doctor
```

If Playwright CLI is installed but the browser launch check fails because browser binaries are missing:

```bash
cd {baseDir}
npx playwright install chromium
{baseDir}/browser-tools doctor
```

## Routing rules

### Default: normal Playwright session

Use a normal Playwright CLI session unless the user explicitly asks to use their current browser/current login/current authenticated session. Playwright CLI is headless by default; do **not** add `--headed` unless the user asks to see the browser, the task requires visual/manual observation, or showing the browser would clearly help and you tell the user first.

Important distinction:

- normal Playwright CLI launches a Playwright-managed browser process/profile, usually headless and separate from the user's everyday browser state
- `--headed` makes that Playwright-managed browser visible, but it is still not the user's current logged-in Arc/Chrome tab
- `attach-current` / `attach --extension=chrome` connects to an existing user-approved browser tab through the Playwright Extension

Good for:

- navigating public or unauthenticated sites
- reproducing and debugging local web apps
- screenshots, accessibility snapshots, console logs, network requests
- tracing and video capture
- generating locators or validating flows

### Current authenticated browser session

Only attach to the user's existing browser session when:

- the user explicitly requests it, or
- you ask for confirmation and the user confirms.

Never proactively attach to a current session without confirmation. It can expose authenticated pages, cookies, localStorage, tokens, private data, and browser history. Minimize inspection and do not dump cookies/storage/secrets unless explicitly requested.

Before current-session attach, run:

```bash
{baseDir}/browser-tools doctor --current-session
```

Then attach only with the confirmation guard:

```bash
{baseDir}/browser-tools attach-current --confirmed --session=current
```

Continue using that named session:

```bash
{baseDir}/browser-tools -s=current snapshot
{baseDir}/browser-tools -s=current click e12
{baseDir}/browser-tools -s=current detach
```

### Arc note

Arc is Chromium-based and normally supports Chrome Web Store extensions, so it should be fine for current-session access. Install the Playwright Extension in Arc:

https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm

If attach does not discover or connect to Arc, retry from Chrome, Edge, or Chromium.

## Navigation workflow

1. Run `doctor`.
2. Open the page, usually in a named session for multi-step work:

   ```bash
   {baseDir}/browser-tools -s=task open https://example.com
   ```

3. Inspect the snapshot and use refs from it:

   ```bash
   {baseDir}/browser-tools -s=task snapshot
   {baseDir}/browser-tools -s=task click e15
   {baseDir}/browser-tools -s=task fill e21 "search text"
   {baseDir}/browser-tools -s=task press Enter
   ```

4. Save artifacts when useful:

   ```bash
   mkdir -p .pi/cache/browser-tools
   {baseDir}/browser-tools -s=task screenshot --filename=.pi/cache/browser-tools/page.png
   {baseDir}/browser-tools -s=task snapshot --filename=.pi/cache/browser-tools/page.yml
   ```

Playwright CLI prints a fresh page state after commands. Prefer accessibility snapshots and refs for interactions; use screenshots as artifacts or when visual state matters.

## Debugging workflow

For local apps:

1. Identify or ask for the local URL, such as `http://localhost:3000`.
2. Make sure the dev server is running. If you start it, keep logs visible or redirect them to `.pi/cache/browser-tools/`.
3. Run `doctor`.
4. Open the app and inspect errors:

   ```bash
   {baseDir}/browser-tools -s=debug open http://localhost:3000
   {baseDir}/browser-tools -s=debug console error
   {baseDir}/browser-tools -s=debug requests
   {baseDir}/browser-tools -s=debug request <index>
   ```

5. Use traces/videos for complex failures:

   ```bash
   {baseDir}/browser-tools -s=debug tracing-start
   # reproduce the bug
   {baseDir}/browser-tools -s=debug tracing-stop
   {baseDir}/browser-tools -s=debug video-start .pi/cache/browser-tools/debug.webm
   {baseDir}/browser-tools -s=debug video-stop
   ```

6. Close or detach when done:

   ```bash
   {baseDir}/browser-tools -s=debug close
   ```

## Useful commands

```bash
{baseDir}/browser-tools list
{baseDir}/browser-tools show
{baseDir}/browser-tools close-all
{baseDir}/browser-tools kill-all

{baseDir}/browser-tools goto <url>
{baseDir}/browser-tools snapshot [--depth=N] [--boxes]
{baseDir}/browser-tools click <ref>
{baseDir}/browser-tools dblclick <ref>
{baseDir}/browser-tools fill <ref> <text>
{baseDir}/browser-tools type <text>
{baseDir}/browser-tools press <key>
{baseDir}/browser-tools hover <ref>
{baseDir}/browser-tools select <ref> <value>
{baseDir}/browser-tools upload <file>

{baseDir}/browser-tools console [error|warning|info|debug]
{baseDir}/browser-tools requests
{baseDir}/browser-tools request <index>
{baseDir}/browser-tools eval '<function>' [ref]
{baseDir}/browser-tools run-code '<async (page) => { ... }>'

{baseDir}/browser-tools screenshot [ref] --filename=<file>
{baseDir}/browser-tools pdf --filename=<file>
{baseDir}/browser-tools tracing-start
{baseDir}/browser-tools tracing-stop

{baseDir}/browser-tools tab-list
{baseDir}/browser-tools tab-new [url]
{baseDir}/browser-tools tab-select <index>
{baseDir}/browser-tools tab-close [index]

{baseDir}/browser-tools state-save [file]
{baseDir}/browser-tools state-load <file>
```
