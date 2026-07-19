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
	handoffPath: string;
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
	const handoffPath = join(runDir, "lead-handoff.md");
	await Promise.all([mkdir(promptsDir, { mode: 0o700 }), mkdir(reviewersDir, { mode: 0o700 })]);

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

	return { runDir, promptsDir, reviewersDir, handoffPath };
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

export interface ReviewRunFinalization {
	status: "completed" | "handed_off" | "cancelled" | "failed";
	opinion?: string;
	partialOpinion?: string;
	error?: string;
}

export async function finalizeReviewRun(
	artifacts: ReviewRunArtifacts,
	results: ReviewerResult[],
	rawReviewMarkdown: string,
	finalization: ReviewRunFinalization,
): Promise<void> {
	const { status, opinion, partialOpinion, error } = finalization;
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
		leadOpinion:
			status === "completed" && opinion
				? "completed-by-current-session"
				: status === "handed_off"
					? "delegated-to-current-session"
					: partialOpinion
						? "partial-not-authoritative"
						: "not-run",
		partialLeadOutput: partialOpinion ? "lead-opinion.partial.md" : undefined,
		error,
	};
	const summary = [
		rawReviewMarkdown,
		opinion ? `\n\n---\n\n${opinion.trim()}\n` : "",
		!opinion && status === "handed_off"
			? `\n\n---\n\n# Lead opinion\n\nDelegated to the current implementation session.\n`
			: "",
		error ? `\n\n---\n\n# Review workflow ${status === "cancelled" ? "cancelled" : "failed"}\n\n${error}\n` : "",
	].join("");

	const writes = [
		writePrivate(join(artifacts.runDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`),
		writePrivate(join(artifacts.runDir, "summary.md"), summary),
	];
	if (opinion) writes.push(writePrivate(join(artifacts.runDir, "lead-opinion.md"), `${opinion.trim()}\n`));
	if (partialOpinion) {
		writes.push(
			writePrivate(
				join(artifacts.runDir, "lead-opinion.partial.md"),
				`# Incomplete lead output — not authoritative\n\n${partialOpinion.trim()}\n`,
			),
		);
	}
	await Promise.all(writes);
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
