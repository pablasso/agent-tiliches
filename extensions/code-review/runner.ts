import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, join } from "node:path";
import type { CodeReviewConfig } from "./config.ts";
import type { Reviewer, ReviewerResult, ReviewSnapshot } from "./core.ts";
import { buildAdjudicationPrompt, buildReviewerSystemPrompt, buildReviewerTask } from "./core.ts";
import {
	createReviewerLogPaths,
	getLeadLogPaths,
	type ModelLogPaths,
	type ReviewRunArtifacts,
	writePrivate,
} from "./artifacts.ts";

const REVIEW_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_STDERR_BYTES = 200 * 1_024;
const MAX_MODEL_OUTPUT_BYTES = 128 * 1_024;
const ACTIVE_CHILDREN = new Set<ChildProcess>();

export type ReviewProgressState = "pending" | "in_progress" | "finished" | "failed" | "cancelled";

export interface ReviewProgressUpdate {
	id: string;
	label: string;
	state: ReviewProgressState;
	startedAt?: number;
	finishedAt?: number;
	detail?: string;
	logDir: string;
}

export type ReviewProgressCallback = (update: ReviewProgressUpdate) => void;

export function abortActiveReviewProcesses(): void {
	for (const child of ACTIVE_CHILDREN) terminateChild(child);
}

interface PiJsonMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
}

interface PiJsonEvent {
	type?: string;
	message?: PiJsonMessage;
}

interface ModelRunConfig {
	label: string;
	provider: string;
	model: string;
	thinking: string;
}

interface ModelRunResult {
	ok: boolean;
	output: string;
	error?: string;
	stopReason?: string;
	durationMs: number;
}

export async function runReviewersInParallel(
	reviewers: readonly Reviewer[],
	snapshot: ReviewSnapshot,
	focus: string,
	artifacts: ReviewRunArtifacts,
	config: Pick<CodeReviewConfig, "extensions">,
	onProgress?: ReviewProgressCallback,
	signal?: AbortSignal,
): Promise<ReviewerResult[]> {
	const systemPromptPath = join(artifacts.promptsDir, "reviewer-system.md");
	const taskPath = join(artifacts.promptsDir, "review-task.md");
	await Promise.all([
		writePrivate(systemPromptPath, buildReviewerSystemPrompt()),
		writePrivate(taskPath, buildReviewerTask(snapshot, focus)),
	]);

	return Promise.all(
		reviewers.map(async (reviewer, index): Promise<ReviewerResult> => {
			const id = `reviewer-${index}`;
			let logs: ModelLogPaths;
			try {
				logs = await createReviewerLogPaths(artifacts, index, reviewer);
			} catch (error) {
				const message = `Could not create logs for ${reviewer.name}: ${error instanceof Error ? error.message : String(error)}`;
				onProgress?.({
					id,
					label: reviewer.name,
					state: signal?.aborted ? "cancelled" : "failed",
					finishedAt: Date.now(),
					detail: message,
					logDir: artifacts.reviewersDir,
				});
				return { reviewer, ok: false, output: "", error: message, durationMs: 0, logDir: artifacts.reviewersDir };
			}
			onProgress?.({ id, label: reviewer.name, state: "pending", logDir: logs.directory });
			const startedAt = Date.now();
			onProgress?.({ id, label: reviewer.name, state: "in_progress", startedAt, logDir: logs.directory });

			let run: ModelRunResult;
			try {
				run = await runModel(
					{
						label: reviewer.name,
						provider: reviewer.provider,
						model: reviewer.model,
						thinking: reviewer.thinking,
					},
					snapshot.repoRoot,
					systemPromptPath,
					taskPath,
					logs,
					config.extensions,
					signal,
				);
			} catch (error) {
				run = {
					ok: false,
					output: "",
					error: `${reviewer.name} could not start: ${error instanceof Error ? error.message : String(error)}`,
					durationMs: Date.now() - startedAt,
				};
				await writePrivate(logs.result, `# ${reviewer.name} failed\n\n${run.error}\n`).catch(() => {});
			}
			const state: ReviewProgressState = signal?.aborted ? "cancelled" : run.ok ? "finished" : "failed";
			onProgress?.({
				id,
				label: reviewer.name,
				state,
				startedAt,
				finishedAt: Date.now(),
				detail: run.ok ? undefined : run.error,
				logDir: logs.directory,
			});
			return { reviewer, ...run, logDir: logs.directory };
		}),
	);
}

