import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeReviewProgressPanel } from "../extensions/code-review/progress.ts";
import codeReviewExtension, { LeadLifecycleTracker } from "../extensions/code-review/index.ts";
import {
	createReviewRunArtifacts,
	finalizeReviewRun,
	findLatestReviewRun,
} from "../extensions/code-review/artifacts.ts";
import {
	emptyConfigExample,
	getCodeReviewConfigPath,
	loadCodeReviewConfig,
	type Reviewer,
} from "../extensions/code-review/config.ts";
import {
	buildLeadHandoff,
	buildReviewerSystemPrompt,
	captureReviewSnapshot,
	formatRawReviews,
	hasReviewableChanges,
	type ReviewerResult,
} from "../extensions/code-review/core.ts";

const root = await mkdtemp(join(tmpdir(), "pi-code-review-smoke-"));
const repo = join(root, "repo");
const agentDir = join(root, "agent");
try {
	await Promise.all([mkdir(repo, { recursive: true }), mkdir(agentDir, { recursive: true })]);
	await git(repo, ["init", "-q"]);
	await git(repo, ["config", "user.email", "code-review@example.test"]);
	await git(repo, ["config", "user.name", "Code Review Smoke"]);
	await writeFile(join(repo, "tracked.ts"), "export const value = 1;\n", "utf8");
	await git(repo, ["add", "tracked.ts"]);
	await git(repo, ["commit", "-qm", "initial"]);
	await writeFile(join(repo, "tracked.ts"), "export const value = 2;\n", "utf8");
	await writeFile(join(repo, "new file.ts"), "export const added = true;\n", "utf8");

	const pi = createPiHarness(repo);
	const snapshot = await captureReviewSnapshot(pi, repo);
	assert.match(snapshot.baseRevision ?? "", /^[0-9a-f]{40}$/);
	assert.match(snapshot.status, /tracked\.ts/);
	assert.match(snapshot.status, /new file\.ts/);
	assert.match(snapshot.patch, /-export const value = 1;/);
	assert.match(snapshot.patch, /\+export const value = 2;/);
	assert.match(snapshot.patch, /new file\.ts/);
	assert.equal(hasReviewableChanges(snapshot), true);

	assert.deepEqual(await loadCodeReviewConfig(agentDir), { reviewers: [], extensions: [] });
	assert.match(emptyConfigExample(), /"reviewers": \[\]/);
	const reviewers: Reviewer[] = [
		{ name: "Reviewer Alpha", provider: "local-provider", model: "model-alpha", thinking: "max" },
		{ name: "Reviewer Beta", provider: "local-provider", model: "model-beta", thinking: "high" },
	];
	await writeFile(
		getCodeReviewConfigPath(agentDir),
		`${JSON.stringify({ reviewers, extensions: ["npm:local-provider-extension"] }, null, 2)}\n`,
		"utf8",
	);
	const config = await loadCodeReviewConfig(agentDir);
	assert.deepEqual(config.reviewers, reviewers);
	assert.deepEqual(config.extensions, ["npm:local-provider-extension"]);

	const reviewerPrompt = buildReviewerSystemPrompt();
	for (const severity of ["P0 Critical", "P1 High", "P2 Medium", "P3 Low"]) {
		assert.match(reviewerPrompt, new RegExp(severity));
	}
	assert.match(reviewerPrompt, /smallest reasonable candidate fix/i);
	assert.match(reviewerPrompt, /advisory evidence/i);
	assert.match(reviewerPrompt, /not the final action or cost-benefit judgment/i);
	assert.match(reviewerPrompt, /fix involvement: TINY, SMALL, MEDIUM, or LARGE/i);
	assert.match(reviewerPrompt, /expected footprint:/i);
	assert.match(reviewerPrompt, /complexity drivers:/i);
	assert.match(reviewerPrompt, /ongoing maintenance impact: DECREASES, NEUTRAL, or INCREASES/i);
	assert.match(reviewerPrompt, /estimate confidence: HIGH, MEDIUM, or LOW/i);
	assert.match(reviewerPrompt, /Do not assign FIX NOW, FOLLOW-UP, INVESTIGATE, or NO ACTION/);
	assert.match(reviewerPrompt, /Do not provide time estimates or story points/);
	assert.match(reviewerPrompt, /smallest credible fix is large/i);

	const results: ReviewerResult[] = reviewers.map((reviewer, index) => ({
		reviewer,
		ok: true,
		output: index === 0 ? "## Findings\nNo actionable defects found." : "## Findings\n### [P2] Example",
		durationMs: 1_000 + index,
		logDir: join(root, `reviewer-${index}`),
	}));
	const raw = formatRawReviews(snapshot, results);
	assert.match(raw, /Reviewer Alpha/);
	assert.match(raw, /Reviewer Beta/);
	assert.match(raw, /unverified until the adjudication/i);

	const artifacts = await createReviewRunArtifacts(snapshot, reviewers, "focus on regressions", agentDir);
	const handoff = buildLeadHandoff(snapshot, results, "focus on regressions", {
		runDir: artifacts.runDir,
		handoffPath: artifacts.handoffPath,
		lead: { provider: "local-provider", model: "model-lead", thinking: "xhigh" },
	});
	assert.match(handoff, /current implementation agent/i);
	assert.match(handoff, /VALID, PARTIALLY VALID, NOT VALID, or NEEDS MORE EVIDENCE/);
	assert.match(handoff, /## What I recommend/);
	assert.match(handoff, /FIX NOW — before proceeding/);
	assert.match(handoff, /FOLLOW-UP — recommended separately, not required now/);
	assert.match(handoff, /INVESTIGATE — collect evidence; do not change code yet/);
	assert.match(handoff, /NO ACTION — I recommend no work/);
	assert.match(handoff, /Reviewer claim \(not my conclusion\)/);
	assert.match(handoff, /Reviewer fix proposal\(s\) \(advisory\)/);
	assert.match(handoff, /Fix I evaluated/);
	assert.match(handoff, /My expected footprint/);
	assert.match(handoff, /My fix involvement/);
	assert.match(handoff, /My complexity drivers/);
	assert.match(handoff, /My maintenance impact/);
	assert.match(handoff, /My estimate confidence/);
	assert.match(handoff, /Do not copy a reviewer estimate without verifying it/);
	assert.match(handoff, /based on both the defect and the remedy’s implementation\/maintenance cost/);
	assert.match(handoff, /reviewer claims and fix estimates are advisory evidence only/);
	assert.match(handoff, /TINY \| SMALL \| MEDIUM \| LARGE \| N\/A/);
	assert.match(handoff, /Do not provide time estimates or story points/);
	assert.match(handoff, /FIX NOW and FOLLOW-UP are the only labels that recommend a code change/);
	assert.match(handoff, /Every finding ID must appear exactly once/);
	assert.doesNotMatch(handoff, /Consider later:/);
	assert.doesNotMatch(handoff, /Proportionate action:/);
	assert.match(handoff, /reject disproportionate remedies/i);
	assert.match(handoff, /focus on regressions/);
	assert.match(handoff, /snapshot\.diff/);
	assert.match(handoff, /Reviewer Alpha \(local-provider\/model-alpha, effort: max\)/);
	assert.match(handoff, /Lead: current session local-provider\/model-lead \(effort: xhigh\)/);
	assert.ok(Buffer.byteLength(handoff, "utf8") <= 64 * 1024);

	await writeFile(artifacts.handoffPath, handoff, "utf8");
	await finalizeReviewRun(artifacts, results, raw, { status: "handed_off" });
	assert.equal(await findLatestReviewRun(agentDir), artifacts.runDir);
	assert.match(await readFile(join(artifacts.runDir, "summary.md"), "utf8"), /Delegated to the current implementation session/);
	await finalizeReviewRun(artifacts, results, raw, {
		status: "completed",
		opinion: "# Lead opinion\n\nSafe to proceed.",
	});
	assert.match(await readFile(join(artifacts.runDir, "summary.md"), "utf8"), /Safe to proceed/);
	assert.match(await readFile(join(artifacts.runDir, "lead-opinion.md"), "utf8"), /Safe to proceed/);
	assert.equal((await readFile(join(artifacts.runDir, "snapshot.diff"), "utf8")).includes("value = 2"), true);

	const pendingLead = { runDir: artifacts.runDir };
	const lifecycle = new LeadLifecycleTracker((runDir) => (runDir === pendingLead.runDir ? pendingLead : undefined));
	lifecycle.arm(pendingLead);
	lifecycle.observe([
		leadHandoffMessage(pendingLead.runDir),
		assistantMessage("Retryable partial output", "error", "rate limit 429"),
	]);
	lifecycle.observe([assistantMessage("# Lead opinion\n\nSafe after retry.", "stop")]);
	assert.deepEqual(lifecycle.settle(), {
		value: pendingLead,
		finalization: { status: "completed", opinion: "# Lead opinion\n\nSafe after retry." },
	});
	assert.equal(lifecycle.settle(), null);

	const startupFailureLifecycle = new LeadLifecycleTracker((runDir) =>
		runDir === pendingLead.runDir ? pendingLead : undefined,
	);
	startupFailureLifecycle.arm(pendingLead);
	startupFailureLifecycle.observe([assistantMessage("", "error", "provider initialization failed")]);
	assert.deepEqual(startupFailureLifecycle.settle(), {
		value: pendingLead,
		finalization: {
			status: "failed",
			error: "Current-session adjudication failed: provider initialization failed",
		},
	});

	const abortedLifecycle = new LeadLifecycleTracker((runDir) => (runDir === pendingLead.runDir ? pendingLead : undefined));
	abortedLifecycle.observe([
		leadHandoffMessage(pendingLead.runDir),
		assistantMessage("# Lead opinion\n\nIncomplete", "aborted"),
	]);
	const aborted = abortedLifecycle.settle();
	assert.equal(aborted?.finalization.status, "cancelled");
	assert.equal(aborted?.finalization.opinion, undefined);
	assert.equal(aborted?.finalization.partialOpinion, "# Lead opinion\n\nIncomplete");

	const failedLifecycle = new LeadLifecycleTracker((runDir) => (runDir === pendingLead.runDir ? pendingLead : undefined));
	failedLifecycle.observe([
		leadHandoffMessage(pendingLead.runDir),
		assistantMessage("# Lead opinion\n\nIncomplete failure", "error", "server error 503"),
	]);
	const failed = failedLifecycle.settle();
	assert.equal(failed?.finalization.status, "failed");
	assert.match(failed?.finalization.error ?? "", /server error 503/);
	assert.equal(failed?.finalization.opinion, undefined);
	assert.equal(failed?.finalization.partialOpinion, "# Lead opinion\n\nIncomplete failure");

	const partialArtifacts = await createReviewRunArtifacts(snapshot, reviewers, "partial lead", agentDir);
	await finalizeReviewRun(partialArtifacts, results, raw, aborted!.finalization);
	assert.match(
		await readFile(join(partialArtifacts.runDir, "lead-opinion.partial.md"), "utf8"),
		/not authoritative/i,
	);
	await assert.rejects(readFile(join(partialArtifacts.runDir, "lead-opinion.md"), "utf8"), { code: "ENOENT" });
	const partialOutcome = JSON.parse(await readFile(join(partialArtifacts.runDir, "outcome.json"), "utf8"));
	assert.equal(partialOutcome.status, "cancelled");
	assert.equal(partialOutcome.leadOpinion, "partial-not-authoritative");

	let renderRequests = 0;
	const progress = new CodeReviewProgressPanel(
		[
			{
				id: "reviewer-0",
				label: "Reviewer Alpha",
				subtitle: "local-provider/model-alpha · effort: max",
				state: "pending",
				logDir: artifacts.reviewersDir,
			},
			{
				id: "current-session-handoff",
				label: "Current implementation agent",
				subtitle: "local-provider/model-lead · effort: xhigh",
				state: "pending",
				logDir: artifacts.runDir,
			},
		],
		artifacts.runDir,
		{ requestRender: () => renderRequests++ } as never,
		createThemeHarness() as never,
		{ matches: (data: string) => data === "escape" } as never,
	);
	progress.update({
		id: "reviewer-0",
		label: "Reviewer Alpha",
		state: "in_progress",
		startedAt: Date.now() - 1_500,
		logDir: artifacts.reviewersDir,
	});
	assert.match(stripAnsi(progress.render(120).join("\n")), /in progress.*Reviewer Alpha/);
	assert.match(stripAnsi(progress.render(120).join("\n")), /local-provider\/model-alpha · effort: max/);
	progress.update({
		id: "reviewer-0",
		label: "Reviewer Alpha",
		state: "finished",
		startedAt: Date.now() - 1_500,
		finishedAt: Date.now(),
		logDir: artifacts.reviewersDir,
	});
	progress.update({
		id: "current-session-handoff",
		label: "Current implementation agent",
		state: "handed_off",
		finishedAt: Date.now(),
		logDir: artifacts.runDir,
	});
	const renderedProgress = stripAnsi(progress.render(120).join("\n"));
	assert.match(renderedProgress, /finished.*Reviewer Alpha/);
	assert.match(renderedProgress, /handed off.*Current implementation agent/);
	assert.match(renderedProgress, /local-provider\/model-lead · effort: xhigh/);
	progress.handleInput("escape");
	assert.equal(progress.signal.aborted, true);
	assert.ok(renderRequests > 0);
	progress.dispose();

	const commands: string[] = [];
	codeReviewExtension({
		registerCommand(name: string) {
			commands.push(name);
		},
		registerMessageRenderer() {},
		on() {},
	} as unknown as ExtensionAPI);
	assert.deepEqual(commands, ["code-review", "code-review-logs"]);
	assert.equal("registerTool" in ({} as ExtensionAPI), false);

	console.log("code-review smoke ok");
} finally {
	await rm(root, { recursive: true, force: true });
}

function leadHandoffMessage(runDir: string) {
	return {
		role: "custom",
		customType: "code-review-handoff",
		content: "handoff",
		details: { runDir },
	};
}

function assistantMessage(text: string, stopReason: string, errorMessage?: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		errorMessage,
	};
}

function createThemeHarness() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function createPiHarness(cwd: string): ExtensionAPI {
	return {
		exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }) {
			return run(command, args, options?.cwd ?? cwd);
		},
	} as unknown as ExtensionAPI;
}

async function git(cwd: string, args: string[]): Promise<void> {
	const result = await run("git", args, cwd);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout);
}

async function run(command: string, args: string[], cwd: string) {
	const { spawn } = await import("node:child_process");
	return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
		const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1, killed: false }));
	});
}
