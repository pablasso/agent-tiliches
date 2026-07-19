import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Reviewer } from "./config.ts";
import type { ReviewerResult, ReviewSnapshot } from "./core.ts";

export interface ModelLogPaths {
	directory: string;
	events: string;
	stderr: string;
	result: string;
	invocation: string;
}

export interface ReviewRunArtifacts {
	runDir: string;
	promptsDir: string;
	reviewersDir: string;
	leadDir: string;
}

export function getCodeReviewStateDir(agentDir = getAgentDir()): string {
	return join(agentDir, "code-review");
}

export function getCodeReviewRunsDir(agentDir = getAgentDir()): string {
	return join(getCodeReviewStateDir(agentDir), "runs");
}

export async function createReviewRunArtifacts(
	snapshot: ReviewSnapshot,
	reviewers: readonly Reviewer[],
	focus: string,
	agentDir = getAgentDir(),
): Promise<ReviewRunArtifacts> {
	const runsDir = getCodeReviewRunsDir(agentDir);
	await mkdir(runsDir, { recursive: true, mode: 0o700 });

	const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const repoName = slug(basename(snapshot.repoRoot)) || "repository";
	const runDir = await mkdtemp(join(runsDir, `${timestamp}-${repoName}-`));
	const promptsDir = join(runDir, "prompts");
	const reviewersDir = join(runDir, "reviewers");
	const leadDir = join(runDir, "lead-opinion");
	await Promise.all([
		mkdir(promptsDir, { mode: 0o700 }),
		mkdir(reviewersDir, { mode: 0o700 }),
		mkdir(leadDir, { mode: 0o700 }),
	]);

	const metadata = {
		version: 1,
		startedAt: new Date().toISOString(),
		repository: snapshot.repoRoot,
		baseRevision: snapshot.baseRevision,
		focus: focus || null,
		reviewers: reviewers.map(({ name, provider, model, thinking }) => ({ name, provider, model, thinking })),
		warnings: snapshot.warnings,
	};
	await Promise.all([
		writePrivate(join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`),
		writePrivate(join(runDir, "git-status.txt"), `${snapshot.status}\n`),
		writePrivate(join(runDir, "snapshot.diff"), snapshot.patch),
	]);

	return { runDir, promptsDir, reviewersDir, leadDir };
}

export async function createReviewerLogPaths(
	artifacts: ReviewRunArtifacts,
	index: number,
	reviewer: Reviewer,
): Promise<ModelLogPaths> {
	const directory = join(
		artifacts.reviewersDir,
		`${String(index + 1).padStart(2, "0")}-${slug(reviewer.name) || slug(reviewer.model) || "reviewer"}`,
	);
	await mkdir(directory, { mode: 0o700 });
	return modelLogPaths(directory);
}

export function getLeadLogPaths(artifacts: ReviewRunArtifacts): ModelLogPaths {
	return modelLogPaths(artifacts.leadDir);
}

export async function finalizeReviewRun(
	artifacts: ReviewRunArtifacts,
	results: ReviewerResult[],
	opinion: string | undefined,
	rawReviewMarkdown: string,
	status: "completed" | "cancelled" | "failed",
	leadError?: string,
): Promise<void> {
	const outcome = {
		finishedAt: new Date().toISOString(),
		status,
		reviewers: results.map((result) => ({
			name: result.reviewer.name,
			provider: result.reviewer.provider,
			model: result.reviewer.model,
			ok: result.ok,
			stopReason: result.stopReason,
			durationMs: result.durationMs,
			error: result.error,
			logDir: result.logDir,
		})),
		leadOpinion: opinion ? "completed" : leadError ? "failed" : "not-run",
		leadError,
	};
	const summary = [
		rawReviewMarkdown,
		opinion ? `\n\n---\n\n${opinion.trim()}\n` : "",
		leadError ? `\n\n---\n\n# Lead opinion failed\n\n${leadError}\n` : "",
	].join("");

	await Promise.all([
		writePrivate(join(artifacts.runDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`),
		writePrivate(join(artifacts.runDir, "summary.md"), summary),
	]);
}

export async function findLatestReviewRun(agentDir = getAgentDir()): Promise<string | null> {
	const runsDir = getCodeReviewRunsDir(agentDir);
	let entries;
	try {
		entries = await readdir(runsDir, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return null;
		throw error;
	}
	const latest = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.at(-1);
	return latest ? join(runsDir, latest) : null;
}

export async function readReviewRunMetadata(runDir: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function writePrivate(path: string, content: string | Buffer): Promise<void> {
	await writeFile(path, content, { mode: 0o600 });
}

function modelLogPaths(directory: string): ModelLogPaths {
	return {
		directory,
		events: join(directory, "events.jsonl"),
		stderr: join(directory, "stderr.log"),
		result: join(directory, "result.md"),
		invocation: join(directory, "invocation.json"),
	};
}

function slug(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 60);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