export async function runAdjudicator(
	model: { provider: string; id: string },
	thinking: string,
	snapshot: ReviewSnapshot,
	results: ReviewerResult[],
	focus: string,
	artifacts: ReviewRunArtifacts,
	config: Pick<CodeReviewConfig, "extensions">,
	onProgress?: ReviewProgressCallback,
	signal?: AbortSignal,
): Promise<string> {
	const systemPromptPath = join(artifacts.promptsDir, "lead-system.md");
	const taskPath = join(artifacts.promptsDir, "lead-task.md");
	const logs = getLeadLogPaths(artifacts);
	const id = "lead-opinion";
	const label = "Lead opinion";
	const startedAt = Date.now();
	onProgress?.({ id, label, state: "in_progress", startedAt, logDir: logs.directory });
	let run: ModelRunResult;
	try {
		await Promise.all([
			writePrivate(
				systemPromptPath,
				[
					"You are the lead engineer responsible for a proportionate final code-review decision.",
					"Be skeptical of reviewer claims and independently verify them with read-only repository tools.",
					"Do not edit files, run shell commands, or implement fixes.",
				].join("\n"),
			),
			writePrivate(taskPath, buildAdjudicationPrompt(snapshot, results, focus)),
		]);
		run = await runModel(
			{ label: "Lead opinion", provider: model.provider, model: model.id, thinking },
			snapshot.repoRoot,
			systemPromptPath,
			taskPath,
			logs,
			config.extensions,
			signal,
		);
	} catch (error) {
		run = {
			ok: false,
			output: "",
			error: `Lead opinion could not start: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startedAt,
		};
	}
	const state: ReviewProgressState = signal?.aborted ? "cancelled" : run.ok ? "finished" : "failed";
	onProgress?.({
		id,
		label,
		state,
		startedAt,
		finishedAt: Date.now(),
		detail: run.ok ? undefined : run.error,
		logDir: logs.directory,
	});
	if (!run.ok) throw new Error(run.error || "Lead opinion produced no usable output.");
	return run.output;
}

async function runModel(
	config: ModelRunConfig,
	cwd: string,
	systemPromptPath: string,
	taskPath: string,
	logs: ModelLogPaths,
	extensions: readonly string[],
	signal?: AbortSignal,
): Promise<ModelRunResult> {
	const startedAt = Date.now();
	const providerArgs = extensions.flatMap((extension) => ["--extension", extension]);
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-extensions",
		...providerArgs,
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
		"--tools",
		"read,grep,find,ls",
		"--model",
		`${config.provider}/${config.model}`,
		"--thinking",
		config.thinking,
		"--system-prompt",
		systemPromptPath,
		`@${taskPath}`,
	];
	const invocation = getPiInvocation(args);
	try {
		await writePrivate(
			logs.invocation,
			`${JSON.stringify(
				{
					cwd,
					command: invocation.command,
					args: invocation.args,
					model: `${config.provider}/${config.model}`,
					thinking: config.thinking,
					startedAt: new Date(startedAt).toISOString(),
				},
				null,
				2,
			)}\n`,
		);
	} catch (error) {
		return {
			ok: false,
			output: "",
			error: `Could not initialize logs for ${config.label}: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startedAt,
		};
	}

	return new Promise((resolve) => {
		let settled = false;
		let stdoutBuffer = "";
		let stderr = "";
		let finalText = "";
		let stopReason: string | undefined;
		let modelError: string | undefined;
		let aborted = false;
		let timedOut = false;
		let eventsStream: WriteStream | undefined;
		let stderrStream: WriteStream | undefined;
		let loggingError: Error | undefined;

		try {
			eventsStream = createWriteStream(logs.events, { flags: "a", mode: 0o600 });
			stderrStream = createWriteStream(logs.stderr, { flags: "a", mode: 0o600 });
			eventsStream.on("error", (error) => {
				loggingError ??= error;
			});
			stderrStream.on("error", (error) => {
				loggingError ??= error;
			});
		} catch (error) {
			resolve({
				ok: false,
				output: "",
				error: `Could not create logs for ${config.label}: ${error instanceof Error ? error.message : String(error)}`,
				durationMs: Date.now() - startedAt,
			});
			return;
		}

		const child = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CODE_REVIEW_CHILD: "1" },
		});
		ACTIVE_CHILDREN.add(child);

		const terminate = (): void => terminateChild(child);
		const onAbort = (): void => {
			aborted = true;
			terminate();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, REVIEW_TIMEOUT_MS);
		timeout.unref?.();

		const processLine = (line: string): void => {
			if (!line.trim()) return;
			let event: PiJsonEvent;
			try {
				event = JSON.parse(line) as PiJsonEvent;
			} catch {
				return;
			}
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			const text = extractText(event.message);
			if (text) {
				const bytes = Buffer.byteLength(text, "utf8");
				finalText =
					bytes <= MAX_MODEL_OUTPUT_BYTES
						? text
						: `${truncateUtf8(text, MAX_MODEL_OUTPUT_BYTES)}\n\n[Output truncated at ${MAX_MODEL_OUTPUT_BYTES} bytes.]`;
			}
			stopReason = event.message.stopReason ?? stopReason;
			modelError = event.message.errorMessage ?? modelError;
		};

		child.stdout.on("data", (chunk: Buffer) => {
			eventsStream?.write(chunk);
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderrStream?.write(chunk);
			if (Buffer.byteLength(stderr, "utf8") >= MAX_STDERR_BYTES) return;
			stderr += chunk.toString("utf8");
		});

		const finish = async (exitCode: number | null, spawnError?: Error): Promise<void> => {
			if (settled) return;
			settled = true;
			ACTIVE_CHILDREN.delete(child);
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			await Promise.all([closeStream(eventsStream), closeStream(stderrStream)]);

			const failed =
				exitCode !== 0 ||
				(stopReason !== undefined && stopReason !== "stop") ||
				Boolean(spawnError) ||
				Boolean(loggingError) ||
				aborted ||
				timedOut;
			const error = aborted
				? `${config.label} cancelled.`
				: timedOut
					? `${config.label} timed out after ${Math.round(REVIEW_TIMEOUT_MS / 60_000)} minutes.`
					: spawnError?.message ||
						(loggingError ? `Could not persist complete ${config.label} logs: ${loggingError.message}` : undefined) ||
						modelError ||
						stderr.trim() ||
						(stopReason && stopReason !== "stop" ? `${config.label} stopped with ${stopReason}.` : undefined) ||
						(exitCode !== 0 ? `${config.label} exited with code ${exitCode}.` : undefined);
			let result: ModelRunResult = {
				ok: !failed && finalText.trim().length > 0,
				output: finalText,
				error: !failed && !finalText.trim() ? `${config.label} produced no final text.` : error,
				stopReason,
				durationMs: Date.now() - startedAt,
			};
			try {
				await Promise.all([
					writePrivate(logs.result, result.output || `# ${config.label} failed\n\n${result.error || "Unknown error."}\n`),
					writePrivate(
						join(logs.directory, "outcome.json"),
						`${JSON.stringify(
							{
								ok: result.ok,
								stopReason: result.stopReason,
								durationMs: result.durationMs,
								error: result.error,
								finishedAt: new Date().toISOString(),
							},
							null,
							2,
						)}\n`,
					),
				]);
			} catch (persistError) {
				result = {
					...result,
					ok: false,
					error: `Could not persist complete ${config.label} artifacts: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
				};
			}
			resolve(result);
		};

		child.once("error", (error) => void finish(1, error));
		child.once("close", (code) => void finish(code));
	});
}

function extractText(message: PiJsonMessage): string {
	return (message.content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
	let truncated = value.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return truncated;
}

function terminateChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.killed) return;
	child.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	}, 5_000);
	forceKill.unref?.();
}

function closeStream(stream: WriteStream | undefined): Promise<void> {
	if (!stream || stream.closed || stream.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		stream.once("error", () => resolve());
		stream.end(resolve);
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}
