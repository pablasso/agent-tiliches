---
name: brave-search
description: Web search and readable page-content extraction via the Brave Search API. Use when the user asks to search the web, find current information, locate documentation, or fetch article/page content without browser automation.
license: MIT
---

# Brave Search

Use Brave Search API for web search and static page-content extraction. This is lightweight and does not require a browser.

## Setup

Requires a Brave Search API key:

1. Create an account at https://api-dashboard.search.brave.com/register
2. Create a Search API subscription/key
3. Export the key in the shell environment used to run pi:

```bash
export BRAVE_API_KEY="your-api-key-here"
```

Install dependencies once:

```bash
cd {baseDir}
npm install
```

## Search

```bash
{baseDir}/search.js "query"                  # 5 results
{baseDir}/search.js "query" -n 10            # up to 20 results
{baseDir}/search.js "query" --content        # include readable page content
{baseDir}/search.js "query" --country DE     # country-specific results
{baseDir}/search.js "query" --freshness pw   # past week
{baseDir}/search.js "+pablasso"             # force an exact term
```

If a single-token query returns only fuzzy matches, the tool prints a hint suggesting `+term` for exact username/package/code searches.

Options:

- `-n, --count <num>`: number of results; default `5`, max `20`
- `--content`: fetch readable markdown content for each result
- `--country <code>`: two-letter country code; default `US`
- `--freshness <period>`: `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`

If `BRAVE_API_KEY` is missing, stop and tell the user how to configure it.

## Extract Page Content

```bash
{baseDir}/content.js https://example.com/article
```

Outputs the readable portion of the page as markdown. Static extraction may miss JavaScript-rendered content; use the browser-tools skill when a page requires browser rendering.

## When to Use

- Searching for current information or facts
- Finding documentation/API references
- Fetching readable content from a specific URL
- Avoiding browser automation for simple web lookup tasks
