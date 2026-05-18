import { Readability } from "@mozilla/readability";
import {
	createDom,
	createScopedDocument,
	getBaseUrl,
	getDocumentTitle,
	parseHtmlDocument,
	removeElements,
	removeHiddenElements,
	rewriteRelativeUrls,
	selectScopeElement,
	stripNoise,
	stripRawNoise,
} from "./dom.ts";
import {
	detectFoldables,
	detectHidden,
	expandControlledPanels,
	foldableWarning,
	hiddenWarning,
	summarizeFoldables,
	summarizeHidden,
	type DetectionOptions,
	type FoldableSummary,
	type HiddenSummary,
} from "./detect.ts";
import { htmlToPlainText, normalizeHtml, renderOutput } from "./render.ts";
import { normalizeInlineText } from "./text.ts";
import type { Extraction, NormalizedParams, Scope } from "./types.ts";

export interface HtmlExtractionResult {
	output: string;
	title?: string;
	cleanedHtml: string;
	extraction: Extract<Extraction, "html-readability" | "html-cleaned">;
	foldables: FoldableSummary;
	hidden: HiddenSummary;
	warnings: string[];
}

/**
 * Static HTML extraction with a real DOM parser, Mozilla Readability for
 * scoped main-content extraction, and Turndown-backed Markdown rendering.
 *
 * This does not run JavaScript. Dynamic accordions and client-rendered content
 * are detected/reported, not expanded.
 */
export function extractHtml(html: string, input: NormalizedParams, finalUrl: string): HtmlExtractionResult {
	const warnings: string[] = [];
	const document = parseHtmlDocument(html, finalUrl);
	const title = getDocumentTitle(document);
	const baseUrl = getBaseUrl(document, finalUrl);

	stripNoise(document);

	const sourceScope = selectScopeElement(document, input.scope);
	const detectionOptions: DetectionOptions = { ignorePageChrome: input.scope === "main" };
	const foldableDetection = detectFoldables(sourceScope, detectionOptions);
	const hiddenDetection = detectHidden(sourceScope, detectionOptions);
	const controlledPanelsIncluded = input.foldables === "include" ? expandControlledPanels(sourceScope, detectionOptions) : 0;
	const foldables = summarizeFoldables(foldableDetection, input.foldables, controlledPanelsIncluded);
	const hidden = summarizeHidden(hiddenDetection, input.hidden, controlledPanelsIncluded);

	if (foldableDetection.detected > foldables.included) {
		warnings.push(foldableWarning(foldableDetection, foldables, input.foldables));
	}
	if (hiddenDetection.detected > 0) {
		warnings.push(hiddenWarning(hiddenDetection, hidden, input.hidden));
	}

	applyExtractionOptions(sourceScope, input);

	let extraction: HtmlExtractionResult["extraction"] = "html-cleaned";
	let cleanedHtml: string | undefined;
	let readabilityTitle: string | undefined;

	if (input.scope === "main") {
		const readable = extractReadableArticle(sourceScope, baseUrl);
		if (readable) {
			const candidate = cleanHtmlFragment(readable.content, baseUrl, input);
			readabilityTitle = readable.title;
			if (readableTextLength(candidate) >= 80) {
				cleanedHtml = candidate;
				extraction = "html-readability";
			} else {
				warnings.push("Readability found candidate main content, but it was very small; falling back to cleaned selected DOM.");
			}
		} else {
			warnings.push("Readability could not identify main article content; falling back to cleaned selected DOM.");
		}
	}

	if (!cleanedHtml) {
		cleanedHtml = cleanScopeHtml(sourceScope, baseUrl, input.scope);
		extraction = "html-cleaned";
	}

	return {
		output: renderOutput(cleanedHtml, input.format, baseUrl),
		title: title ?? readabilityTitle,
		cleanedHtml,
		extraction,
		foldables,
		hidden,
		warnings,
	};
}

function applyExtractionOptions(scopeElement: Element, input: NormalizedParams): void {
	if (input.foldables === "ignore") {
		removeElements(scopeElement, "details");
	}
	if (input.hidden === "exclude") {
		removeHiddenElements(scopeElement);
	}
}

function extractReadableArticle(scopeElement: Element, baseUrl: string): { title?: string; content: string } | undefined {
	try {
		const scopedDocument = createScopedDocument(scopeElement, baseUrl);
		const reader = new Readability(scopedDocument, {
			keepClasses: false,
		} as ConstructorParameters<typeof Readability>[1]);
		const article = reader.parse();
		const content = article?.content?.trim();
		if (!content) return undefined;
		return { title: article?.title?.trim() || undefined, content };
	} catch {
		return undefined;
	}
}

function cleanScopeHtml(scopeElement: Element, baseUrl: string, scope: Scope): string {
	const clone = scopeElement.cloneNode(true) as Element;
	stripNoise(clone);
	if (scope === "main") {
		removeElements(clone, "header, nav, footer, aside");
	}
	rewriteRelativeUrls(clone, baseUrl);
	return normalizeHtml(clone.innerHTML || clone.textContent || "");
}

function cleanHtmlFragment(html: string, baseUrl: string, input: NormalizedParams): string {
	const dom = createDom(`<body>${stripRawNoise(html)}</body>`, baseUrl);
	const body = dom.window.document.body;
	stripNoise(body);
	applyExtractionOptions(body, input);
	rewriteRelativeUrls(body, baseUrl);
	return normalizeHtml(body.innerHTML || body.textContent || "");
}

function readableTextLength(html: string): number {
	return normalizeInlineText(htmlToPlainText(html, "https://example.invalid/")).length;
}
