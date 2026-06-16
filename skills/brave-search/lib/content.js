import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function htmlToMarkdown(html) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  turndown.use(gfm);
  turndown.remove(["script", "style", "noscript", "svg", "canvas", "iframe"]);
  turndown.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });

  return turndown
    .turndown(html)
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchReadableContent(url, options = {}) {
  const { timeoutMs = 15000, maxChars = 0 } = options;
  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  let title = "";
  let markdown = "";

  if (!contentType.includes("html") && contentType.includes("text/plain")) {
    markdown = body.trim();
  } else {
    const dom = new JSDOM(body, { url });
    const article = new Readability(dom.window.document).parse();

    if (article?.content) {
      title = article.title || "";
      markdown = htmlToMarkdown(article.content);
    } else {
      const fallbackDom = new JSDOM(body, { url });
      const document = fallbackDom.window.document;
      document
        .querySelectorAll("script, style, noscript, nav, header, footer, aside")
        .forEach((el) => el.remove());

      title = document.querySelector("title")?.textContent?.trim() || "";
      const main =
        document.querySelector(
          "main, article, [role='main'], .content, #content",
        ) || document.body;
      markdown = htmlToMarkdown(main?.innerHTML || "");
    }
  }

  if (maxChars > 0 && markdown.length > maxChars) {
    markdown = `${markdown.slice(0, maxChars).trim()}\n\n…`;
  }

  return { title, markdown };
}
