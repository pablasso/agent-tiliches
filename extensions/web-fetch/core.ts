import { extractHtml } from "./extract.ts";
import { runBrowserWebFetch } from "./browser.ts";
import { fetchText, formatBytes } from "./fetch.ts";
import { assessExtractionQuality } from "./quality.ts";
import { looksLikeHtml, renderText } from "./render.ts";
import { MAX_FETCH_BYTES, type NormalizedParams, type WebFetchDetails, type WebFetchParams, type WebFetchRunResult } from "./types.ts";

export interface RunWebFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
}

export async function runWebFetch(params: WebFetchParams, options: RunWebFetchOptions = {}): Promise<WebFetchRunResult> {
	const input = normalizeParams(params);
	const requestedUrl = normalizeHttpUrl(input.url);

	if (input.mode === "browser") {
		return runBrowserWebFetch(input, requestedUrl, options);
	}

	const warnings: string[] = [];

	const fetched = await fetchText(requestedUrl, options);
	if (fetched.status < 200 || fetched.status >= 300) {
		warnings.push(`HTTP status ${fetched.status} ${fetched.statusText}`.trim());
	}
	if (fetched.responseTruncated) {
		warnings.push(`Response body exceeded ${formatBytes(options.maxBytes ?? MAX_FETCH_BYTES)} and was truncated before extraction.`);
	}

	const isHtml = looksLikeHtml(fetched.contentType, fetched.body);
	let output: string;
	let title: string | undefined;
	let extraction: WebFetchDetails["extraction"] = "raw";
	let rawHtml: string | undefined;
	let foldables: WebFetchDetails["foldables"] = { detected: 0, included: 0, ignored: 0, controlledPanelsIncluded: 0, examples: [] };
	let hidden: WebFetchDetails["hidden"] = { detected: 0, included: 0, ignored: 0 };

	if (isHtml) {
		rawHtml = fetched.body;
		const extracted = extractHtml(fetched.body, input, fetched.finalUrl);
		output = extracted.output;
		title = extracted.title;
		extraction = extracted.extraction;
		foldables = extracted.foldables;
		hidden = extracted.hidden;
		warnings.push(...extracted.warnings);
	} else {
		extraction = "text";
		output = renderText(fetched.body);
		if (input.format === "html") {
			warnings.push("Requested HTML output, but response is not HTML; returned decoded text instead.");
		}
	}

	if (!output.trim()) {
		warnings.push("Static extraction produced no readable content.");
	}

	const quality = assessExtractionQuality({
		isHtml,
		rawHtml: fetched.body,
		output,
		foldablesIgnored: foldables.ignored,
		foldablesDetected: foldables.detected,
	});
	if (input.mode === "auto" && quality.browserRecommended) {
		warnings.push(`Browser rendering recommended: ${quality.reasons[0]}`);
	}

	const details: WebFetchDetails = {
		url: requestedUrl,
		finalUrl: fetched.finalUrl,
		status: fetched.status,
		contentType: fetched.contentType,
		title,
		mode: input.mode,
		format: input.format,
		scope: input.scope,
		extraction,
		bytesFetched: fetched.bytes.byteLength,
		outputBytes: Buffer.byteLength(output, "utf8"),
		outputLines: countLines(output),
		responseTruncated: fetched.responseTruncated,
		foldables,
		hidden,
		quality,
		warnings,
		browserRecommended: input.mode === "auto" ? quality.browserRecommended : false,
		browserReason: input.mode === "auto" ? quality.reasons[0] : undefined,
	};

	return { output, rawHtml, details };
}

export function normalizeParams(params: WebFetchParams): NormalizedParams {
	return {
		url: params.url,
		mode: params.mode ?? "auto",
		format: params.format ?? "markdown",
		scope: params.scope ?? "main",
		foldables: params.foldables ?? "auto",
		hidden: params.hidden ?? "exclude",
	};
}

export function normalizeHttpUrl(value: string): string {
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

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}
