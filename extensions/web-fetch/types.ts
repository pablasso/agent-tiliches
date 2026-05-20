export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type Format = "markdown" | "text" | "html";
export type Scope = "main" | "page";

export interface WebFetchParams {
	url: string;
	format?: Format;
	scope?: Scope;
}

export interface NormalizedParams {
	url: string;
	format: Format;
	scope: Scope;
}

export type Extraction = "html-readability" | "html-cleaned" | "text" | "raw";

export interface SignalSummary {
	detected: number;
	included: number;
	ignored: number;
	examples?: string[];
}

export interface WebFetchQuality {
	rawBytes: number;
	outputChars: number;
	outputToRawRatio: number;
	scriptCount: number;
	clientRenderedMarkers: boolean;
	sparseOutput: boolean;
	navHeavyOutput: boolean;
	foldablesBlocked: boolean;
	browserRecommended: boolean;
	reasons: string[];
}

export interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	format: Format;
	scope: Scope;
	extraction: Extraction;
	bytesFetched: number;
	outputBytes: number;
	outputLines: number;
	rawHtmlPath?: string;
	fullOutputPath?: string;
	truncated?: boolean;
	responseTruncated?: boolean;
	foldables: Required<Pick<SignalSummary, "detected" | "included" | "ignored">> & {
		examples: string[];
	};
	hidden: Required<Pick<SignalSummary, "detected" | "included" | "ignored">>;
	quality: WebFetchQuality;
	warnings: string[];
	browserRecommended: boolean;
	browserReason?: string;
}

export interface WebFetchRunResult {
	output: string;
	rawHtml?: string;
	details: WebFetchDetails;
}
