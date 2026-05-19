# web-fetch extension contract

Status: `web_fetch` is implemented with static HTTP extraction plus an explicit Playwright/Chromium browser mode.

## Goal

Provide a model-callable `web_fetch` tool that fetches an HTTP(S) URL and returns readable content, usually Markdown, plus structured metadata that tells the agent how trustworthy/complete the extraction is.

Default `auto` mode is intentionally cheap and static: it fetches the server response, parses HTML with a DOM, extracts readable main content with Mozilla Readability when possible, and converts HTML to Markdown with Turndown. If static extraction looks incomplete, it reports `browserRecommended: true`.

Explicit `mode: "browser"` uses Playwright/Chromium to render the page, click/open safe foldable controls in the selected scope, prune rendered hidden content when requested, and then run the same readable extraction pipeline over the rendered DOM.

## Setup

Static mode only needs the normal package dependencies:

```bash
npm install
npm run check
```

Browser mode also needs a Playwright browser installed:

```bash
npx playwright install chromium
npm run check:browser
```

Browser mode first tries Playwright's managed Chromium, then falls back to an installed Google Chrome channel when available. If neither can launch, `web_fetch` returns a setup error that points to the install command.

## Files

- `index.ts` - Pi tool registration, output truncation, and temp-file writing.
- `core.ts` - tool orchestration that can be smoke-tested outside Pi.
- `browser.ts` - Playwright browser rendering, scoped foldable expansion, and rendered-DOM extraction.
- `fetch.ts` - HTTP fetch, timeout/abort, content-type checks, decoding.
- `extract.ts` - high-level HTML extraction orchestration.
- `dom.ts` - DOM parsing, cleanup, scope selection, URL rewriting.
- `detect.ts` - static foldable/hidden element detection, simple `aria-controls` inclusion, and warnings.
- `quality.ts` - extraction quality heuristics and browser recommendation logic.
- `render.ts` - HTML/Text/Markdown rendering.
- `text.ts` - text normalization helpers.
- `types.ts` - shared types and constants.

## Tool name

`web_fetch`

## Default behavior

A normal call should be simple:

```json
{
  "url": "https://example.com/article"
}
```

Defaults:

- `mode`: `"auto"`
- `format`: `"markdown"`
- `scope`: `"main"`
- `foldables`: `"auto"`
- `hidden`: `"exclude"`

The tool should:

1. Reject non-HTTP(S) URLs.
2. Fetch or render the URL with redirects and a timeout.
3. Detect/record response metadata where available.
4. For HTML, extract readable main content when possible.
5. Convert HTML to Markdown by default.
6. Truncate output using Pi-style limits and save full output to temp files when truncated.
7. Return metadata and warnings about extraction quality, foldables, hidden content, redirects, and likely JS-heavy pages.

## Parameters

```ts
type WebFetchParams = {
  /** Absolute http(s) URL to fetch. */
  url: string;

  /** Fetch/extraction strategy. */
  mode?: "auto" | "static" | "browser";

  /** Output format returned to the model. */
  format?: "markdown" | "text" | "html";

  /** Which part of the document to extract. */
  scope?: "main" | "page";

  /** How to handle accordion/details/collapse-style content in the HTML. */
  foldables?: "auto" | "ignore" | "include";

  /** Whether to include generic hidden content. Use carefully; hidden page content is often nav or template junk. */
  hidden?: "exclude" | "main" | "all";
};
```

### `mode`

- `auto` (default): perform static extraction, then report if browser rendering is recommended.
- `static`: only perform static extraction and do not recommend browser escalation in top-level details.
- `browser`: render with Playwright/Chromium, wait for load, expand safe foldables in the selected scope, then extract readable content from the rendered DOM.

`auto` currently does **not** silently launch a browser. This keeps normal URL fetches cheap and predictable. If `auto` reports `browserRecommended: true`, call again with `mode: "browser"` when full rendered content matters.

### `format`

