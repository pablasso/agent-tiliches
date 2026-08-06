import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	extractChatGptAccountId,
	fetchCodexUsage,
	formatCodexUsageDetails,
	formatCodexUsageStatus,
	lowestCodexRemaining,
	mergeCodexUsageSnapshots,
	OPENAI_CODEX_PROVIDER,
	parseCodexRateLimitHeaders,
} from "./core.ts";
import type { CodexUsageSnapshot } from "./types.ts";

const STATUS_KEY = "codex-usage";
const ACTIVE_REFRESH_INTERVAL_MS = 60_000;

type CommandMode = "refresh" | "cached";

export default function codexUsageExtension(pi: ExtensionAPI) {
	let alive = true;
	let codexSelected = false;
	let snapshot: CodexUsageSnapshot | undefined;
	let inFlight: Promise<CodexUsageSnapshot> | undefined;
	let endpointRequestStartedAt = 0;
	let endpointFetchedAt = 0;
	let lastHeaderAt = 0;
	let agentStartedAt = 0;
	const sessionAbort = new AbortController();

	function safeSetStatus(ctx: ExtensionContext, text?: string): void {
		if (!alive || !ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Session replacement invalidates old contexts. A late background fetch
			// should not reach into the replacement session.
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!codexSelected) {
			safeSetStatus(ctx, undefined);
			return;
		}
		if (!snapshot) {
			safeSetStatus(ctx, ctx.ui.theme.fg("dim", "Codex usage…"));
			return;
		}
		const remaining = lowestCodexRemaining(snapshot);
		const color = remaining !== undefined && remaining <= 10 ? "error" : remaining !== undefined && remaining <= 25 ? "warning" : "dim";
		safeSetStatus(ctx, ctx.ui.theme.fg(color, formatCodexUsageStatus(snapshot)));
	}

	async function refreshUsage(ctx: ExtensionContext, minimumRequestStart = 0): Promise<CodexUsageSnapshot> {
		if (inFlight) {
			const existingRequestStartedAt = endpointRequestStartedAt;
			const result = await inFlight;
			if (existingRequestStartedAt >= minimumRequestStart) return result;
			return refreshUsage(ctx, minimumRequestStart);
		}
		endpointRequestStartedAt = Date.now();
		const request = (async () => {
			const accessToken = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
			if (!accessToken) throw new Error("No OpenAI Codex login is available. Run /login and choose OpenAI Codex first.");
			const next = await fetchCodexUsage(accessToken, {
				accountId: extractChatGptAccountId(accessToken),
				signal: sessionAbort.signal,
			});
			if (alive) {
				snapshot = mergeCodexUsageSnapshots(snapshot, next);
				endpointFetchedAt = next.fetchedAt;
				updateStatus(ctx);
			}
			return next;
		})();
		inFlight = request;
		try {
			return await request;
		} finally {
			if (inFlight === request) inFlight = undefined;
		}
	}

	function refreshInBackground(ctx: ExtensionContext, minimumRequestStart = 0): void {
		void refreshUsage(ctx, minimumRequestStart).catch((error) => {
			if (!alive || sessionAbort.signal.aborted) return;
			if (!snapshot && codexSelected) {
				safeSetStatus(ctx, ctx.ui.theme.fg("warning", "Codex usage unavailable"));
			}
			if (process.env.PI_CODEX_USAGE_DEBUG) {
				console.error(`[codex-usage] ${errorMessage(error)}`);
			}
		});
	}

	function refreshIfStaleInBackground(ctx: ExtensionContext): void {
		if (!inFlight && Date.now() - endpointFetchedAt < ACTIVE_REFRESH_INTERVAL_MS) return;
		refreshInBackground(ctx);
	}

	pi.registerCommand("codex-usage", {
		description: "Show OpenAI Codex login limits (5h, weekly, resets, and credits)",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "refresh", label: "refresh", description: "Fetch current limits from OpenAI" },
				{ value: "cached", label: "cached", description: "Show the latest limits already observed by this session" },
			];
			const matches = options.filter((option) => option.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			let mode: CommandMode;
			try {
				mode = parseCommandMode(args);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "warning");
				return;
			}

			try {
				const current = mode === "cached" && snapshot ? snapshot : await refreshUsage(ctx);
				if (ctx.hasUI) ctx.ui.notify(formatCodexUsageDetails(current), "info");
			} catch (error) {
				const stale = snapshot ? `\n\nLast observed values:\n${formatCodexUsageDetails(snapshot)}` : "";
				if (ctx.hasUI) ctx.ui.notify(`Codex usage unavailable: ${errorMessage(error)}${stale}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		codexSelected = ctx.model?.provider === OPENAI_CODEX_PROVIDER;
		updateStatus(ctx);
		if (codexSelected && ctx.hasUI) refreshIfStaleInBackground(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		codexSelected = event.model.provider === OPENAI_CODEX_PROVIDER;
		updateStatus(ctx);
		if (codexSelected && ctx.hasUI) refreshIfStaleInBackground(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!codexSelected) return;
		agentStartedAt = Date.now();
		updateStatus(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		const observed = parseCodexRateLimitHeaders(event.headers ?? {});
		if (!observed) return;
		snapshot = mergeCodexUsageSnapshots(snapshot, observed);
		lastHeaderAt = observed.fetchedAt;
		updateStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!ctx.hasUI || !codexSelected || lastHeaderAt >= agentStartedAt) return;
		if (Date.now() - endpointFetchedAt >= ACTIVE_REFRESH_INTERVAL_MS) refreshInBackground(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.hasUI || !codexSelected) return;
		// SSE responses usually carry x-codex-* headers. The default Codex
		// WebSocket transport does not expose response headers to extensions, so
		// force one request to start after that kind of run has settled. If an
		// older refresh is still in flight, refreshUsage queues the post-run one.
		if (lastHeaderAt < agentStartedAt) refreshInBackground(ctx, Date.now());
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// The UI is already going away.
		}
		alive = false;
		sessionAbort.abort();
	});
}

function parseCommandMode(args: string): CommandMode {
	const value = args.trim().toLowerCase();
	if (!value || value === "refresh" || value === "status") return "refresh";
	if (value === "cached") return "cached";
	throw new Error("Usage: /codex-usage [refresh|cached]");
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "AbortError" || /aborted|aborterror/i.test(error.message)) return "request cancelled";
		return error.message;
	}
	return String(error);
}
