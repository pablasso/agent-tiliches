import type {
	ClassifiedWindows,
	CodexCredits,
	CodexHeaderRecord,
	CodexRateLimit,
	CodexRateLimitResetCredits,
	CodexUsageSnapshot,
	CodexUsageWindow,
} from "./types.ts";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_USAGE_PAGE = "https://chatgpt.com/codex/settings/usage";

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const FIVE_HOUR_MIN_SECONDS = 4 * 60 * 60;
const FIVE_HOUR_MAX_SECONDS = 6 * 60 * 60;
const WEEK_MIN_SECONDS = 6 * 24 * 60 * 60;
const WEEK_MAX_SECONDS = 8 * 24 * 60 * 60;

interface FetchCodexUsageOptions {
	accountId?: string;
	endpoint?: string;
	fetchImpl?: typeof fetch;
	nowMs?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === 1 || (typeof value === "string" && /^(1|true)$/i.test(value.trim()))) return true;
	if (value === 0 || (typeof value === "string" && /^(0|false)$/i.test(value.trim()))) return false;
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = finiteNumber(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function normalizeEpochSeconds(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return value > 10_000_000_000 ? Math.round(value / 1_000) : Math.round(value);
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseUsageWindow(value: unknown, nowMs: number): CodexUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = firstNumber(value, ["used_percent", "usedPercent"]);
	if (usedPercent === undefined) return undefined;

	const explicitDuration = firstNumber(value, ["limit_window_seconds", "window_seconds", "windowSeconds"]);
	const minutes = firstNumber(value, ["window_minutes", "windowMinutes"]);
	const durationSeconds = explicitDuration ?? (minutes === undefined ? undefined : minutes * 60);
	const explicitReset = normalizeEpochSeconds(firstNumber(value, ["reset_at", "resets_at", "resetAt", "resetsAt"]));
	const resetAfter = firstNumber(value, ["reset_after_seconds", "resets_in_seconds", "resetAfterSeconds"]);
	const resetsAt = explicitReset ?? (resetAfter === undefined ? undefined : Math.round(nowMs / 1_000 + resetAfter));

	return {
		usedPercent: clampPercent(usedPercent),
		...(durationSeconds !== undefined && durationSeconds > 0 ? { durationSeconds } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

function parseApiRateLimit(value: unknown, id: string, name: string, nowMs: number): CodexRateLimit | undefined {
	if (!isRecord(value)) return undefined;
	const primary = parseUsageWindow(value.primary_window ?? value.primaryWindow ?? value.primary, nowMs);
	const secondary = parseUsageWindow(value.secondary_window ?? value.secondaryWindow ?? value.secondary, nowMs);
	const allowed = booleanValue(value.allowed);
	const limitReached = booleanValue(value.limit_reached ?? value.limitReached);
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) return undefined;
	return {
		id,
		name,
		...(allowed !== undefined ? { allowed } : {}),
		...(limitReached !== undefined ? { limitReached } : {}),
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

function parseApiCredits(value: unknown): CodexCredits | undefined {
	if (!isRecord(value)) return undefined;
	const hasCredits = booleanValue(value.has_credits ?? value.hasCredits);
	const unlimited = booleanValue(value.unlimited);
	const overageLimitReached = booleanValue(value.overage_limit_reached ?? value.overageLimitReached);
	const rawBalance = value.balance;
	const balance = rawBalance === null || rawBalance === undefined ? undefined : String(rawBalance).trim() || undefined;
	if (hasCredits === undefined && unlimited === undefined && overageLimitReached === undefined && balance === undefined) {
		return undefined;
	}
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(overageLimitReached !== undefined ? { overageLimitReached } : {}),
		...(balance !== undefined ? { balance } : {}),
	};
}

function parseRateLimitResetCredits(value: unknown): CodexRateLimitResetCredits | undefined {
	if (!isRecord(value)) return undefined;
	const availableCount = firstNumber(value, ["available_count", "availableCount"]);
	if (availableCount === undefined) return undefined;
	return { availableCount: Math.max(0, Math.floor(availableCount)) };
}

function normalizeLimitId(value: string): string {
	return value.trim().toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]+/g, "_");
}

export function parseCodexUsageResponse(value: unknown, nowMs = Date.now()): CodexUsageSnapshot {
	if (!isRecord(value)) throw new Error("OpenAI returned an invalid Codex usage response.");

	const defaultLimit = parseApiRateLimit(value.rate_limit ?? value.rateLimit, "codex", "Codex", nowMs);
	const additionalLimits: CodexRateLimit[] = [];
	const additional = value.additional_rate_limits ?? value.additionalRateLimits;
	if (Array.isArray(additional)) {
		for (const item of additional) {
			if (!isRecord(item)) continue;
			const feature = stringValue(item.metered_feature ?? item.meteredFeature);
			const name = stringValue(item.limit_name ?? item.limitName) ?? feature ?? "Additional Codex limit";
			const id = normalizeLimitId(feature ?? name) || "additional";
			const limit = parseApiRateLimit(item.rate_limit ?? item.rateLimit, id, name, nowMs);
			if (limit) additionalLimits.push(limit);
		}
	}

	const codeReview = parseApiRateLimit(value.code_review_rate_limit ?? value.codeReviewRateLimit, "code_review", "Code Review", nowMs);
	if (codeReview) additionalLimits.push(codeReview);

	const plan = stringValue(value.plan_type ?? value.planType);
	const credits = parseApiCredits(value.credits);
	const rateLimitResetCredits = parseRateLimitResetCredits(
		value.rate_limit_reset_credits ?? value.rateLimitResetCredits,
	);
	if (!defaultLimit && additionalLimits.length === 0 && !credits && !rateLimitResetCredits) {
		throw new Error("OpenAI's usage response did not include any Codex limits.");
	}

	return {
		source: "api",
		fetchedAt: nowMs,
		...(plan ? { plan } : {}),
		...(defaultLimit ? { defaultLimit } : {}),
		additionalLimits,
		...(credits ? { credits } : {}),
		...(rateLimitResetCredits ? { rateLimitResetCredits } : {}),
	};
}

function normalizedHeaders(headers: CodexHeaderRecord): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && value !== null) normalized[name.toLowerCase()] = String(value);
	}
	return normalized;
}

