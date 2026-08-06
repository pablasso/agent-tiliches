export type CodexUsageSource = "api" | "headers";

export interface CodexUsageWindow {
	usedPercent: number;
	durationSeconds?: number;
	resetsAt?: number;
}

export interface CodexRateLimit {
	id: string;
	name: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
}

export interface CodexCredits {
	hasCredits?: boolean;
	unlimited?: boolean;
	overageLimitReached?: boolean;
	balance?: string;
}

export interface CodexUsageSnapshot {
	source: CodexUsageSource;
	fetchedAt: number;
	plan?: string;
	defaultLimit?: CodexRateLimit;
	additionalLimits: CodexRateLimit[];
	credits?: CodexCredits;
}

export interface ClassifiedWindows {
	fiveHour?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
	other: Array<{ label: string; window: CodexUsageWindow }>;
}

export type CodexHeaderRecord = Record<string, string | number | boolean | null | undefined>;
