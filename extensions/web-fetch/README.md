# web-fetch extension contract

Status: static `web_fetch` tool implemented with DOM parsing, Mozilla Readability main-content extraction, Turndown Markdown conversion, and extraction-quality warnings.

## Goal

Provide a model-callable `web_fetch` tool that fetches one HTTP(S) URL and returns readable content, usually Markdown, plus structured metadata that tells the agent how trustworthy/complete the extraction is.

`web_fetch` is intentionally static-only: it fetches the server response, parses HTML with a DOM, extracts readable main content with Mozilla Readability when possible, and converts HTML to Markdown with Turndown. It does not run JavaScript, click controls, or use Playwright. If static extraction looks incomplete, it reports `browserRecommended: true` so a future browser/navigation skill can handle the page case-by-case.

## Files

- `index.ts` - Pi tool registration, output truncation, and temp-file writing.
- `core.ts` - tool orchestration that can be smoke-tested outside Pi.
- `fetch.ts` - HTTP fetch, timeout/abort, content-type checks, decoding.
- `extract.ts` - high-level HTML extraction orchestration.
- `dom.ts` - DOM parsing, cleanup, scope selection, URL rewriting.
- `detect.ts` - static foldable/hidden element detection and warnings.
- `quality.ts` - extraction quality heuristics and browser recommendation logic.
- `render.ts` - HTML/Text/Markdown rendering.
- `text.ts` - text normalization helpers.
- `types.ts` - shared types and constants.

Run the smoke check from the repo root:

```bash
npm run check
```

The smoke test covers static extraction, main-scope chrome filtering, relative URL rewriting, static `<details>` inclusion, hidden-content removal, dynamic foldable detection, timeout handling, and browser-navigation quality warnings for client-rendered app shells.

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

- `format`: `"markdown"`
- `scope`: `"main"`

The tool has fixed static behavior:

- includes normal HTML content, including static `<details>` content already present in the response
- removes identifiable generic hidden content before extraction
- detects JavaScript/ARIA-controlled foldables but does not expand them
- detects likely client-rendered/sparse/nav-heavy output and recommends browser navigation when appropriate

## Parameters

```ts
type WebFetchParams = {
  /** Absolute http(s) URL to fetch. */
  url: string;

  /** Output format returned to the model. */
  format?: "markdown" | "text" | "html";

  /** Which part of the document to extract. */
  scope?: "main" | "page";
};
```

### `format`

- `markdown` (default): best for agent reading.
- `text`: plain text without Markdown links/headings.
- `html`: cleaned HTML, mainly for debugging extraction issues.

### `scope`

- `main` (default): prefer article/main/body content and remove/ignore obvious nav/header/footer/sidebar noise.
- `page`: return cleaned page-wide content. Useful when the page is not article-like or when navigation/footer content matters.

## Result contract

The tool returns model-visible content plus structured details.

```ts
type WebFetchDetails = {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;

  format: "markdown" | "text" | "html";
  scope: "main" | "page";
  extraction: "html-readability" | "html-cleaned" | "text" | "raw";

  bytesFetched: number;
  outputBytes: number;
  outputLines: number;

  rawHtmlPath?: string;
  fullOutputPath?: string;
  truncated?: boolean;
  responseTruncated?: boolean;

  foldables: {
    detected: number; // static <details> plus JS/ARIA-controlled foldable signals in selected non-chrome scope
    included: number; // static <details> sections included in output
    ignored: number; // JS/ARIA-controlled foldable signals not expanded by static extraction
    examples: string[];
  };

  hidden: {
    detected: number; // meaningful hidden elements in selected non-chrome scope
    included: number; // always 0 for generic hidden content
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

For the Google Careers candidate-prep URL, `web_fetch` should warn that extraction may be incomplete because the HTML is large, uses deferred Google client data, and naive visible text is nav/footer-heavy. A separate browser/navigation skill is the intended future follow-up for that class of page.

## Non-goals

- No Playwright/browser rendering.
- No authenticated browsing or browser cookies.
- No form submission or interaction.
- No full web crawling; one URL per tool call.
- No search engine behavior.
