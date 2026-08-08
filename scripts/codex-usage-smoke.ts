import { strict as assert } from "node:assert";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexUsageExtension from "../extensions/codex-usage/index.ts";
import {
	CODEX_USAGE_ENDPOINT,
	classifyCodexWindows,
	extractChatGptAccountId,
	fetchCodexUsage,
	formatCodexUsageDetails,
	formatCodexUsageStatus,
	mergeCodexUsageSnapshots,
	parseCodexRateLimitHeaders,
	parseCodexUsageResponse,
} from "../extensions/codex-usage/core.ts";

const nowMs = 1_700_000_000_000;
const apiFixture = {
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 23,
			limit_window_seconds: 5 * 60 * 60,
			reset_after_seconds: 7_200,
			reset_at: nowMs / 1_000 + 7_200,
		},
		secondary_window: {
			used_percent: 40.5,
			limit_window_seconds: 7 * 24 * 60 * 60,
			reset_after_seconds: 4 * 24 * 60 * 60,
			reset_at: nowMs / 1_000 + 4 * 24 * 60 * 60,
		},
	},
	additional_rate_limits: [
		{
			metered_feature: "codex_bengalfox",
			limit_name: "GPT Codex Spark",
			rate_limit: {
				primary_window: {
					used_percent: 12,
					limit_window_seconds: 5 * 60 * 60,
					reset_after_seconds: 3_600,
				},
			},
		},
	],
	credits: {
		has_credits: true,
		unlimited: false,
		overage_limit_reached: false,
		balance: "42.5",
	},
	rate_limit_reset_credits: {
		available_count: 1,
	},
};

const parsed = parseCodexUsageResponse(apiFixture, nowMs);
assert.equal(parsed.source, "api");
assert.equal(parsed.plan, "plus");
assert.equal(parsed.defaultLimit?.primary?.usedPercent, 23);
assert.equal(parsed.defaultLimit?.primary?.durationSeconds, 18_000);
assert.equal(parsed.defaultLimit?.primary?.resetsAt, nowMs / 1_000 + 7_200);
assert.equal(parsed.defaultLimit?.secondary?.usedPercent, 40.5);
assert.equal(parsed.additionalLimits[0]?.id, "codex_bengalfox");
assert.equal(parsed.additionalLimits[0]?.name, "GPT Codex Spark");
assert.equal(parsed.credits?.balance, "42.5");
assert.equal(parsed.rateLimitResetCredits?.availableCount, 1);
assert.equal(classifyCodexWindows(parsed.defaultLimit).fiveHour?.usedPercent, 23);
assert.equal(classifyCodexWindows(parsed.defaultLimit).weekly?.usedPercent, 40.5);
assert.equal(formatCodexUsageStatus(parsed), "Codex: 5h 77% · week 59.5% · 1 reset available");
assert.equal(
	formatCodexUsageStatus({
		...parsed,
		rateLimitResetCredits: { availableCount: 2 },
	}),
	"Codex: 5h 77% · week 59.5% · 2 resets available",
);
assert.equal(
	formatCodexUsageStatus({
		...parsed,
		rateLimitResetCredits: { availableCount: 0 },
	}),
	"Codex: 5h 77% · week 59.5%",
);

const lowWeeklyResetAt = parsed.defaultLimit!.secondary!.resetsAt!;
const lowWeeklyReset = new Date(lowWeeklyResetAt * 1_000).toLocaleString(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
const lowWeekly = {
	...parsed,
	defaultLimit: {
		...parsed.defaultLimit!,
		secondary: { ...parsed.defaultLimit!.secondary!, usedPercent: 66 },
	},
};
assert.equal(
	formatCodexUsageStatus(lowWeekly),
	`Codex: 5h 77% · week 34% until ${lowWeeklyReset} · 1 reset available`,
);
assert.equal(
	formatCodexUsageStatus({
		...lowWeekly,
		defaultLimit: {
			...lowWeekly.defaultLimit,
			secondary: { ...lowWeekly.defaultLimit.secondary, usedPercent: 65 },
		},
	}),
	"Codex: 5h 77% · week 35% · 1 reset available",
);

const details = formatCodexUsageDetails(parsed, nowMs);
assert.match(details, /Codex usage \(Plus\)/);
assert.match(details, /5h: 77% left \(23% used\)/);
assert.match(details, /Weekly: 59\.5% left \(40\.5% used\)/);
assert.match(details, /GPT Codex Spark:/);
assert.match(details, /Credits: 42\.5/);
assert.match(details, /OpenAI usage endpoint/);

// OpenAI can expose a weekly-only plan with that 7-day window in the primary
// slot. Duration-based classification must not call it a 5-hour limit.
const weeklyOnly = parseCodexUsageResponse(
	{
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 14,
				limit_window_seconds: 7 * 24 * 60 * 60,
				reset_at: nowMs / 1_000 + 200_000,
			},
			secondary_window: null,
		},
	},
	nowMs,
);
const weeklyOnlyWindows = classifyCodexWindows(weeklyOnly.defaultLimit);
assert.equal(weeklyOnlyWindows.fiveHour, undefined);
assert.equal(weeklyOnlyWindows.weekly?.usedPercent, 14);
assert.equal(formatCodexUsageStatus(weeklyOnly), "Codex: 86%");
assert.doesNotMatch(formatCodexUsageDetails(weeklyOnly, nowMs), /5h:/);
assert.match(formatCodexUsageDetails(weeklyOnly, nowMs), /Weekly: 86% left/);

