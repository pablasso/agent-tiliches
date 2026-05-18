import { JSDOM, VirtualConsole } from "jsdom";
import type { Scope } from "./types.ts";
import { normalizeInlineText } from "./text.ts";

export function createDom(markup: string, url: string): JSDOM {
	return new JSDOM(markup, { url, virtualConsole: new VirtualConsole() });
}

export function stripRawNoise(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "\n")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "\n")
		.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "\n");
}

export function parseHtmlDocument(html: string, url: string): Document {
	return createDom(stripRawNoise(html), url).window.document;
}

export function createScopedDocument(scopeElement: Element, baseUrl: string): Document {
	const title = getDocumentTitle(scopeElement.ownerDocument) ?? "";
	const markup = `<!doctype html><html><head><base href="${escapeHtmlAttribute(baseUrl)}"><title>${escapeHtmlText(title)}</title></head><body>${scopeElement.outerHTML}</body></html>`;
	return createDom(markup, baseUrl).window.document;
}

export function selectScopeElement(document: Document, scope: Scope): Element {
	if (scope === "page") return document.body ?? document.documentElement;
	return (
		document.querySelector("main") ??
		document.querySelector('[role="main"]') ??
		document.querySelector("article") ??
		document.body ??
		document.documentElement
	);
}

export function stripNoise(root: ParentNode): void {
	removeElements(
		root,
		[
			"script",
			"style",
			"noscript",
			"svg",
			"canvas",
			"template",
			"iframe",
			"object",
			"embed",
			"link[rel='preload']",
			"link[rel='modulepreload']",
		].join(", "),
	);
	removeComments(root);
}

export function removeElements(root: ParentNode, selector: string): void {
	for (const element of Array.from(root.querySelectorAll(selector))) {
		element.remove();
	}
	if (isElement(root) && root.matches(selector)) {
		root.remove();
	}
}

export function removeHiddenElements(root: ParentNode): void {
	for (const element of allElements(root)) {
		if (isHiddenElement(element)) element.remove();
	}
}

function removeComments(root: ParentNode): void {
	const document = getOwnerDocument(root);
	if (!document) return;
	const walker = document.createTreeWalker(root, 128); // NodeFilter.SHOW_COMMENT
	const comments: ChildNode[] = [];
	let node = walker.nextNode();
	while (node) {
		comments.push(node as ChildNode);
		node = walker.nextNode();
	}
	for (const comment of comments) comment.remove();
}

function getOwnerDocument(root: ParentNode): Document | undefined {
	if ((root as Document).nodeType === 9) return root as Document;
	return (root as Element).ownerDocument;
}

export function isHiddenElement(element: Element): boolean {
	if (element.hasAttribute("hidden")) return true;
	if ((element.getAttribute("aria-hidden") ?? "").toLowerCase() === "true") return true;
	const style = element.getAttribute("style") ?? "";
	return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

export function allElements(root: ParentNode): Element[] {
	const elements = Array.from(root.querySelectorAll("*"));
	if (isElement(root)) return [root, ...elements];
	return elements;
}

function isElement(value: unknown): value is Element {
	return Boolean(value && typeof value === "object" && (value as Element).nodeType === 1 && "querySelectorAll" in value);
}

export function rewriteRelativeUrls(root: ParentNode, baseUrl: string): void {
	for (const element of Array.from(root.querySelectorAll("a[href]"))) {
		const href = element.getAttribute("href");
		if (!href) continue;
		if (/^javascript:/i.test(href)) {
			element.removeAttribute("href");
			continue;
		}
		element.setAttribute("href", resolveMaybeUrl(href, baseUrl));
	}

	for (const element of Array.from(root.querySelectorAll("img[src], source[src]"))) {
		const src = element.getAttribute("src");
		if (src) element.setAttribute("src", resolveMaybeUrl(src, baseUrl));
	}
}

export function getDocumentTitle(document: Document): string | undefined {
	const title = normalizeInlineText(document.title ?? "");
	if (title) return title;
	const metaTitle =
		document.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
		document.querySelector('meta[name="twitter:title"]')?.getAttribute("content");
	const normalized = normalizeInlineText(metaTitle ?? "");
	return normalized || undefined;
}

export function getBaseUrl(document: Document, fallback: string): string {
	try {
		return document.baseURI ? new URL(document.baseURI, fallback).toString() : fallback;
	} catch {
		return fallback;
	}
}

function resolveMaybeUrl(value: string, baseUrl: string): string {
	if (/^(?:mailto|tel|data):/i.test(value)) return value;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return value;
	}
}

function escapeHtmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
	return escapeHtmlText(value).replace(/"/g, "&quot;");
}
