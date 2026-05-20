/**
 * web-fetch Pi extension.
 *
 * Fetch a single HTTP(S) URL, return readable Markdown/text/HTML output,
 * and report extraction warnings/metadata. This tool is static-only.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { runWebFetch } from "./core.ts";
import type { WebFetchDetails, WebFetchParams } from "./types.ts";

const FormatSchema = StringEnum(["markdown", "text", "html"] as const, {
	description: "Output format returned to the model. Markdown is default and uses Readability/Turndown for HTML pages.",
	default: "markdown",
});

const ScopeSchema = StringEnum(["main", "page"] as const, {
	description: 'Which part of the HTML document to extract. "main" prefers main/article content and removes obvious chrome; "page" keeps page-wide content.',
	default: "main",
});

const WebFetchParamsSchema = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch" }),
	format: Type.Optional(FormatSchema),
	scope: Type.Optional(ScopeSchema),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a single HTTP(S) URL using a static HTTP request and return readable content. Supports textual responses only. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated. Does not run JavaScript or use a browser.`,
		promptSnippet: "Fetch a URL with a static HTTP request and return readable content plus extraction warnings/metadata",
		promptGuidelines: [
			"Use web_fetch when the user asks to read, fetch, or summarize a URL. Prefer markdown output unless raw HTML or plain text is explicitly requested.",
			"Treat web_fetch warnings, especially browserRecommended, as uncertainty about page completeness; tell the user when browser navigation may be needed.",
		],
		parameters: WebFetchParamsSchema,

		async execute(_toolCallId, params, signal) {
			const result = await runWebFetch(params as WebFetchParams, { signal });
			const details: WebFetchDetails = { ...result.details };

			if (result.rawHtml) {
				details.rawHtmlPath = await writeTemp("pi-web-fetch-", "raw.html", result.rawHtml);
			}

			const truncation = truncateHead(result.output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				details.fullOutputPath = await writeTemp("pi-web-fetch-", details.format === "html" ? "output.html" : "output.txt", result.output);
				resultText += `\n\n[web_fetch output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${details.fullOutputPath}]`;
			}

			details.truncated = truncation.truncated;
			details.outputBytes = Buffer.byteLength(result.output, "utf8");
			details.outputLines = result.output ? result.output.split("\n").length : 0;

			if (details.warnings.length > 0) {
				resultText += `\n\n[web_fetch warnings]\n${details.warnings.map((warning) => `- ${warning}`).join("\n")}`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},
	});
}

async function writeTemp(prefix: string, filename: string, content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const path = join(dir, filename);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, content, "utf8");
	});
	return path;
}
