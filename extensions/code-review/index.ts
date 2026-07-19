import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";
import {
	createReviewRunArtifacts,
	finalizeReviewRun,
	findLatestReviewRun,
	type ReviewRunArtifacts,
} from "./artifacts.ts";
import { getCodeReviewConfigPath, loadCodeReviewConfig, type CodeReviewConfig, type Reviewer } from "./config.ts";
import {
	captureReviewSnapshot,
	formatOpinionMessage,
	formatRawReviews,
	hasReviewableChanges,
	type ReviewBundleDetails,
	type ReviewerResult,
	type ReviewSnapshot,
} from "./core.ts";
import { openPath } from "./open-logs.ts";
import { CodeReviewProgressPanel, type ReviewProgressItem } from "./progress.ts";
import {
	abortActiveReviewProcesses,
	runAdjudicator,
	runReviewersInParallel,
	type ReviewProgressState,
} from "./runner.ts";

const CUSTOM_MESSAGE_TYPE = "code-review-results";

interface ReviewWorkflowResult {
	status: "completed" | "cancelled" | "failed";
	results: ReviewerResult[];
	opinion?: string;
	error?: string;
	runDir: string;
}

export default function codeReviewExtension(pi: ExtensionAPI) {
	if (process.env.PI_CODE_REVIEW_CHILD === "1") return;

	pi.registerMessageRenderer<ReviewBundleDetails>(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details;
		const markdown = details?.markdown ?? contentToText(message.content);
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme()));
		return box;
	});

	pi.registerCommand("code-review", {
		description: "Run configured read-only reviewers in parallel, then adjudicate their feedback",
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
				ctx.ui.notify("No active parent model is available for the final lead opinion.", "error");
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
			let artifacts: ReviewRunArtifacts;
			try {
				artifacts = await createReviewRunArtifacts(snapshot, config.reviewers, focus);
			} catch (error) {
				ctx.ui.notify(`Could not create code-review logs: ${errorMessage(error)}`, "error");
				return;
			}

			const workflow = await runWorkflowWithProgress(ctx, config, snapshot, focus, artifacts);
			if (workflow.status === "cancelled") {
				ctx.ui.notify(`Code review cancelled. Partial logs: ${workflow.runDir}`, "info");
				return;
			}
			if (workflow.status === "failed" || !workflow.opinion) {
				ctx.ui.notify(`${workflow.error || "Code review failed."} Logs: ${workflow.runDir}`, "error");
				return;
			}

			const opinionMarkdown = formatOpinionMessage(workflow.opinion);
			pi.sendMessage<ReviewBundleDetails>({
				customType: CUSTOM_MESSAGE_TYPE,
				content: opinionMarkdown,
				display: true,
				details: {
					type: "opinion",
					title: "Lead opinion",
					repoRoot: snapshot.repoRoot,
					baseRevision: snapshot.baseRevision,
					generatedAt: Date.now(),
					logDir: workflow.runDir,
				},
			});
			ctx.ui.notify("Code review complete. Run /code-review-logs to open the saved reviewer logs.", "info");
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

	pi.on("session_shutdown", () => {
		abortActiveReviewProcesses();
	});
}

async function runWorkflowWithProgress(
	ctx: ExtensionCommandContext,
	config: CodeReviewConfig,
	snapshot: ReviewSnapshot,
	focus: string,
	artifacts: ReviewRunArtifacts,
): Promise<ReviewWorkflowResult> {
	return ctx.ui.custom<ReviewWorkflowResult>((tui, theme, keybindings, done) => {
		const leadLabel = "Lead opinion";
		const initialItems: ReviewProgressItem[] = [
			...config.reviewers.map((reviewer, index) => ({
				id: `reviewer-${index}`,
				label: reviewer.name,
				subtitle: `${reviewer.provider}/${reviewer.model} · effort: ${reviewer.thinking}`,
				state: "pending" as const,
				logDir: artifacts.reviewersDir,
			})),
			{
				id: "lead-opinion",
				label: leadLabel,
				subtitle: `${ctx.model!.provider}/${ctx.model!.id} · effort: ${config.leadThinking}`,
				state: "pending" as const,
				logDir: artifacts.leadDir,
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
			let opinion: string | undefined;
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
					error = "All configured reviewers failed; no lead opinion was generated.";
					panel.update(finishedProgress("lead-opinion", leadLabel, "failed", artifacts.leadDir, error));
				} else {
					try {
						opinion = await runAdjudicator(
							{ provider: ctx.model!.provider, id: ctx.model!.id },
							config.leadThinking,
							snapshot,
							results,
							focus,
							artifacts,
							config,
							onProgress,
							panel.signal,
						);
						status = panel.signal.aborted ? "cancelled" : "completed";
					} catch (leadFailure) {
						error = errorMessage(leadFailure);
						status = panel.signal.aborted ? "cancelled" : "failed";
					}
				}
			} catch (workflowFailure) {
				error = errorMessage(workflowFailure);
				status = panel.signal.aborted ? "cancelled" : "failed";
				markUnfinished(panel, initialItems, status === "cancelled" ? "cancelled" : "failed", error);
			}

			const rawMarkdown = formatRawReviews(snapshot, results);
			try {
				await finalizeReviewRun(artifacts, results, opinion, rawMarkdown, status, error);
			} catch (finalizeFailure) {
				const message = `Could not finalize review artifacts: ${errorMessage(finalizeFailure)}`;
				error = error ? `${error} ${message}` : message;
				if (status === "completed") status = "failed";
			}

			finish({ status, results, opinion, error, runDir: artifacts.runDir });
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
