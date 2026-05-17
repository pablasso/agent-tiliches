# web-fetch extension contract

Status: MVP static `web_fetch` tool implemented in `index.ts`. Readability-grade Markdown extraction is still planned as the next step.

## Goal

Provide a model-callable `web_fetch` tool that fetches an HTTP(S) URL and returns readable content, usually Markdown, plus structured metadata that tells the agent how trustworthy/complete the extraction is.

The first implementation is static-only: it fetches the server response and parses HTML. Browser/Playwright rendering is intentionally out of scope for v1 and should be a separate extension or a future mode.

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

- `auto` (default): detect foldables and include their content only when they are confidently part of main content, such as `<details>` inside `main`/article. Always report detection metadata.
- `ignore`: do not include collapsed/controlled hidden content; only report that it exists.
- `include`: include likely foldable content from the selected scope, even if initially collapsed/hidden in HTML.

Foldable signals include:

- `<details>` / `<summary>`
- `aria-expanded="false"`
- `aria-controls`
- class/id names containing `accordion`, `collapse`, `expand`, `drawer`, `toggle`
- text like `show more`, `read more`, `expand_more`

The implementation should avoid expanding header/nav/footer accordions when `scope` is `main`.

### `hidden`

- `exclude` (default): remove hidden elements unless handled by `foldables`.
- `main`: include hidden elements only inside the selected main content candidate.
- `all`: include hidden elements from the selected scope. This may introduce a lot of junk.

Hidden signals include:

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
  extraction: "html-readability" | "html-cleaned" | "text" | "raw"; // MVP returns "html-cleaned" for HTML

  bytesFetched: number;
  outputBytes: number;
  outputLines: number;

  rawHtmlPath?: string;
  fullOutputPath?: string;

  truncated?: boolean;

  foldables: {
    detected: number;
    included: number;
    ignored: number;
    examples: string[];
  };

  hidden: {
    detected: number;
    included: number;
    ignored: number;
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
- Many foldables are detected but not included.
- The page has a root app shell with little readable body content.

For the Google Careers candidate-prep URL, the tool should likely warn that static extraction may be incomplete because the HTML is large, uses deferred Google client data, and naive visible text is nav/footer-heavy.

## Non-goals for v1

- No Playwright/browser rendering.
- No authenticated browsing or browser cookies.
- No form submission or interaction.
- No full web crawling; one URL per tool call.
- No search engine behavior.
