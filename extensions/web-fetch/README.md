# web-fetch extension contract

Status: Static `web_fetch` tool implemented with DOM parsing, Mozilla Readability main-content extraction, and Turndown Markdown conversion.

## Goal

Provide a model-callable `web_fetch` tool that fetches an HTTP(S) URL and returns readable content, usually Markdown, plus structured metadata that tells the agent how trustworthy/complete the extraction is.

The first implementation is static-only: it fetches the server response, parses HTML with a DOM, extracts readable main content with Mozilla Readability when possible, and converts HTML to Markdown with Turndown. Browser/Playwright rendering is intentionally out of scope for v1 and should be a separate extension or a future mode.

## Files

- `index.ts` - Pi tool registration, output truncation, and temp-file writing.
- `core.ts` - tool orchestration that can be smoke-tested outside Pi.
- `fetch.ts` - HTTP fetch, timeout/abort, content-type checks, decoding.
- `extract.ts` - high-level HTML extraction orchestration.
- `dom.ts` - DOM parsing, cleanup, scope selection, URL rewriting.
- `detect.ts` - static foldable/hidden element detection and warnings.
- `render.ts` - HTML/Text/Markdown rendering.
- `text.ts` - text normalization helpers.
- `types.ts` - shared types and constants.

Run the smoke check from the repo root:

```bash
npm run check
```

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

1. Fetch the URL with redirects and a timeout.
2. Reject non-HTTP(S) URLs.
3. Detect response content type.
4. For HTML, extract readable main content when possible.
5. Convert HTML to Markdown by default.
6. Truncate output using Pi-style limits and save full output to temp files when truncated.
7. Return metadata and warnings about extraction quality, foldables, hidden content, redirects, and likely JS-heavy pages.

## Parameters

```ts
type WebFetchParams = {
  /** Absolute http(s) URL to fetch. */
  url: string;

  /** Fetch/extraction strategy. v1 supports static only; auto may recommend browser rendering. */
  mode?: "auto" | "static";

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
- `static`: only perform static extraction and do not attempt browser escalation.

Future browser/Playwright support should not be added silently to v1. Add a new mode later, e.g. `browser`, after the browser extension exists.

### `format`

- `markdown` (default): best for agent reading.
- `text`: plain text without Markdown links/headings.
- `html`: cleaned HTML, mainly for debugging extraction issues.

### `scope`

- `main` (default): prefer article/main/body content and remove obvious nav/header/footer noise.
- `page`: return cleaned page-wide content. Useful when the page is not article-like or when navigation/footer content matters.

### `foldables`

- `auto` (default): include static `<details>` content in the selected scope, and report other foldable/collapsible elements as not expanded.
- `ignore`: remove static `<details>` content from output and do not expand controlled hidden content.
- `include`: include static `<details>` content and simple hidden `aria-controls` panels already present in the selected scope. JavaScript-generated content is still not available in v1.

Foldable/collapsible element signals include:

- `<details>` / `<summary>`
- `aria-expanded="false"`
- `aria-controls`
- class/id names containing `accordion`, `collapse`, `expand`, `drawer`, `toggle`
- text like `show more`, `read more`, `expand_more`

The implementation ignores obvious header/nav/footer/sidebar controls when `scope` is `main`, especially when extraction falls back to the whole `<body>`.

### `hidden`

- `exclude` (default): remove hidden elements detected in the selected scope unless handled by `foldables`.
- `main`: include hidden elements detected in the selected scope.
- `all`: include hidden elements detected in the selected scope. In the current static implementation this behaves like `main` after scope selection.

Hidden element signals include:

- `hidden` attribute
- `aria-hidden="true"`
- inline styles such as `display: none` or `visibility: hidden`
- common screen-reader/offscreen classes may be kept or dropped depending on usefulness

## Result contract

The tool should return model-visible content plus structured details.

```ts
type WebFetchDetails = {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;

  mode: "auto" | "static";
  format: "markdown" | "text" | "html";
  scope: "main" | "page";
  extraction: "html-readability" | "html-cleaned" | "text" | "raw";

  bytesFetched: number;
  outputBytes: number;
  outputLines: number;

  rawHtmlPath?: string;
  fullOutputPath?: string;

  truncated?: boolean;

  foldables: {
    detected: number; // foldable/collapsible elements in selected non-chrome scope
    included: number; // static <details> + statically included aria-controls panels
    ignored: number;
    controlledPanelsIncluded: number;
    examples: string[];
  };

  hidden: {
    detected: number; // meaningful hidden elements in selected non-chrome scope
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

  warnings: string[];
  browserRecommended: boolean;
  browserReason?: string;
};
```

## Warning heuristics

Set `browserRecommended: true` when static extraction looks suspect, for example:

- HTML is very large but extracted content is very small.
- Extracted content is mostly navigation/footer text.
- Many deferred/client-rendered data markers are present.
- Many foldable/collapsible elements are detected but not included.
- The page has a root app shell with little readable body content.

For the Google Careers candidate-prep URL, the tool should likely warn that static extraction may be incomplete because the HTML is large, uses deferred Google client data, and naive visible text is nav/footer-heavy.

## Non-goals for v1

- No Playwright/browser rendering.
- No authenticated browsing or browser cookies.
- No form submission or interaction.
- No full web crawling; one URL per tool call.
- No search engine behavior.
