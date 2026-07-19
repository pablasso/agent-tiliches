import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeReviewProgressPanel } from "../extensions/code-review/progress.ts";
import codeReviewExtension from "../extensions/code-review/index.ts";
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
	buildAdjudicationPrompt,
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
	await run("mkdir", ["-p", repo, agentDir], root);
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

	assert.deepEqual(await loadCodeReviewConfig(agentDir), { reviewers: [], extensions: [], leadThinking: "max" });
	assert.match(emptyConfigExample(), /"reviewers": \[\]/);
	const reviewers: Reviewer[] = [
		{ name: "Reviewer Alpha", provider: "local-provider", model: "model-alpha", thinking: "max" },
		{ name: "Reviewer Beta", provider: "local-provider", model: "model-beta", thinking: "high" },
	];
	await writeFile(
		getCodeReviewConfigPath(agentDir),
		`${JSON.stringify({ reviewers, extensions: ["npm:local-provider-extension"], leadThinking: "xhigh" }, null, 2)}\n`,
		"utf8",
	);
	const config = await loadCodeReviewConfig(agentDir);
	assert.deepEqual(config.reviewers, reviewers);
	assert.deepEqual(config.extensions, ["npm:local-provider-extension"]);
	assert.equal(config.leadThinking, "xhigh");

	const reviewerPrompt = buildReviewerSystemPrompt();
	for (const severity of ["P0 Critical", "P1 High", "P2 Medium", "P3 Low"]) {
		assert.match(reviewerPrompt, new RegExp(severity));
	}
	assert.match(reviewerPrompt, /smallest reasonable fix/i);
	assert.match(reviewerPrompt, /large refactor/i);

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

	const adjudication = buildAdjudicationPrompt(snapshot, results, "focus on regressions");
	assert.match(adjudication, /VALID, PARTIALLY VALID, NOT VALID, or NEEDS MORE EVIDENCE/);
	assert.match(adjudication, /Reject disproportionate remedies/);
	assert.match(adjudication, /focus on regressions/);
	assert.match(adjudication, /Authoritative patch/);

	const artifacts = await createReviewRunArtifacts(snapshot, reviewers, "focus on regressions", agentDir);
	await finalizeReviewRun(artifacts, results, "# Lead opinion\n\nSafe to proceed.", raw, "completed");
	assert.equal(await findLatestReviewRun(agentDir), artifacts.runDir);
	assert.match(await readFile(join(artifacts.runDir, "summary.md"), "utf8"), /Safe to proceed/);
	assert.equal((await readFile(join(artifacts.runDir, "snapshot.diff"), "utf8")).includes("value = 2"), true);

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
				id: "lead-opinion",
				label: "Lead opinion",
				subtitle: "local-provider/model-lead · effort: xhigh",
				state: "pending",
				logDir: artifacts.leadDir,
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
	progress.handleInput("escape");
	const renderedProgress = stripAnsi(progress.render(120).join("\n"));
	assert.match(renderedProgress, /finished.*Reviewer Alpha/);
	assert.match(renderedProgress, /cancelled.*Lead opinion/);
	assert.match(renderedProgress, /local-provider\/model-lead · effort: xhigh/);
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
