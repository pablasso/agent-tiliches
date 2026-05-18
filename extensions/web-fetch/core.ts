import { extractHtml } from "./extract.ts";
import { fetchText, formatBytes } from "./fetch.ts";
import { looksLikeHtml, renderText } from "./render.ts";
import { countMatches } from "./text.ts";
import {
	MAX_FETCH_BYTES,
	type NormalizedParams,
	type WebFetchDetails,
	type WebFetchParams,
	type WebFetchQuality,
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

function assessExtractionQuality(input: {
	isHtml: boolean;
	rawHtml: string;
	output: string;
	foldablesDetected: number;
	foldablesIgnored: number;
}): WebFetchQuality {
	const rawBytes = Buffer.byteLength(input.rawHtml, "utf8");
	const outputChars = input.output.replace(/\s+/g, " ").trim().length;
	const outputToRawRatio = rawBytes > 0 ? outputChars / rawBytes : 1;
	const scriptCount = input.isHtml ? countMatches(input.rawHtml, /<script\b/gi) : 0;
	const clientRenderedMarkers = input.isHtml
		? /AF_initData|jscontroller=|<c-wiz\b|__NEXT_DATA__|data-reactroot|ng-version|id=["']root["']|id=["']app["']/i.test(input.rawHtml)
		: false;
	const sparseOutput = input.isHtml && rawBytes > 200_000 && outputChars < 5_000;
	const navHeavyOutput = input.isHtml && looksNavHeavy(input.output);
	const foldablesBlocked = input.isHtml && input.foldablesDetected >= 10 && input.foldablesIgnored >= 10;

	const reasons: string[] = [];
	if (sparseOutput) reasons.push("large HTML response produced very little readable static output");
	if (clientRenderedMarkers && scriptCount > 10 && outputChars < 10_000) {
		reasons.push("page appears to rely on client/deferred rendering and static extraction may be incomplete");
	}
	if (foldablesBlocked) reasons.push("many collapsible/foldable elements were detected but not expanded by static extraction");
	if (navHeavyOutput && outputChars < 5_000) reasons.push("static output looks dominated by page chrome/navigation rather than main content");

	return {
		rawBytes,
		outputChars,
		outputToRawRatio: Number(outputToRawRatio.toFixed(6)),
		scriptCount,
		clientRenderedMarkers,
		sparseOutput,
		navHeavyOutput,
		foldablesBlocked,
		browserRecommended: reasons.length > 0,
		reasons,
	};
}

function looksNavHeavy(output: string): boolean {
	const lines = output
		.split("\n")
		.map((line) => line.replace(/^#+\s*/, "").trim().toLowerCase())
		.filter(Boolean);
	if (lines.length < 3) return false;

	const chromeTerms = /^(home|jobs|students|how we work|how we hire|your career|help|sign in|main menu|privacy|terms|manage cookies|related information|more about us|contact us|press|investor relations|blog|equal opportunity)$/i;
	const chromeLineCount = lines.filter((line) => chromeTerms.test(line) || (/^(privacy|terms|help|sign in|main menu)\b/i.test(line) && line.length < 80)).length;
	return chromeLineCount / lines.length >= 0.5;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}
