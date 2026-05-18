export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type Mode = "auto" | "static";
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

export type Extraction = "html-readability" | "html-cleaned" | "text" | "raw";

export interface SignalSummary {
	detected: number;
	included: number;
	ignored: number;
	examples?: string[];
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
	foldables: Required<Pick<SignalSummary, "detected" | "included" | "ignored">> & { examples: string[] };
	hidden: Required<Pick<SignalSummary, "detected" | "included" | "ignored">>;
	warnings: string[];
	browserRecommended: boolean;
	browserReason?: string;
}

export interface WebFetchRunResult {
	output: string;
	rawHtml?: string;
	details: WebFetchDetails;
}
