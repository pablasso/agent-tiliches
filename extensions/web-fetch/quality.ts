import { countMatches } from "./text.ts";
import type { WebFetchQuality } from "./types.ts";

export function assessExtractionQuality(input: {
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
	if (sparseOutput) reasons.push("large HTML response produced very little readable output");
	if (clientRenderedMarkers && scriptCount > 10 && outputChars < 10_000) {
		reasons.push("page appears to rely on client/deferred rendering and extraction may be incomplete");
	}
	if (foldablesBlocked) reasons.push("many collapsible/foldable elements were detected but not expanded");
	if (navHeavyOutput && outputChars < 5_000) reasons.push("output looks dominated by page chrome/navigation rather than main content");

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