// Provider headers can include an empty secondary placeholder without a
// duration. It is not evidence of a 5-hour limit and should not be displayed.
const weeklyWithSecondaryPlaceholder = parseCodexRateLimitHeaders(
	{
		"x-codex-primary-used-percent": "35",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-secondary-used-percent": "0",
	},
	nowMs,
);
assert(weeklyWithSecondaryPlaceholder);
assert.equal(weeklyWithSecondaryPlaceholder.defaultLimit?.secondary?.usedPercent, 0);
assert.equal(classifyCodexWindows(weeklyWithSecondaryPlaceholder.defaultLimit).other.length, 0);
assert.equal(formatCodexUsageStatus(weeklyWithSecondaryPlaceholder), "Codex: 65%");
assert.doesNotMatch(formatCodexUsageDetails(weeklyWithSecondaryPlaceholder, nowMs), /Secondary limit|5h:/);

const fromHeaders = parseCodexRateLimitHeaders(
	{
		"X-Codex-Plan-Type": "pro",
		"x-codex-primary-used-percent": "25.5",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-after-seconds": "3600",
		"x-codex-secondary-used-percent": "60",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-at": String(nowMs / 1_000 + 86_400),
		"x-codex-credits-has-credits": "true",
		"x-codex-credits-unlimited": "false",
		"x-codex-credits-balance": "9",
		"x-codex-bengalfox-primary-used-percent": "80",
		"x-codex-bengalfox-primary-window-minutes": "300",
		"x-codex-bengalfox-limit-name": "GPT Codex Spark",
	},
	nowMs,
);
assert(fromHeaders);
assert.equal(fromHeaders.plan, "pro");
assert.equal(fromHeaders.defaultLimit?.primary?.usedPercent, 25.5);
assert.equal(fromHeaders.defaultLimit?.primary?.resetsAt, nowMs / 1_000 + 3_600);
assert.equal(fromHeaders.defaultLimit?.secondary?.resetsAt, nowMs / 1_000 + 86_400);
assert.equal(fromHeaders.additionalLimits[0]?.id, "codex_bengalfox");
assert.equal(fromHeaders.credits?.hasCredits, true);

const merged = mergeCodexUsageSnapshots(parsed, fromHeaders);
assert.equal(merged.source, "headers");
assert.equal(merged.plan, "pro");
assert.equal(merged.defaultLimit?.primary?.usedPercent, 25.5);
assert.equal(merged.defaultLimit?.secondary?.usedPercent, 60);
assert.equal(merged.additionalLimits[0]?.name, "GPT Codex Spark");
assert.equal(merged.credits?.balance, "9");
assert.equal(merged.rateLimitResetCredits?.availableCount, 1);

// Endpoint responses are authoritative and can remove a no-longer-reported
// short window instead of preserving stale header data.
const authoritative = mergeCodexUsageSnapshots(fromHeaders, weeklyOnly);
assert.equal(authoritative.source, "api");
assert.equal(authoritative.defaultLimit?.secondary, undefined);
assert.equal(classifyCodexWindows(authoritative.defaultLimit).fiveHour, undefined);
assert.equal(authoritative.rateLimitResetCredits, undefined);

assert.equal(parseCodexRateLimitHeaders({ "content-type": "text/event-stream" }, nowMs), undefined);
assert.throws(() => parseCodexUsageResponse({ plan_type: "plus" }, nowMs), /did not include any Codex limits/);

const accountId = "acct-test-123";
const jwtPayload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
).toString("base64url");
const accessToken = `e30.${jwtPayload}.signature`;
assert.equal(extractChatGptAccountId(accessToken), accountId);
assert.equal(extractChatGptAccountId("not-a-jwt"), undefined);

let requestedUrl = "";
let requestedHeaders: Headers | undefined;
const fetched = await fetchCodexUsage(accessToken, {
	accountId,
	nowMs,
	fetchImpl: async (input, init) => {
		requestedUrl = String(input);
		requestedHeaders = new Headers(init?.headers);
		return new Response(JSON.stringify(apiFixture), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});
assert.equal(requestedUrl, CODEX_USAGE_ENDPOINT);
assert.equal(requestedHeaders?.get("authorization"), `Bearer ${accessToken}`);
assert.equal(requestedHeaders?.get("chatgpt-account-id"), accountId);
assert.equal(fetched.defaultLimit?.primary?.usedPercent, 23);

await assert.rejects(
	fetchCodexUsage(accessToken, {
		fetchImpl: async () =>
			new Response(JSON.stringify({ error: { message: "login expired" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
	}),
	/login expired/,
);

const commands: string[] = [];
const events: string[] = [];
codexUsageExtension({
	registerCommand(name: string) {
		commands.push(name);
	},
	on(name: string) {
		events.push(name);
	},
} as unknown as ExtensionAPI);
assert.deepEqual(commands, ["codex-usage"]);
assert.deepEqual(events, [
	"session_start",
	"model_select",
	"agent_start",
	"after_provider_response",
	"turn_end",
	"agent_settled",
	"session_shutdown",
]);

console.log("codex-usage smoke ok");
