import { extractHtml } from "./extract.ts";
import { fetchText, formatBytes } from "./fetch.ts";
import { looksLikeHtml, renderText } from "./render.ts";
import { countMatches } from "./text.ts";
import {
	MAX_FETCH_BYTES,
	type NormalizedParams,
	type WebFetchDetails,
	type WebFetchParams,
	type WebFetchRunResult,
} from "./types.ts";

export interface RunWebFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
}

export async function runWebFetch(params: WebFetchParams, options: RunWebFetchOptions = {}): Promise<WebFetchRunResult> {
	const input = normalizeParams(params);
	const requestedUrl = normalizeHttpUrl(input.url);
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
	let foldables: WebFetchDetails["foldables"] = { detected: 0, included: 0, ignored: 0, examples: [] };
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

	const browserAssessment = assessBrowserNeed({
		isHtml,
		rawHtml: fetched.body,
		output,
		foldablesIgnored: foldables.ignored,
		foldablesDetected: foldables.detected,
	});
	if (input.mode === "auto" && browserAssessment.recommended) {
		warnings.push(`Browser rendering recommended: ${browserAssessment.reason}`);
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
		warnings,
		browserRecommended: input.mode === "auto" ? browserAssessment.recommended : false,
		browserReason: input.mode === "auto" ? browserAssessment.reason : undefined,
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

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}
