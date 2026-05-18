import TurndownService from "turndown";
import { createDom, stripRawNoise } from "./dom.ts";
import { normalizeMarkdown, normalizeText } from "./text.ts";
import type { Format } from "./types.ts";

export function renderOutput(cleanedHtml: string, format: Format, baseUrl: string): string {
	if (format === "html") return normalizeHtml(cleanedHtml);
	if (format === "text") return htmlToPlainText(cleanedHtml, baseUrl);
	return htmlToMarkdown(cleanedHtml);
}

export function renderText(body: string): string {
	return normalizeText(body);
}

export function looksLikeHtml(contentType: string | undefined, body: string): boolean {
	if (contentType?.toLowerCase().includes("html")) return true;
	return /<!doctype\s+html|<html\b|<body\b|<main\b|<article\b/i.test(body.slice(0, 20_000));
}

export function htmlToPlainText(html: string, baseUrl: string): string {
	const dom = createDom(`<body>${stripRawNoise(html)}</body>`, baseUrl);
	return normalizeText(dom.window.document.body.textContent ?? "");
}

function htmlToMarkdown(cleanedHtml: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});

	turndown.remove(["script", "style", "noscript", "svg", "canvas", "template", "iframe", "object", "embed"]);
	turndown.addRule("details", {
		filter: "details",
		replacement(content) {
			return content.trim() ? `\n\n${content.trim()}\n\n` : "\n\n";
		},
	});
	turndown.addRule("summary", {
		filter: "summary",
		replacement(content) {
			const text = content.trim();
			return text ? `\n\n**${text}**\n\n` : "\n\n";
		},
	});

	return normalizeMarkdown(turndown.turndown(cleanedHtml));
}

export function normalizeHtml(html: string): string {
	return html.replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
