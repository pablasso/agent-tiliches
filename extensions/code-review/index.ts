import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createReviewRunArtifacts,
	finalizeReviewRun,
	findLatestReviewRun,
	type ReviewRunArtifacts,
	type ReviewRunFinalization,
	writePrivate,
} from "./artifacts.ts";
import { getCodeReviewConfigPath, loadCodeReviewConfig, type CodeReviewConfig } from "./config.ts";
import {
	buildLeadHandoff,
	captureReviewSnapshot,
	formatRawReviews,
	hasReviewableChanges,
	type ReviewerResult,
	type ReviewSnapshot,
} from "./core.ts";
import { openPath } from "./open-logs.ts";
import { CodeReviewProgressPanel, type ReviewProgressItem } from "./progress.ts";
import { abortActiveReviewProcesses, runReviewersInParallel, type ReviewProgressState } from "./runner.ts";

const HANDOFF_MESSAGE_TYPE = "code-review-handoff";

interface PendingLeadRun {
	artifacts: ReviewRunArtifacts;
	results: ReviewerResult[];
	rawMarkdown: string;
}

interface ReviewWorkflowResult {
	status: "ready" | "cancelled" | "failed";
	results: ReviewerResult[];
	rawMarkdown: string;
	error?: string;
	runDir: string;
}