function header(headers: Record<string, string>, name: string): string | undefined {
	return stringValue(headers[name.toLowerCase()]);
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
	return finiteNumber(headers[name.toLowerCase()]);
}

function headerBoolean(headers: Record<string, string>, name: string): boolean | undefined {
	return booleanValue(headers[name.toLowerCase()]);
}

function parseHeaderWindow(
	headers: Record<string, string>,
	prefix: string,
	slot: "primary" | "secondary",
	nowMs: number,
): CodexUsageWindow | undefined {
	const usedPercent = headerNumber(headers, `${prefix}-${slot}-used-percent`);
	if (usedPercent === undefined) return undefined;
	const minutes = headerNumber(headers, `${prefix}-${slot}-window-minutes`);
	const explicitReset = normalizeEpochSeconds(headerNumber(headers, `${prefix}-${slot}-reset-at`));
	const resetAfter = headerNumber(headers, `${prefix}-${slot}-reset-after-seconds`);
	const resetsAt = explicitReset ?? (resetAfter === undefined ? undefined : Math.round(nowMs / 1_000 + resetAfter));
	return {
		usedPercent: clampPercent(usedPercent),
		...(minutes !== undefined && minutes > 0 ? { durationSeconds: minutes * 60 } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

function parseHeaderCredits(headers: Record<string, string>): CodexCredits | undefined {
	const hasCredits = headerBoolean(headers, "x-codex-credits-has-credits");
	const unlimited = headerBoolean(headers, "x-codex-credits-unlimited");
	const balance = header(headers, "x-codex-credits-balance");
	if (hasCredits === undefined && unlimited === undefined && balance === undefined) return undefined;
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(balance !== undefined ? { balance } : {}),
	};
}

function parseHeaderLimit(headers: Record<string, string>, id: string, nowMs: number): CodexRateLimit | undefined {
	const headerId = id.replace(/_/g, "-");
	const prefix = `x-${headerId}`;
	const primary = parseHeaderWindow(headers, prefix, "primary", nowMs);
	const secondary = parseHeaderWindow(headers, prefix, "secondary", nowMs);
	if (!primary && !secondary) return undefined;
	const name = header(headers, `${prefix}-limit-name`) ?? (id === "codex" ? "Codex" : id);
	return {
		id,
		name,
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

export function parseCodexRateLimitHeaders(
	rawHeaders: CodexHeaderRecord,
	nowMs = Date.now(),
): CodexUsageSnapshot | undefined {
	const headers = normalizedHeaders(rawHeaders);
	const ids = new Set<string>(["codex"]);
	const suffix = "-primary-used-percent";
	for (const name of Object.keys(headers)) {
		if (!name.startsWith("x-") || !name.endsWith(suffix)) continue;
		const id = normalizeLimitId(name.slice(2, -suffix.length));
		if (id) ids.add(id);
	}

	const limits = [...ids]
		.map((id) => parseHeaderLimit(headers, id, nowMs))
		.filter((limit): limit is CodexRateLimit => Boolean(limit));
	const defaultLimit = limits.find((limit) => limit.id === "codex");
	const additionalLimits = limits.filter((limit) => limit.id !== "codex");
	const credits = parseHeaderCredits(headers);
	const plan = header(headers, "x-codex-plan-type");
	if (!defaultLimit && additionalLimits.length === 0 && !credits && !plan) return undefined;

	return {
		source: "headers",
		fetchedAt: nowMs,
		...(plan ? { plan } : {}),
		...(defaultLimit ? { defaultLimit } : {}),
		additionalLimits,
		...(credits ? { credits } : {}),
	};
}

function mergeWindow(existing: CodexUsageWindow | undefined, update: CodexUsageWindow | undefined): CodexUsageWindow | undefined {
	if (!existing) return update;
	if (!update) return existing;
	return { ...existing, ...update };
}

function mergeLimit(existing: CodexRateLimit | undefined, update: CodexRateLimit): CodexRateLimit {
	if (!existing) return update;
	const primary = mergeWindow(existing.primary, update.primary);
	const secondary = mergeWindow(existing.secondary, update.secondary);
	return {
		...existing,
		...update,
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

export function mergeCodexUsageSnapshots(
	existing: CodexUsageSnapshot | undefined,
	update: CodexUsageSnapshot,
): CodexUsageSnapshot {
	// A fresh endpoint response is authoritative. In particular, it can tell us
	// that a plan no longer exposes a previously cached short window.
	if (!existing || update.source === "api") return update;

	const additionalById = new Map(existing.additionalLimits.map((limit) => [limit.id, limit]));
	for (const limit of update.additionalLimits) {
		additionalById.set(limit.id, mergeLimit(additionalById.get(limit.id), limit));
	}
	const defaultLimit = update.defaultLimit
		? mergeLimit(existing.defaultLimit, update.defaultLimit)
		: existing.defaultLimit;
	return {
		...existing,
		...update,
		plan: update.plan ?? existing.plan,
		...(defaultLimit ? { defaultLimit } : {}),
		additionalLimits: [...additionalById.values()],
		credits: update.credits ? { ...existing.credits, ...update.credits } : existing.credits,
	};
}

function isFiveHourWindow(window: CodexUsageWindow): boolean {
	return Boolean(
		window.durationSeconds &&
			window.durationSeconds >= FIVE_HOUR_MIN_SECONDS &&
			window.durationSeconds <= FIVE_HOUR_MAX_SECONDS,
	);
}

function isWeeklyWindow(window: CodexUsageWindow): boolean {
	return Boolean(
		window.durationSeconds &&
			window.durationSeconds >= WEEK_MIN_SECONDS &&
			window.durationSeconds <= WEEK_MAX_SECONDS,
	);
}

export function classifyCodexWindows(limit: CodexRateLimit | undefined): ClassifiedWindows {
	if (!limit) return { other: [] };
	const entries = [
		limit.primary ? { slot: "primary" as const, window: limit.primary } : undefined,
		limit.secondary ? { slot: "secondary" as const, window: limit.secondary } : undefined,
	].filter((entry): entry is { slot: "primary" | "secondary"; window: CodexUsageWindow } => Boolean(entry));

	const fiveHour = entries.find((entry) => isFiveHourWindow(entry.window))?.window;
	const weekly = entries.find((entry) => isWeeklyWindow(entry.window))?.window;
	const claimed = new Set<CodexUsageWindow>([fiveHour, weekly].filter((window): window is CodexUsageWindow => Boolean(window)));

	// Some provider responses include a zero-used placeholder slot without its
	// duration. It cannot be identified as a real limit (in particular, as the
	// historical 5-hour window), so do not present it to the user.
	const other = entries
		.filter((entry) => !claimed.has(entry.window) && entry.window.durationSeconds !== undefined)
		.map((entry) => ({
			label: formatWindowDuration(entry.window.durationSeconds!),
			window: entry.window,
		}));
	return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), other };
}

function leftPercent(window: CodexUsageWindow): number {
	return clampPercent(100 - window.usedPercent);
}

function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatStatusWindow(window: CodexUsageWindow, showWeeklyReset: boolean): string {
	const remaining = leftPercent(window);
	const reset =
		showWeeklyReset && window.resetsAt !== undefined
			? ` · ↻\u2009${formatShortLocalReset(window.resetsAt)}`
			: "";
	return `${formatPercent(remaining)}%${reset}`;
}

export function formatCodexUsageStatus(snapshot: CodexUsageSnapshot): string {
	const { fiveHour, weekly, other } = classifyCodexWindows(snapshot.defaultLimit);
	const windows = [
		...(fiveHour ? [{ label: "5h", window: fiveHour, showWeeklyReset: false }] : []),
		...(weekly ? [{ label: "", window: weekly, showWeeklyReset: true }] : []),
		...other.map((item) => ({ ...item, showWeeklyReset: false })),
	];
	let status: string;
	if (windows.length === 0) {
		status = "Codex limits unavailable";
	} else if (windows.length === 1) {
		const window = windows[0]!;
		status = `Codex ${formatStatusWindow(window.window, window.showWeeklyReset)}`;
	} else {
		status = `Codex ${windows
			.map(({ label, window, showWeeklyReset }) =>
				`${label ? `${label} ` : ""}${formatStatusWindow(window, showWeeklyReset)}`,
			)
			.join(" · ")}`;
	}

	const resetCount = snapshot.rateLimitResetCredits?.availableCount ?? 0;
	if (resetCount <= 0) return status;
	return `${status} · ${resetCount} reset${resetCount === 1 ? "" : "s"}`;
}

export function lowestCodexRemaining(snapshot: CodexUsageSnapshot): number | undefined {
	const { fiveHour, weekly, other } = classifyCodexWindows(snapshot.defaultLimit);
	const windows = [fiveHour, weekly, ...other.map((item) => item.window)].filter(
		(window): window is CodexUsageWindow => Boolean(window),
	);
	return windows.length > 0 ? Math.min(...windows.map(leftPercent)) : undefined;
}

function formatWindowLine(label: string, window: CodexUsageWindow, nowMs: number): string {
	const parts = [
		`${formatPercent(leftPercent(window))}% left (${formatPercent(window.usedPercent)}% used)`,
	];
	if (window.resetsAt !== undefined) {
		const remainingSeconds = Math.max(0, Math.round(window.resetsAt - nowMs / 1_000));
		parts.push(`resets in ${formatRelativeDuration(remainingSeconds)} at ${formatLocalReset(window.resetsAt)}`);
	}
	return `${label}: ${parts.join(" · ")}`;
}

export function formatCodexUsageDetails(snapshot: CodexUsageSnapshot, nowMs = Date.now()): string {
	const plan = snapshot.plan ? ` (${formatPlan(snapshot.plan)})` : "";
	const lines = [`Codex usage${plan}`];
	const classified = classifyCodexWindows(snapshot.defaultLimit);
	let displayedWindows = 0;
	if (classified.fiveHour) {
		lines.push(formatWindowLine("5h", classified.fiveHour, nowMs));
		displayedWindows++;
	}
	if (classified.weekly) {
		lines.push(formatWindowLine("Weekly", classified.weekly, nowMs));
		displayedWindows++;
	}
	for (const item of classified.other) {
		lines.push(formatWindowLine(item.label, item.window, nowMs));
		displayedWindows++;
	}
	if (displayedWindows === 0) lines.push("Limits: not reported by OpenAI");

	for (const limit of snapshot.additionalLimits) {
		lines.push("");
		lines.push(`${limit.name}:`);
		const windows = classifyCodexWindows(limit);
		if (windows.fiveHour) lines.push(`  ${formatWindowLine("5h", windows.fiveHour, nowMs)}`);
		if (windows.weekly) lines.push(`  ${formatWindowLine("Weekly", windows.weekly, nowMs)}`);
		for (const item of windows.other) lines.push(`  ${formatWindowLine(item.label, item.window, nowMs)}`);
	}

	if (snapshot.credits) lines.push(formatCredits(snapshot.credits));
	const ageSeconds = Math.max(0, Math.round((nowMs - snapshot.fetchedAt) / 1_000));
	lines.push(`Updated: ${ageSeconds < 5 ? "just now" : `${formatRelativeDuration(ageSeconds)} ago`} (${snapshot.source === "api" ? "OpenAI usage endpoint" : "provider response headers"})`);
	lines.push(CODEX_USAGE_PAGE);
	return lines.join("\n");
}

function formatCredits(credits: CodexCredits): string {
	if (credits.unlimited) return "Credits: unlimited";
	if (credits.overageLimitReached) return "Credits: overage limit reached";
	if (credits.hasCredits) return `Credits: ${credits.balance ?? "available"}`;
	return "Credits: none";
}

function formatPlan(plan: string): string {
	return plan
		.split(/[_-]+/)
		.filter(Boolean)
		.map(capitalize)
		.join(" ");
}

function capitalize(value: string): string {
	return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function formatWindowDuration(seconds: number): string {
	if (Math.abs(seconds - FIVE_HOURS_SECONDS) <= 60) return "5h";
	if (Math.abs(seconds - WEEK_SECONDS) <= 60) return "Weekly";
	const hours = seconds / 3_600;
	if (Number.isInteger(hours) && hours < 48) return `${hours}h`;
	const days = seconds / 86_400;
	if (Number.isInteger(days)) return `${days}d`;
	return formatRelativeDuration(seconds);
}

export function formatRelativeDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return "<1m";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${Math.max(1, minutes)}m`;
}

function formatShortLocalReset(epochSeconds: number): string {
	return new Date(epochSeconds * 1_000).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function formatLocalReset(epochSeconds: number): string {
	return new Date(epochSeconds * 1_000).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function extractChatGptAccountId(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length < 2 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth)) return undefined;
		return stringValue(auth.chatgpt_account_id);
	} catch {
		return undefined;
	}
}

async function responseError(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text) return response.statusText || "request failed";
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed) && isRecord(parsed.error)) {
			return stringValue(parsed.error.message) ?? stringValue(parsed.error.code) ?? `HTTP ${response.status}`;
		}
	} catch {
		// Use the bounded plain-text preview below.
	}
	return text.replace(/\s+/g, " ").slice(0, 300);
}

export async function fetchCodexUsage(
	accessToken: string,
	options: FetchCodexUsageOptions = {},
): Promise<CodexUsageSnapshot> {
	if (!accessToken.trim()) throw new Error("No OpenAI Codex login is available. Run /login first.");
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? CODEX_USAGE_ENDPOINT, {
		method: "GET",
		redirect: "error",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${accessToken}`,
			...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
			"user-agent": "agent-tiliches-codex-usage/0.1.0",
		},
		signal,
	});
	if (!response.ok) {
		throw new Error(`OpenAI Codex usage request failed (${response.status}): ${await responseError(response)}`);
	}
	const value = await response.json();
	return parseCodexUsageResponse(value, options.nowMs ?? Date.now());
}
