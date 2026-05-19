export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type Mode = "auto" | "static" | "browser";
export type Format = "markdown" | "text" | "html";
export type Scope = "main" | "page";
export type Foldables = "auto" | "ignore" | "include";
export type Hidden = "exclude" | "main" | "all";

export interface WebFetchParams {
	url: string;
	mode?: Mode;
	format?: Format;
	scope?: Scope;
	foldables?: Foldables;
	hidden?: Hidden;
}

export interface NormalizedParams {
	url: string;
	mode: Mode;
	format: Format;
	scope: Scope;
	foldables: Foldables;
	hidden: Hidden;
}

export type Extraction = "html-readability" | "html-cleaned" | "browser-readability" | "browser-cleaned" | "text" | "raw";

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

export interface WebFetchBrowserDetails {
	engine: "chromium" | "chrome";
	renderedHtmlBytes: number;
	detailsOpened: number;
	controlsClicked: number;
	controlsAttempted: number;
	skipped: number;
	errors: number;
	examples: string[];
}

export interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	mode: Mode;
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
		controlledPanelsIncluded: number;
	};
	hidden: Required<Pick<SignalSummary, "detected" | "included" | "ignored">>;
	quality: WebFetchQuality;
	warnings: string[];
	browserRecommended: boolean;
	browserReason?: string;
	browser?: WebFetchBrowserDetails;
}

export interface WebFetchRunResult {
	output: string;
	rawHtml?: string;
	details: WebFetchDetails;
}