- `markdown` (default): best for agent reading.
- `text`: plain text without Markdown links/headings.
- `html`: cleaned HTML, mainly for debugging extraction issues.

### `scope`

- `main` (default): prefer article/main/body content and remove/ignore obvious nav/header/footer/sidebar noise.
- `page`: return cleaned page-wide content. Useful when the page is not article-like or when navigation/footer content matters.

### `foldables`

Static mode:

- `auto` (default): include static `<details>` content in the selected scope, and report other foldable/collapsible elements as not expanded.
- `ignore`: remove static `<details>` content from output and do not expand controlled hidden content.
- `include`: include static `<details>` content and simple hidden `aria-controls` panels already present in the selected scope. JavaScript-generated content is not available statically.

Browser mode:

- `auto` / `include`: open `<details>` and click safe rendered controls inside the selected scope, such as `button[aria-expanded="false"]`, `[role="button"][aria-controls]`, and “Show more”/“Read more”-style buttons.
- `ignore`: do not open/click foldables.

Foldable/collapsible signals include:

- `<details>` / `<summary>`
- `aria-expanded="false"`
- `aria-controls`
- class/id names containing `accordion`, `collapse`, `expand`, `drawer`, `toggle`
- text like `show more`, `read more`, `view more`, `expand_more`

The implementation ignores obvious header/nav/footer/sidebar controls when `scope` is `main`, especially when extraction falls back to the whole `<body>`.

### `hidden`

- `exclude` (default): remove hidden elements detected in the selected scope unless handled by foldable expansion.
- `main`: include hidden elements detected in the selected scope.
- `all`: include hidden elements detected in the selected scope. Currently behaves like `main` after scope selection.

In browser mode, `hidden: "exclude"` also prunes rendered elements whose computed style is hidden before serializing the DOM.

## Result contract

The tool returns model-visible content plus structured details.

```ts
type WebFetchDetails = {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;

  mode: "auto" | "static" | "browser";
  format: "markdown" | "text" | "html";
  scope: "main" | "page";
  extraction: "html-readability" | "html-cleaned" | "browser-readability" | "browser-cleaned" | "text" | "raw";

  bytesFetched: number;
  outputBytes: number;
  outputLines: number;

  rawHtmlPath?: string;
  fullOutputPath?: string;
  truncated?: boolean;
  responseTruncated?: boolean;

  foldables: {
    detected: number;
    included: number;
    ignored: number;
    controlledPanelsIncluded: number;
    examples: string[];
  };

  hidden: {
    detected: number;
    included: number;
    ignored: number;
  };

  quality: {
    rawBytes: number;
    outputChars: number;
    outputToRawRatio: number;
    scriptCount: number;
    clientRenderedMarkers: boolean;
    sparseOutput: boolean;
    navHeavyOutput: boolean;
    foldablesBlocked: boolean;
    browserRecommended: boolean;
    reasons: string[];
  };

  browserRecommended: boolean;
  browserReason?: string;

  browser?: {
    engine: "chromium" | "chrome";
    renderedHtmlBytes: number;
    detailsOpened: number;
    controlsClicked: number;
    controlsAttempted: number;
    skipped: number;
    errors: number;
    examples: string[];
  };

  warnings: string[];
};
```

## Warning heuristics

Set `browserRecommended: true` when static extraction looks suspect, for example:

- HTML is very large but extracted content is very small.
- Extracted content is mostly navigation/footer text.
- Many deferred/client-rendered data markers are present.
- Many foldable/collapsible elements are detected but not included.
- The page has a root app shell with little readable body content.

For the Google Careers candidate-prep URL, static mode should warn that extraction may be incomplete because the HTML is large, uses deferred Google client data, and naive visible text is nav/footer-heavy. Browser mode is the intended follow-up for that class of page.

## Non-goals

- No authenticated browsing or browser cookies beyond a fresh isolated Playwright context.
- No form submission or arbitrary user interaction.
- No full web crawling; one URL per tool call.
- No search engine behavior.
- No automatic browser escalation from `mode: "auto"` yet.
