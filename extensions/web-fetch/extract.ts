import type { Foldables, Format, Hidden, NormalizedParams, Scope } from "./types.ts";

export interface HtmlExtractionResult {
	output: string;
	title?: string;
	cleanedHtml: string;
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
}

interface FoldableDetection {
	detected: number;
	staticDetails: number;
	dynamicSignals: number;
	examples: string[];
}

interface HiddenDetection {
	detected: number;
}

/**
 * MVP HTML extraction.
 *
 * This intentionally uses lightweight regex cleanup to avoid adding dependencies in step #3.
 * Step #4 should replace this file's HTML handling with a real DOM parser plus
 * Readability/Turndown. Do not grow this into a full HTML parser.
 */
export function extractHtml(html: string, input: NormalizedParams, finalUrl: string): HtmlExtractionResult {
	const warnings: string[] = [];
	const title = extractTitle(html);
	const baseUrl = extractBaseHref(html, finalUrl);

	let working = selectScope(html, input.scope);
	working = stripNoise(working);
	if (input.scope === "main") {
		working = removeTagPairs(working, ["header", "nav", "footer", "aside"]);
	}

	const foldableDetection = detectFoldables(working);
	const hiddenDetection = detectHidden(working);

	const foldables = summarizeFoldables(foldableDetection, input.foldables);
	if (input.foldables === "ignore") {
		working = removeTagPairs(working, ["details"]);
	}
	if (foldableDetection.detected > foldables.included) {
		warnings.push(foldableWarning(foldableDetection, foldables, input.foldables));
	}

	const hidden = summarizeHidden(hiddenDetection, input.hidden);
	if (input.hidden === "exclude") {
		working = removeHiddenElements(working);
	}
	if (hiddenDetection.detected > 0) {
		warnings.push(hiddenWarning(hiddenDetection, hidden, input.hidden));
	}

	const cleanedHtml = normalizeHtmlWhitespace(working).trim();
	const output = renderOutput(cleanedHtml, input.format, baseUrl);

	return { output, title, cleanedHtml, foldables, hidden, warnings };
}

export function renderText(body: string): string {
	return normalizeText(body);
}

export function looksLikeHtml(contentType: string | undefined, body: string): boolean {
	if (contentType?.toLowerCase().includes("html")) return true;
	return /<!doctype\s+html|<html\b|<body\b|<main\b|<article\b/i.test(body.slice(0, 20_000));
}

function renderOutput(html: string, format: Format, baseUrl: string): string {
	if (format === "html") return html;
	if (format === "text") return htmlToPlainText(html);
	return htmlToBasicMarkdown(html, baseUrl);
}

function summarizeFoldables(detection: FoldableDetection, mode: Foldables): HtmlExtractionResult["foldables"] {
	const included = mode === "ignore" ? 0 : detection.staticDetails;
	return {
		detected: detection.detected,
		included,
		ignored: Math.max(0, detection.detected - included),
		examples: detection.examples,
	};
}

function summarizeHidden(detection: HiddenDetection, mode: Hidden): HtmlExtractionResult["hidden"] {
	const included = mode === "exclude" ? 0 : detection.detected;
	return {
		detected: detection.detected,
		included,
		ignored: Math.max(0, detection.detected - included),
	};
}

function foldableWarning(
	detection: FoldableDetection,
	foldables: HtmlExtractionResult["foldables"],
	mode: Foldables,
): string {
	if (mode === "ignore") {
		return `Detected ${detection.detected} foldable/collapsible signal(s) in selected scope; foldables=ignore removed static <details> content and did not expand JS/ARIA-controlled panels.`;
	}
	return `Detected ${detection.detected} foldable/collapsible signal(s) in selected scope; included ${foldables.included} static <details> section(s), but ${foldables.ignored} JS/ARIA-controlled signal(s) were not expanded by static extraction.`;
}

function hiddenWarning(detection: HiddenDetection, hidden: HtmlExtractionResult["hidden"], mode: Hidden): string {
	if (mode === "exclude") {
		return `Detected ${detection.detected} hidden-content signal(s) in selected scope; v1 removed elements it could identify before extraction.`;
	}
	return `Detected ${detection.detected} hidden-content signal(s) in selected scope; included ${hidden.included} because hidden=${mode}.`;
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
	return html.replace(new RegExp(`<([a-zA-Z0-9:-]+)\\b(?=[^>]*${hiddenAttr})[^>]*>[\\s\\S]*?<\/\\1>`, "gi"), "\n");
}

function htmlToBasicMarkdown(html: string, baseUrl: string): string {
	let working = html;

	working = working.replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
		const alt = decodeHtmlEntities(getAttribute(attrs, "alt") ?? "").trim();
		const src = resolveMaybeUrl(getAttribute(attrs, "src"), baseUrl);
		if (!src) return alt || "";
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

	working = working.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_match, inner: string) => {
		const text = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
		return text ? `\n\n**${text}**\n\n` : "\n";
	});
	working = working.replace(/<br\s*\/?>/gi, "\n");
	working = working.replace(/<\/(p|section|article|main|details)\s*>/gi, "\n\n");
	working = working.replace(/<\/div\s*>/gi, "\n");
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
	working = working.replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|details|summary)\s*>/gi, "\n");
	working = working.replace(/<li\b[^>]*>/gi, "\n- ");
	return normalizeText(decodeHtmlEntities(stripTags(working)));
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return undefined;
	const title = decodeHtmlEntities(stripTags(match[1])).trim();
	return title || undefined;
}

function extractBaseHref(html: string, fallback: string): string {
	const baseTag = html.match(/<base\b([^>]*)>/i)?.[1];
	const href = baseTag ? getAttribute(baseTag, "href") : undefined;
	if (!href) return fallback;
	try {
		return new URL(href, fallback).toString();
	} catch {
		return fallback;
	}
}

function detectFoldables(html: string): FoldableDetection {
	const examples: string[] = [];
	const detailsMatches = [...html.matchAll(/<details\b[^>]*>/gi)];
	for (const match of detailsMatches) {
		if (examples.length < 5) examples.push(snippetAround(html, match.index ?? 0));
	}

	const dynamicPatterns = [
		/aria-expanded\s*=\s*["']false["']/gi,
		/aria-controls\s*=\s*["'][^"']+["']/gi,
		/\b(?:class|id)\s*=\s*["'][^"']*(?:accordion|collapse|expand|drawer|toggle)[^"']*["']/gi,
		/>\s*(?:show more|read more|expand_more)\s*</gi,
	];

	let dynamicSignals = 0;
	for (const pattern of dynamicPatterns) {
		for (const match of html.matchAll(pattern)) {
			dynamicSignals++;
			if (examples.length < 5) examples.push(snippetAround(html, match.index ?? 0));
		}
	}

	return {
		detected: detailsMatches.length + dynamicSignals,
		staticDetails: detailsMatches.length,
		dynamicSignals,
		examples: dedupe(examples).slice(0, 5),
	};
}

function detectHidden(html: string): HiddenDetection {
	const detected =
		countMatches(html, /<[^>]+\bhidden(?:[\s=>]|$)/gi) +
		countMatches(html, /aria-hidden\s*=\s*["']true["']/gi) +
		countMatches(html, /style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["']/gi) +
		countMatches(html, /style\s*=\s*["'][^"']*visibility\s*:\s*hidden[^"']*["']/gi);
	return { detected };
}

export function countMatches(text: string, pattern: RegExp): number {
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

export function normalizeText(text: string): string {
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
