#!/usr/bin/env node
import { fetchReadableContent } from "./lib/content.js";

const url = process.argv[2];

if (!url || url === "-h" || url === "--help") {
  console.error("Usage: content.js <url>");
  console.error("");
  console.error("Extract readable webpage content as markdown.");
  console.error("");
  console.error("Examples:");
  console.error("  content.js https://example.com/article");
  process.exit(url ? 0 : 1);
}

try {
  const { title, markdown } = await fetchReadableContent(url);

  if (!markdown || markdown.length < 20) {
    throw new Error("Could not extract readable content from this page.");
  }

  if (title) {
    console.log(`# ${title}\n`);
  }
  console.log(markdown);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
