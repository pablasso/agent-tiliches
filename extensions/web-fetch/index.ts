/**
 * web-fetch MVP
 *
 * v1 is static-only: fetch a single HTTP(S) URL, decode textual responses,
 * return basic readable output, and report extraction warnings/metadata.
 * Proper Readability/Turndown Markdown extraction is planned as the next step.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const MAX_FETCH_BYTES = 10 * 1024 * 1024; // Cap raw response reads at 10 MiB for the MVP.
const DEFAULT_TIMEOUT_MS = 20_000;

const ModeSchema = StringEnum(["auto", "static"] as const, {
	description: 'Fetch/extraction strategy. v1 supports static fetching only; "auto" reports when browser rendering is recommended.',
	default: "auto",
});

const FormatSchema = StringEnum(["markdown", "text", "html"] as const, {
	description: "Output format returned to the model. Markdown is default and currently uses a basic HTML-to-Markdown conversion.",
	default: "markdown",
});

const ScopeSchema = StringEnum(["main", "page"] as const, {
	description: 'Which part of the HTML document to extract. "main" prefers main/article content and removes obvious chrome; "page" keeps page-wide content.',
	default: "main",
});

const FoldablesSchema = StringEnum(["auto", "ignore", "include"] as const, {
	description: "How to handle details/accordion/collapse-style content. v1 detects foldables but only includes content already present in static HTML.",
	default: "auto",
});

const HiddenSchema = StringEnum(["exclude", "main", "all"] as const, {
	description: "Whether to include generic hidden content. Hidden content is often nav/template junk; default excludes it unless kept by basic extraction.",
	default: "exclude",
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch" }),
	mode: Type.Optional(ModeSchema),
	format: Type.Optional(FormatSchema),
	scope: Type.Optional(ScopeSchema),
	foldables: Type.Optional(FoldablesSchema),
	hidden: Type.Optional(HiddenSchema),
});

type Mode = "auto" | "static";
type Format = "markdown" | "text" | "html";
type Scope = "main" | "page";
type Foldables = "auto" | "ignore" | "include";
type Hidden = "exclude" | "main" | "all";

interface NormalizedParams {
	url: string;
	mode: Mode;
	format: Format;
	scope: Scope;
	foldables: Foldables;
	hidden: Hidden;
}

interface DetectionInfo {
	detected: number;
	examples: string[];
	detailsCount: number;
}

interface HiddenInfo {
	detected: number;
}

interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	mode: Mode;
	format: Format;
	scope: Scope;
	extraction: "html-cleaned" | "text" | "raw";
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
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a single HTTP(S) URL using a static HTTP request and return readable content. Supports textual responses only. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file when truncated. v1 does not run JavaScript or use a browser.`,
		promptSnippet: "Fetch a URL with a static HTTP request and return readable content plus extraction warnings/metadata",
		promptGuidelines: [
			"Use web_fetch when the user asks to read, fetch, or summarize a URL. Prefer markdown output unless raw HTML or plain text is explicitly requested.",
			"Treat web_fetch warnings, especially browserRecommended, as uncertainty about page completeness; tell the user when browser rendering may be needed.",
		],
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal) {
			const input = normalizeParams(params as Partial<NormalizedParams> & { url: string });
			const requestedUrl = normalizeHttpUrl(input.url);

			const warnings: string[] = [];
			const response = await fetchWithTimeout(requestedUrl, signal);
			const finalUrl = response.url || requestedUrl;
			const status = response.status;
			const contentType = response.headers.get("content-type") ?? undefined;

			if (!response.ok) {
				warnings.push(`HTTP status ${response.status} ${response.statusText}`.trim());
			}

			if (contentType && !isTextualContentType(contentType)) {
				throw new Error(`web_fetch v1 only supports textual responses. Got Content-Type: ${contentType}`);
			}

			const { bytes, truncated: responseTruncated } = await readResponseBytes(response, MAX_FETCH_BYTES);
			if (responseTruncated) {
				warnings.push(`Response body exceeded ${formatSize(MAX_FETCH_BYTES)} and was truncated before extraction.`);
			}

			if (!contentType && isProbablyBinary(bytes)) {
				throw new Error("web_fetch v1 only supports textual responses; response appears to be binary.");
			}

			const body = decodeBytes(bytes, contentType);
			const isHtml = looksLikeHtml(contentType, body);
			const title = isHtml ? extractTitle(body) : undefined;
			const foldableInfo = isHtml ? detectFoldables(body) : { detected: 0, examples: [], detailsCount: 0 };
			const hiddenInfo = isHtml ? detectHidden(body) : { detected: 0 };

			let rawHtmlPath: string | undefined;
			if (isHtml) {
				rawHtmlPath = await writeTemp("pi-web-fetch-", "raw.html", body);
			}

			let output: string;
			let extraction: WebFetchDetails["extraction"] = "raw";
			if (isHtml) {
				const cleanedHtml = cleanHtml(body, input);
				extraction = "html-cleaned";
				if (input.format === "html") {
					output = cleanedHtml;
				} else if (input.format === "text") {
					output = htmlToPlainText(cleanedHtml);
				} else {
					output = htmlToBasicMarkdown(cleanedHtml, finalUrl);
					warnings.push("Markdown output uses MVP basic HTML conversion; readability-grade extraction is not implemented yet.");
				}
			} else {
				extraction = "text";
				output = normalizeText(body);
				if (input.format === "html") {
					warnings.push("Requested HTML output, but response is not HTML; returned decoded text instead.");
				}
			}

			if (!output.trim()) {
				warnings.push("Static extraction produced no readable content.");
			}

			const foldablesIncluded = input.foldables === "ignore" ? 0 : foldableInfo.detailsCount;
			const foldablesIgnored = Math.max(0, foldableInfo.detected - foldablesIncluded);
			if (input.foldables === "include" && foldablesIgnored > 0) {
				warnings.push(
					"foldables=include can only include foldable content already present in static HTML; JavaScript-controlled panels may still be missing.",
				);
			}
			if (foldableInfo.detected > 0 && input.foldables !== "include") {
				warnings.push(`Detected ${foldableInfo.detected} foldable/collapsible signal(s); pass foldables=include to include static <details> content, or use a future browser mode for JS-controlled panels.`);
			}

			const hiddenIncluded = input.hidden === "exclude" ? 0 : hiddenInfo.detected;
			const hiddenIgnored = Math.max(0, hiddenInfo.detected - hiddenIncluded);
			if (hiddenInfo.detected > 0 && input.hidden === "exclude") {
				warnings.push(`Detected ${hiddenInfo.detected} hidden-content signal(s); hidden content was excluded where the basic cleaner could identify it.`);
			}

			const browserAssessment = assessBrowserNeed({
				isHtml,
				rawHtml: body,
				output,
				foldablesDetected: foldableInfo.detected,
				foldablesIgnored,
			});
			if (input.mode === "auto" && browserAssessment.recommended) {
				warnings.push(`Browser rendering recommended: ${browserAssessment.reason}`);
			}

			const outputBytes = Buffer.byteLength(output, "utf8");
			const outputLines = countLines(output);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				fullOutputPath = await writeTemp("pi-web-fetch-", input.format === "html" ? "output.html" : "output.txt", output);
				resultText += `\n\n[web_fetch output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${fullOutputPath}]`;
			}

			if (warnings.length > 0) {
				resultText += `\n\n[web_fetch warnings]\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
			}

			const details: WebFetchDetails = {
				url: requestedUrl,
				finalUrl,
				status,
				contentType,
				title,
				mode: input.mode,
				format: input.format,
				scope: input.scope,
				extraction,
				bytesFetched: bytes.byteLength,
				outputBytes,
				outputLines,
				rawHtmlPath,
				fullOutputPath,
				truncated: truncation.truncated,
				responseTruncated,
				foldables: {
					detected: foldableInfo.detected,
					included: foldablesIncluded,
					ignored: foldablesIgnored,
					examples: foldableInfo.examples,
				},
				hidden: {
					detected: hiddenInfo.detected,
					included: hiddenIncluded,
					ignored: hiddenIgnored,
				},
				warnings,
				browserRecommended: input.mode === "auto" ? browserAssessment.recommended : false,
				browserReason: input.mode === "auto" ? browserAssessment.reason : undefined,
			};

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},
	});
}

function normalizeParams(params: Partial<NormalizedParams> & { url: string }): NormalizedParams {
	return {
		url: params.url,
		mode: params.mode ?? "auto",
		format: params.format ?? "markdown",
		scope: params.scope ?? "main",
		foldables: params.foldables ?? "auto",
		hidden: params.hidden ?? "exclude",
	};
}

function normalizeHttpUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid URL: ${value}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`web_fetch only supports http(s) URLs. Got protocol: ${url.protocol}`);
	}

	return url.toString();
}

async function fetchWithTimeout(url: string, outerSignal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS);

	const onAbort = () => controller.abort(outerSignal?.reason);
	if (outerSignal) {
		if (outerSignal.aborted) onAbort();
		else outerSignal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		return await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; Pi web_fetch/0.1; +https://pi.dev)",
				accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
			},
		});
	} catch (error) {
		if (controller.signal.aborted) {
			const reason = controller.signal.reason;
			if (reason instanceof Error) throw new Error(`web_fetch failed: ${reason.message}`);
			throw new Error("web_fetch was aborted");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		outerSignal?.removeEventListener("abort", onAbort);
	}
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		return bytes.byteLength > maxBytes ? { bytes: bytes.slice(0, maxBytes), truncated: true } : { bytes, truncated: false };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;

		if (total + value.byteLength > maxBytes) {
			const remaining = maxBytes - total;
			if (remaining > 0) {
				chunks.push(value.slice(0, remaining));
				total += remaining;
			}
			truncated = true;
			await reader.cancel();
			break;
		}

		chunks.push(value);
		total += value.byteLength;
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { bytes, truncated };
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return (
		normalized.startsWith("text/") ||
		normalized.includes("html") ||
		normalized.includes("json") ||
		normalized.includes("xml") ||
		normalized.includes("javascript") ||
		normalized.includes("svg") ||
		normalized.includes("x-www-form-urlencoded")
	);
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const sample = bytes.slice(0, Math.min(bytes.byteLength, 4096));
	if (sample.byteLength === 0) return false;
	let suspicious = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		if (byte < 8 || (byte > 13 && byte < 32)) suspicious++;
	}
	return suspicious / sample.byteLength > 0.2;
}

function decodeBytes(bytes: Uint8Array, contentType?: string): string {
	const charset = contentType?.match(/charset\s*=\s*([^;]+)/i)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

function looksLikeHtml(contentType: string | undefined, body: string): boolean {
	if (contentType?.toLowerCase().includes("html")) return true;
	return /<!doctype\s+html|<html\b|<body\b|<main\b|<article\b/i.test(body.slice(0, 20_000));
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return undefined;
	const title = decodeHtmlEntities(stripTags(match[1])).trim();
	return title || undefined;
}

function cleanHtml(html: string, params: NormalizedParams): string {
	let working = selectScope(html, params.scope);
	working = stripNoise(working);

	if (params.scope === "main") {
		working = removeTagPairs(working, ["header", "nav", "footer", "aside"]);
	}

	if (params.foldables === "ignore") {
		working = removeTagPairs(working, ["details"]);
	}

	if (params.hidden === "exclude") {
		working = removeHiddenElements(working);
	}

	return normalizeHtmlWhitespace(working).trim();
}

function selectScope(html: string, scope: Scope): string {
	const body = extractElement(html, "body") ?? html;
	if (scope === "page") return body;

	return extractElement(body, "main") ?? extractElement(body, "article") ?? extractRoleMain(body) ?? body;
}

function extractElement(html: string, tag: string): string | undefined {
	const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
	return html.match(pattern)?.[1];
}

function extractRoleMain(html: string): string | undefined {
	const match = html.match(/<([a-zA-Z0-9:-]+)\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/\1>/i);
	return match?.[2];
}

function stripNoise(html: string): string {
	let working = html.replace(/<!--[\s\S]*?-->/g, "\n");
	working = removeTagPairs(working, ["script", "style", "noscript", "svg", "canvas", "template"]);
	working = working.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "\n");
	return working;
}

function removeTagPairs(html: string, tags: string[]): string {
	let working = html;
	for (const tag of tags) {
		working = working.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "\n");
	}
	return working;
}

function removeHiddenElements(html: string): string {
	const hiddenAttr = String.raw`(?:\bhidden\b|\baria-hidden\s*=\s*["']?true["']?|\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])`;
	return html.replace(new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*${hiddenAttr})[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), "\n");
}

function htmlToBasicMarkdown(html: string, baseUrl: string): string {
	let working = html;

	working = working.replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
		const alt = decodeHtmlEntities(getAttribute(attrs, "alt") ?? "").trim();
		const src = resolveMaybeUrl(getAttribute(attrs, "src"), baseUrl);
		if (!src) return alt ? alt : "";
		return alt ? `![${escapeMarkdownLinkText(alt)}](${src})` : `![](${src})`;
	});

	working = working.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) => {
		const label = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
		const href = resolveMaybeUrl(getAttribute(attrs, "href"), baseUrl);
		if (!label) return "";
		if (!href || href.startsWith("javascript:")) return label;
		return `[${escapeMarkdownLinkText(label)}](${href})`;
	});

	for (let level = 6; level >= 1; level--) {
		working = working.replace(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"), (_match, inner: string) => {
			const text = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
			return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "\n";
		});
	}

	working = working.replace(/<br\s*\/?>/gi, "\n");
	working = working.replace(/<\/p\s*>/gi, "\n\n");
	working = working.replace(/<\/div\s*>/gi, "\n");
	working = working.replace(/<\/section\s*>/gi, "\n\n");
	working = working.replace(/<li\b[^>]*>/gi, "\n- ");
	working = working.replace(/<\/li\s*>/gi, "\n");
	working = working.replace(/<\/tr\s*>/gi, "\n");
	working = working.replace(/<t[dh]\b[^>]*>/gi, " ");
	working = working.replace(/<\/t[dh]\s*>/gi, " | ");

	return normalizeText(decodeHtmlEntities(stripTags(working)));
}

function htmlToPlainText(html: string): string {
	let working = html;
	working = working.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_match, inner: string) => decodeHtmlEntities(stripTags(inner)));
	working = working.replace(/<br\s*\/?>/gi, "\n");
	working = working.replace(/<\/(p|div|section|article|main|h[1-6]|li|tr)\s*>/gi, "\n");
	working = working.replace(/<li\b[^>]*>/gi, "\n- ");
	return normalizeText(decodeHtmlEntities(stripTags(working)));
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, " ");
}

function getAttribute(attrs: string, name: string): string | undefined {
	const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = attrs.match(pattern);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function resolveMaybeUrl(value: string | undefined, baseUrl: string): string | undefined {
	if (!value) return undefined;
	if (/^(?:mailto|tel|javascript):/i.test(value)) return value;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return value;
	}
}

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/([\\\]])/g, "\\$1");
}

function normalizeHtmlWhitespace(html: string): string {
	return html.replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n");
}

function normalizeText(text: string): string {
	const lines = text
		.replace(/\r/g, "")
		.replace(/\u00a0/g, " ")
		.split("\n")
		.map((line) => line.replace(/[\t ]+/g, " ").trim())
		.filter(Boolean);

	const normalized: string[] = [];
	for (const line of lines) {
		if (line === normalized[normalized.length - 1]) continue;
		normalized.push(line);
	}

	return normalized.join("\n").trim();
}

function decodeHtmlEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		ndash: "–",
		mdash: "—",
		lsquo: "‘",
		rsquo: "’",
		ldquo: "“",
		rdquo: "”",
		bull: "•",
		hellip: "…",
	};

	return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const codePoint = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
		}
		if (body.startsWith("#")) {
			const codePoint = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
		}
		return named[body.toLowerCase()] ?? entity;
	});
}

function detectFoldables(html: string): DetectionInfo {
	const examples: string[] = [];
	const patterns = [
		/<details\b[^>]*>/gi,
		/aria-expanded\s*=\s*["']false["']/gi,
		/aria-controls\s*=\s*["'][^"']+["']/gi,
		/\b(?:class|id)\s*=\s*["'][^"']*(?:accordion|collapse|expand|drawer|toggle)[^"']*["']/gi,
		/>\s*(?:show more|read more|expand_more)\s*</gi,
	];

	let detected = 0;
	for (const pattern of patterns) {
		for (const match of html.matchAll(pattern)) {
			detected++;
			if (examples.length < 5) {
				examples.push(snippetAround(html, match.index ?? 0));
			}
		}
	}

	return {
		detected,
		examples: dedupe(examples).slice(0, 5),
		detailsCount: countMatches(html, /<details\b/gi),
	};
}

function detectHidden(html: string): HiddenInfo {
	const detected =
		countMatches(html, /\bhidden\b/gi) +
		countMatches(html, /aria-hidden\s*=\s*["']true["']/gi) +
		countMatches(html, /display\s*:\s*none/gi) +
		countMatches(html, /visibility\s*:\s*hidden/gi);
	return { detected };
}

function countMatches(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length;
}

function snippetAround(text: string, index: number): string {
	const start = Math.max(0, index - 160);
	const end = Math.min(text.length, index + 240);
	return normalizeText(decodeHtmlEntities(stripTags(text.slice(start, end)))).slice(0, 240);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function assessBrowserNeed(input: {
	isHtml: boolean;
	rawHtml: string;
	output: string;
	foldablesDetected: number;
	foldablesIgnored: number;
}): { recommended: boolean; reason?: string } {
	if (!input.isHtml) return { recommended: false };

	const rawBytes = Buffer.byteLength(input.rawHtml, "utf8");
	const outputChars = input.output.replace(/\s+/g, " ").trim().length;
	const scriptCount = countMatches(input.rawHtml, /<script\b/gi);
	const clientMarkers = /AF_initData|jscontroller=|<c-wiz\b|__NEXT_DATA__|data-reactroot|ng-version|id=["']root["']|id=["']app["']/i.test(input.rawHtml);

	if (rawBytes > 200_000 && outputChars < 5_000) {
		return { recommended: true, reason: "large HTML response produced very little readable static output" };
	}

	if (clientMarkers && scriptCount > 10 && outputChars < 10_000) {
		return { recommended: true, reason: "page appears to rely on client/deferred rendering and static extraction may be incomplete" };
	}

	if (input.foldablesDetected >= 10 && input.foldablesIgnored >= 10) {
		return { recommended: true, reason: "many collapsible/foldable elements were detected but not expanded by static extraction" };
	}

	return { recommended: false };
}

async function writeTemp(prefix: string, filename: string, content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const path = join(dir, filename);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, content, "utf8");
	});
	return path;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}
