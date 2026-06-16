#!/usr/bin/env node
import { fetchReadableContent } from "./lib/content.js";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? console.log : console.error;
  stream("Usage: search.js <query> [options]");
  stream("");
  stream("Options:");
  stream("  -n, --count <num>        Number of results (default: 5, max: 20)");
  stream(
    "  --content               Fetch readable markdown content for each result",
  );
  stream("  --country <code>        Two-letter country code (default: US)");
  stream("  --freshness <period>    pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD");
  stream("  -h, --help              Show this help");
  stream("");
  stream("Environment:");
  stream("  BRAVE_API_KEY           Required Brave Search API key");
  stream("");
  stream("Examples:");
  stream('  search.js "javascript async await"');
  stream('  search.js "rust programming" -n 10');
  stream('  search.js "news today" --freshness pd');
  stream('  search.js "pi coding agent docs" --content');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const queryParts = [];
  const options = {
    count: 5,
    content: false,
    country: "US",
    freshness: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--content") {
      options.content = true;
      continue;
    }
    if (arg === "-n" || arg === "--count") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a number`);
      options.count = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--country") {
      const value = argv[++i];
      if (!value)
        throw new Error("--country requires a two-letter country code");
      options.country = value.toUpperCase();
      continue;
    }
    if (arg === "--freshness") {
      const value = argv[++i];
      if (!value) throw new Error("--freshness requires a period");
      options.freshness = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    queryParts.push(arg);
  }

  if (!Number.isFinite(options.count) || options.count < 1) {
    throw new Error("Result count must be a positive number");
  }
  options.count = Math.min(Math.trunc(options.count), 20);

  const query = queryParts.join(" ").trim();
  if (!query) usage(1);

  return { query, options };
}

async function searchBrave(query, options) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BRAVE_API_KEY is required. Create a key at https://api-dashboard.search.brave.com/app/keys and export it in your shell.",
    );
  }

  const params = new URLSearchParams({
    q: query,
    count: String(options.count),
    country: options.country,
  });
  if (options.freshness) params.set("freshness", options.freshness);

  const response = await fetch(`${BRAVE_WEB_SEARCH_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Brave Search API HTTP ${response.status}: ${response.statusText}\n${errorText}`,
    );
  }

  const data = await response.json();
  return (data.web?.results || []).slice(0, options.count).map((result) => ({
    title: result.title || "",
    url: result.url || "",
    description: result.description || "",
    age: result.age || result.page_age || "",
  }));
}

function printResults(results) {
  results.forEach((result, index) => {
    console.log(`--- Result ${index + 1} ---`);
    console.log(`Title: ${result.title}`);
    console.log(`Link: ${result.url}`);
    if (result.age) console.log(`Age: ${result.age}`);
    if (result.description) console.log(`Snippet: ${result.description}`);
    if (result.content) console.log(`Content:\n${result.content}`);
    console.log("");
  });
}

try {
  const { query, options } = parseArgs(process.argv.slice(2));
  const results = await searchBrave(query, options);

  if (results.length === 0) {
    console.error("No results found.");
    process.exit(0);
  }

  if (options.content) {
    for (const result of results) {
      try {
        console.error(`Fetching content: ${result.url}`);
        const { markdown } = await fetchReadableContent(result.url, {
          timeoutMs: 10000,
          maxChars: 5000,
        });
        result.content = markdown || "(Could not extract content)";
      } catch (error) {
        result.content = `(Content extraction error: ${error.message})`;
      }
    }
  }

  printResults(results);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
