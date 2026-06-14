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
	keyHint,
	truncateHead,
	withFileMutationQueue,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatWebFetchCall(args as Partial<WebFetchParams>, theme));
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const typedResult = result as AgentToolResult<WebFetchDetails>;
			text.setText(formatWebFetchResult(typedResult, options.expanded, options.isPartial, context.isError, theme));
			return text;
		},
	});
}

function formatWebFetchCall(args: Partial<WebFetchParams>, theme: Theme): string {
	const url = formatUrlForDisplay(args.url);
	const urlText = url ? theme.fg("accent", url) : theme.fg("toolOutput", "...");
	const format = args.format ?? "markdown";
	const scope = args.scope ?? "main";
	const meta = theme.fg("dim", ` ${format}/${scope}`);
	return `${theme.fg("toolTitle", theme.bold("web_fetch"))} ${urlText}${meta}`;
}

function formatWebFetchResult(
	result: AgentToolResult<WebFetchDetails>,
	expanded: boolean,
	isPartial: boolean,
	isError: boolean,
	theme: Theme,
): string {
	const output = getTextResultOutput(result);

	if (isPartial) {
		return theme.fg("muted", "Fetching...");
	}

	if (isError) {
		return colorOutputLines(output || "web_fetch failed", theme, "error");
	}

	const details = result.details;
	if (!details) {
		return expanded ? colorOutputLines(output, theme) : formatFallbackSummary(output, theme);
	}

	if (expanded) {
		return output ? `\n${colorOutputLines(output, theme)}` : formatCompactResult(details, theme);
	}

	return formatCompactResult(details, theme);
}

function formatCompactResult(details: WebFetchDetails, theme: Theme): string {
	const lines: string[] = [];
	lines.push(`${formatStatus(details.status, theme)} ${theme.fg("accent", formatUrlForDisplay(details.finalUrl || details.url))}`);

	if (details.title) {
		lines.push(theme.fg("muted", details.title));
	}

	const meta = [details.format, details.scope, details.extraction, `${details.outputLines} lines`, formatSize(details.outputBytes)];
	if (details.responseTruncated) meta.push("response truncated");
	if (details.truncated) meta.push("output truncated");
	lines.push(theme.fg("dim", meta.join(" • ")));

	if (details.browserRecommended) {
		lines.push(theme.fg("warning", `⚠ Browser recommended: ${details.browserReason ?? "static extraction may be incomplete"}`));
	} else if (details.warnings.length > 0) {
		lines.push(theme.fg("warning", `⚠ ${details.warnings.length} extraction warning(s)`));
	}

	if (details.fullOutputPath) {
		lines.push(theme.fg("warning", `Full output: ${details.fullOutputPath}`));
	}

	if (details.rawHtmlPath && details.format !== "html") {
		lines.push(theme.fg("dim", `Raw HTML: ${details.rawHtmlPath}`));
	}

	lines.push(`${theme.fg("dim", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("dim", ")")}`);
	return lines.join("\n");
}

function formatFallbackSummary(output: string, theme: Theme): string {
	const lineCount = output ? output.split("\n").length : 0;
	const byteCount = Buffer.byteLength(output, "utf8");
	const summary = output ? `${lineCount} lines • ${formatSize(byteCount)}` : "no output";
	return `${theme.fg("muted", summary)} ${theme.fg("dim", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("dim", ")")}`;
}

function formatStatus(status: number, theme: Theme): string {
	if (status >= 200 && status < 400) return theme.fg("success", `✓ HTTP ${status}`);
	if (status >= 400) return theme.fg("error", `HTTP ${status}`);
	return theme.fg("warning", `HTTP ${status}`);
}

function formatUrlForDisplay(value?: string): string {
	if (!value) return "";
	try {
		const url = new URL(value);
		const path = url.pathname === "/" ? "" : url.pathname;
		const query = url.search ? "?…" : "";
		const hash = url.hash ? "#…" : "";
		return `${url.hostname}${path}${query}${hash}`;
	} catch {
		return value;
	}
}

function getTextResultOutput(result: AgentToolResult<WebFetchDetails>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text.replace(/\r/g, ""))
		.join("\n");
}

function colorOutputLines(output: string, theme: Theme, color: "toolOutput" | "error" = "toolOutput"): string {
	return output
		.split("\n")
		.map((line) => theme.fg(color, line.replace(/\t/g, "   ")))
		.join("\n");
}

async function writeTemp(prefix: string, filename: string, content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const path = join(dir, filename);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, content, "utf8");
	});
	return path;
}