export default function codeReviewExtension(pi: ExtensionAPI) {
	if (process.env.PI_CODE_REVIEW_CHILD === "1") return;
	const pendingLeadRuns: PendingLeadRun[] = [];
	const leadLifecycle = new LeadLifecycleTracker<PendingLeadRun>((runDir) =>
		pendingLeadRuns.find((candidate) => candidate.artifacts.runDir === runDir),
	);

	pi.registerCommand("code-review", {
		description: "Run configured read-only reviewers, then hand feedback to the current implementation agent",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/code-review requires interactive TUI mode.", "error");
				return;
			}

			let config: CodeReviewConfig;
			try {
				config = await loadCodeReviewConfig();
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (config.reviewers.length === 0) {
				ctx.ui.notify(`No code-review models configured. Add reviewers to ${getCodeReviewConfigPath()}.`, "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No active model is available to adjudicate the review feedback.", "error");
				return;
			}

			await ctx.waitForIdle();

			let snapshot: ReviewSnapshot;
			try {
				snapshot = await captureReviewSnapshot(pi, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (!snapshot.status) {
				ctx.ui.notify("No working-tree changes found to review.", "info");
				return;
			}
			if (!hasReviewableChanges(snapshot)) {
				ctx.ui.notify("Changes were detected, but no textual patch could be captured for review.", "warning");
				return;
			}

			const focus = args.trim();
			const lead = {
				provider: ctx.model.provider,
				model: ctx.model.id,
				thinking: pi.getThinkingLevel(),
			};
			let artifacts: ReviewRunArtifacts;
			try {
				artifacts = await createReviewRunArtifacts(snapshot, config.reviewers, focus);
			} catch (error) {
				ctx.ui.notify(`Could not create code-review logs: ${errorMessage(error)}`, "error");
				return;
			}

			const workflow = await runWorkflowWithProgress(ctx, config, snapshot, focus, artifacts, lead);
			if (workflow.status === "cancelled") {
				ctx.ui.notify(`Code review cancelled. Partial logs: ${workflow.runDir}`, "info");
				return;
			}
			if (workflow.status === "failed") {
				ctx.ui.notify(`${workflow.error || "Code review failed."} Logs: ${workflow.runDir}`, "error");
				return;
			}

			const handoff = buildLeadHandoff(snapshot, workflow.results, focus, {
				runDir: workflow.runDir,
				handoffPath: artifacts.handoffPath,
				lead,
			});
			try {
				await writePrivate(artifacts.handoffPath, handoff);
				await finalizeReviewRun(artifacts, workflow.results, workflow.rawMarkdown, { status: "handed_off" });
			} catch (error) {
				ctx.ui.notify(`Could not persist the lead handoff: ${errorMessage(error)}. Logs: ${workflow.runDir}`, "error");
				return;
			}

			const pending: PendingLeadRun = {
				artifacts,
				results: workflow.results,
				rawMarkdown: workflow.rawMarkdown,
			};
			pendingLeadRuns.push(pending);
			try {
				leadLifecycle.arm(pending);
				pi.sendMessage(
					{
						customType: HANDOFF_MESSAGE_TYPE,
						content: handoff,
						display: false,
						details: { runDir: workflow.runDir },
					},
					{ triggerTurn: true },
				);
			} catch (error) {
				leadLifecycle.release(pending);
				removePendingRun(pendingLeadRuns, pending);
				await finalizeReviewRun(artifacts, workflow.results, workflow.rawMarkdown, {
					status: "failed",
					error: `Could not trigger current-session adjudication: ${errorMessage(error)}`,
				}).catch(() => {});
				ctx.ui.notify(`Could not trigger current-session adjudication: ${errorMessage(error)}`, "error");
				return;
			}

			ctx.ui.notify("Independent reviews complete. The current implementation agent is adjudicating them now.", "info");
		},
	});

	pi.registerCommand("code-review-logs", {
		description: "Open the latest saved /code-review run, or print its path with: /code-review-logs path",
		handler: async (args, ctx) => {
			let runDir: string | null;
			try {
				runDir = await findLatestReviewRun();
			} catch (error) {
				ctx.ui.notify(`Could not find code-review logs: ${errorMessage(error)}`, "error");
				return;
			}
			if (!runDir) {
				ctx.ui.notify("No saved code-review runs found.", "info");
				return;
			}

			const action = args.trim().toLowerCase();
			if (action === "path" || ctx.mode !== "tui") {
				ctx.ui.notify(runDir, "info");
				return;
			}
			if (action && action !== "open") {
				ctx.ui.notify("Usage: /code-review-logs [open|path]", "warning");
				return;
			}
			await openPath(ctx, runDir);
		},
	});

	pi.on("agent_end", (event) => {
		leadLifecycle.observe(event.messages);
	});

	registerAgentSettledHandler(pi, async (_event, ctx) => {
		const settled = leadLifecycle.settle();
		if (!settled) return;
		removePendingRun(pendingLeadRuns, settled.value);
		try {
			await finalizeReviewRun(
				settled.value.artifacts,
				settled.value.results,
				settled.value.rawMarkdown,
				settled.finalization,
			);
			if (settled.finalization.status === "cancelled") {
				ctx.ui.notify(`Lead opinion cancelled. Partial output, if any, is in ${settled.value.artifacts.runDir}.`, "info");
			} else if (settled.finalization.status === "failed") {
				ctx.ui.notify(
					`${settled.finalization.error || "Lead opinion failed."} Logs: ${settled.value.artifacts.runDir}`,
					"warning",
				);
			}
		} catch (error) {
			ctx.ui.notify(`Could not save the lead opinion: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		abortActiveReviewProcesses();
		leadLifecycle.reset();
		const interrupted = pendingLeadRuns.splice(0);
		await Promise.all(
			interrupted.map((pending) =>
				finalizeReviewRun(pending.artifacts, pending.results, pending.rawMarkdown, {
					status: "failed",
					error: "Current-session adjudication was interrupted by session shutdown.",
				}).catch(() => {}),
			),
		);
	});
}

async function runWorkflowWithProgress(
	ctx: ExtensionCommandContext,
	config: CodeReviewConfig,
	snapshot: ReviewSnapshot,
	focus: string,
	artifacts: ReviewRunArtifacts,
	lead: { provider: string; model: string; thinking: string },
): Promise<ReviewWorkflowResult> {
	return ctx.ui.custom<ReviewWorkflowResult>((tui, theme, keybindings, done) => {
		const handoffLabel = "Current implementation agent";
		const initialItems: ReviewProgressItem[] = [
			...config.reviewers.map((reviewer, index) => ({
				id: `reviewer-${index}`,
				label: reviewer.name,
				subtitle: `${reviewer.provider}/${reviewer.model} · effort: ${reviewer.thinking}`,
				state: "pending" as const,
				logDir: artifacts.reviewersDir,
			})),
			{
				id: "current-session-handoff",
				label: handoffLabel,
				subtitle: `${lead.provider}/${lead.model} · effort: ${lead.thinking}`,
				state: "pending" as const,
				logDir: artifacts.runDir,
			},
		];
		const panel = new CodeReviewProgressPanel(initialItems, artifacts.runDir, tui, theme, keybindings);
		const externalAbort = ctx.signal;
		const onExternalAbort = (): void => panel.cancel();
		if (externalAbort?.aborted) panel.cancel();
		else externalAbort?.addEventListener("abort", onExternalAbort, { once: true });
		let settled = false;
		const finish = (result: ReviewWorkflowResult): void => {
			if (settled) return;
			settled = true;
			externalAbort?.removeEventListener("abort", onExternalAbort);
			done(result);
		};

		queueMicrotask(async () => {
			let results: ReviewerResult[] = [];
			let error: string | undefined;
			let status: ReviewWorkflowResult["status"] = "failed";
			const onProgress = panel.update.bind(panel);

			try {
				results = await runReviewersInParallel(
					config.reviewers,
					snapshot,
					focus,
					artifacts,
					config,
					onProgress,
					panel.signal,
				);

				if (panel.signal.aborted) {
					status = "cancelled";
				} else if (!results.some((result) => result.ok)) {
					error = "All configured reviewers failed; no lead opinion was requested.";
					panel.update(finishedProgress("current-session-handoff", handoffLabel, "failed", artifacts.runDir, error));
				} else {
					panel.update({
						id: "current-session-handoff",
						label: handoffLabel,
						state: "handed_off",
						finishedAt: Date.now(),
						logDir: artifacts.runDir,
					});
					status = "ready";
				}
			} catch (workflowFailure) {
				error = errorMessage(workflowFailure);
				status = panel.signal.aborted ? "cancelled" : "failed";
				markUnfinished(panel, initialItems, status === "cancelled" ? "cancelled" : "failed", error);
			}

			const rawMarkdown = formatRawReviews(snapshot, results);
			if (status !== "ready") {
				try {
					await finalizeReviewRun(artifacts, results, rawMarkdown, { status, error });
				} catch (finalizeFailure) {
					const message = `Could not finalize review artifacts: ${errorMessage(finalizeFailure)}`;
					error = error ? `${error} ${message}` : message;
					status = "failed";
				}
			}

			finish({ status, results, rawMarkdown, error, runDir: artifacts.runDir });
		});

		return panel;
	});
}

function markUnfinished(
	panel: CodeReviewProgressPanel,
	items: ReviewProgressItem[],
	state: Extract<ReviewProgressState, "failed" | "cancelled">,
	detail: string | undefined,
): void {
	for (const item of items) panel.update(finishedProgress(item.id, item.label, state, item.logDir, detail));
}

function finishedProgress(
	id: string,
	label: string,
	state: Extract<ReviewProgressState, "failed" | "cancelled">,
	logDir: string,
	detail?: string,
) {
	return { id, label, state, finishedAt: Date.now(), detail, logDir };
}

function removePendingRun(runs: PendingLeadRun[], target: PendingLeadRun): void {
	const index = runs.lastIndexOf(target);
	if (index >= 0) runs.splice(index, 1);
}

interface LeadAssistantSnapshot {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

interface ActiveLeadRun<T> {
	value: T;
	assistant?: LeadAssistantSnapshot;
}

/** Tracks one logical handoff across Pi's low-level retry/compaction runs. */
export class LeadLifecycleTracker<T> {
	private readonly findPending: (runDir: string) => T | undefined;
	private active: ActiveLeadRun<T> | undefined;

	constructor(findPending: (runDir: string) => T | undefined) {
		this.findPending = findPending;
	}

	arm(value: T): void {
		if (this.active && this.active.value !== value) {
			throw new Error("Another current-session code-review adjudication is already active.");
		}
		this.active = { value, assistant: this.active?.assistant };
	}

	release(value: T): void {
		if (this.active?.value === value) this.active = undefined;
	}

	observe(messages: unknown[]): void {
		const runDir = handoffRunDir(messages);
		if (runDir) {
			const value = this.findPending(runDir);
			if (!value) return;
			if (this.active && this.active.value !== value) return;
			this.active = { value, assistant: this.active?.assistant };
		}
		if (!this.active) return;
		const assistant = latestAssistant(messages);
		if (assistant) this.active.assistant = assistant;
	}

	settle(): { value: T; finalization: ReviewRunFinalization } | null {
		if (!this.active) return null;
		const active = this.active;
		this.active = undefined;
		return { value: active.value, finalization: classifyLeadAssistant(active.assistant) };
	}

	reset(): void {
		this.active = undefined;
	}
}

interface AgentSettledRegistrar {
	on(
		event: "agent_settled",
		handler: (event: { type: "agent_settled" }, ctx: ExtensionContext) => Promise<void> | void,
	): void;
}

function registerAgentSettledHandler(
	pi: ExtensionAPI,
	handler: (event: { type: "agent_settled" }, ctx: ExtensionContext) => Promise<void> | void,
): void {
	// agent_settled was added after the repository's development-time Pi typings.
	(pi as unknown as AgentSettledRegistrar).on("agent_settled", handler);
}

function classifyLeadAssistant(assistant: LeadAssistantSnapshot | undefined): ReviewRunFinalization {
	if (!assistant) {
		return { status: "failed", error: "The current implementation agent produced no lead response." };
	}

	const partialOpinion = assistant.text || undefined;
	const partial = partialOpinion ? { partialOpinion } : {};
	if (assistant.stopReason === "stop") {
		return partialOpinion
			? { status: "completed", opinion: partialOpinion }
			: { status: "failed", error: "The current implementation agent produced no textual lead opinion." };
	}
	if (assistant.stopReason === "aborted") {
		return {
			status: "cancelled",
			...partial,
			error: "Current-session adjudication was cancelled before a complete lead opinion was produced.",
		};
	}
	if (assistant.stopReason === "error") {
		return {
			status: "failed",
			...partial,
			error: assistant.errorMessage
				? `Current-session adjudication failed: ${assistant.errorMessage}`
				: "Current-session adjudication failed before a complete lead opinion was produced.",
		};
	}
	if (assistant.stopReason === "length") {
		return {
			status: "failed",
			...partial,
			error: "Current-session adjudication reached its output limit before completing.",
		};
	}
	return {
		status: "failed",
		...partial,
		error: `Current-session adjudication ended with an unexpected stop reason: ${assistant.stopReason || "unknown"}.`,
	};
}

function handoffRunDir(messages: unknown[]): string | null {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: unknown; customType?: unknown; details?: unknown };
		if (candidate.role !== "custom" || candidate.customType !== HANDOFF_MESSAGE_TYPE) continue;
		if (!candidate.details || typeof candidate.details !== "object") return null;
		const runDir = (candidate.details as { runDir?: unknown }).runDir;
		return typeof runDir === "string" && runDir.length > 0 ? runDir : null;
	}
	return null;
}

function latestAssistant(messages: unknown[]): LeadAssistantSnapshot | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const candidate = message as {
			role?: unknown;
			content?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		if (candidate.role !== "assistant") continue;
		return {
			text: contentToText(candidate.content).trim(),
			stopReason: typeof candidate.stopReason === "string" ? candidate.stopReason : undefined,
			errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
		};
	}
	return undefined;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const value = block as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
