import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseGitDiff } from "./diff.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { openReviewUrl, startReviewServer, type ReviewServer } from "./server.ts";

const STATUS_ID = "diff-review";
const DEFAULT_CONTEXT_LINES = 80;

interface DiffCommandPlan {
	gitArgs: string[];
	gitCommand: string;
	pathspecs: string[];
	includeUntracked: boolean;
}

export default function (pi: ExtensionAPI) {
	const activeServers = new Set<ReviewServer>();

	pi.registerCommand("diff", {
		description: "Open a local diff review UI and prefill a Pi prompt from line comments",
		handler: async (args, ctx) => {
			const commandArgs = args ?? "";
			if (!ctx.hasUI) {
				throw new Error("/diff requires an interactive Pi UI so the generated review prompt can be prefilled.");
			}

			const trimmedArgs = commandArgs.trim();
			if (trimmedArgs === "--help" || trimmedArgs === "-h" || trimmedArgs === "help") {
				ctx.ui.setEditorText(usageText());
				return;
			}

			let server: ReviewServer | undefined;
			try {
				ctx.ui.setStatus(STATUS_ID, "waiting for idle...");
				await ctx.waitForIdle();

				const plan = createDiffCommandPlan(trimmedArgs);
				ctx.ui.setStatus(STATUS_ID, plan.includeUntracked ? "collecting git diff + untracked files..." : "collecting git diff...");
				const rawDiff = await collectDiff(pi, plan);

				if (!rawDiff.trim()) {
					ctx.ui.notify("No git diff or untracked files found for the selected scope.", "info");
					return;
				}

				const diff = parseGitDiff(rawDiff);
				if (diff.files.length === 0) {
					ctx.ui.notify("git diff produced output, but no files could be parsed.", "warning");
					return;
				}

				server = await startReviewServer(diff, {
					cwd: ctx.cwd,
					gitCommand: plan.gitCommand,
				});
				activeServers.add(server);

				const openedWith = openReviewUrl(server.url);
				ctx.ui.setStatus(STATUS_ID, `reviewing ${diff.stats.files} file${diff.stats.files === 1 ? "" : "s"}...`);
				ctx.ui.notify(`Opened diff review in ${openedWith}. If it did not open, visit: ${server.url}`, "info");

				const result = await server.result;
				activeServers.delete(server);

				if (result.type === "cancel") {
					ctx.ui.notify("Diff review cancelled.", "info");
					return;
				}

				if (result.type === "timeout") {
					ctx.ui.notify("Diff review timed out; no prompt was generated.", "warning");
					return;
				}

				if (result.type === "closed") {
					ctx.ui.notify("Diff review server closed; no prompt was generated.", "warning");
					return;
				}

				if (result.comments.length === 0) {
					ctx.ui.notify("No review comments submitted; no prompt was generated.", "info");
					return;
				}

				const prompt = buildReviewPrompt(diff, result.comments, {
					cwd: ctx.cwd,
					gitCommand: plan.gitCommand,
				});

				if (!prompt) {
					ctx.ui.notify("Submitted comments did not match the current diff; no prompt was generated.", "warning");
					return;
				}

				ctx.ui.setEditorText(prompt);
				ctx.ui.notify(`Prepared review prompt from ${result.comments.length} comment${result.comments.length === 1 ? "" : "s"}. Press Enter to send it.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/diff failed: ${message}`, "error");
			} finally {
				ctx.ui.setStatus(STATUS_ID, undefined);
				if (server) {
					activeServers.delete(server);
					await server.close().catch(() => undefined);
				}
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await Promise.all(Array.from(activeServers, (server) => server.abort("session shutdown").catch(() => undefined)));
		activeServers.clear();
	});
}

function createDiffCommandPlan(args: string): DiffCommandPlan {
	const tokens = splitArgs(args);
	const pathspecs: string[] = [];
	let staged = false;
	let all = false;
	let untracked: boolean | undefined;
	let contextLines = DEFAULT_CONTEXT_LINES;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];

		if (token === "--") {
			pathspecs.push(...tokens.slice(index + 1));
			break;
		}

		if (token === "--staged" || token === "--cached") {
			staged = true;
			continue;
		}

		if (token === "--all" || token === "--head") {
			all = true;
			continue;
		}

		if (token === "--untracked") {
			untracked = true;
			continue;
		}

		if (token === "--no-untracked") {
			untracked = false;
			continue;
		}

		if (token === "--unified" || token === "-U") {
			const value = tokens[++index];
			contextLines = parseContextLines(value);
			continue;
		}

		if (token.startsWith("--unified=")) {
			contextLines = parseContextLines(token.slice("--unified=".length));
			continue;
		}

		const shortContext = token.match(/^-U(\d+)$/);
		if (shortContext) {
			contextLines = parseContextLines(shortContext[1]);
			continue;
		}

		if (token.startsWith("-")) {
			throw new Error(`Unsupported /diff option: ${token}. Use /diff --help for usage.`);
		}

		pathspecs.push(token);
	}

	if (staged && all) throw new Error("Use either --staged or --all, not both.");
	if (staged && untracked === true) throw new Error("Untracked files cannot be included with --staged; omit --staged or use --all.");

	const includeUntracked = !staged && untracked !== false;

	const gitArgs = [
		"diff",
		"--no-ext-diff",
		"--no-color",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		`--unified=${contextLines}`,
	];

	if (all) gitArgs.push("HEAD");
	else if (staged) gitArgs.push("--cached");
	if (pathspecs.length > 0) gitArgs.push("--", ...pathspecs);

	const trackedCommand = ["git", ...gitArgs].map(shellQuote).join(" ");

	return {
		gitArgs,
		gitCommand: includeUntracked ? `${trackedCommand} + untracked files` : trackedCommand,
		pathspecs,
		includeUntracked,
	};
}

async function collectDiff(pi: ExtensionAPI, plan: DiffCommandPlan): Promise<string> {
	const chunks: string[] = [];

	const tracked = await pi.exec("git", plan.gitArgs, { timeout: 60_000 });
	if (tracked.code !== 0) {
		throw new Error(commandFailureMessage(tracked.stderr, tracked.stdout, "git diff failed"));
	}
	if (tracked.stdout.trim()) chunks.push(tracked.stdout);

	if (plan.includeUntracked) {
		const untrackedPaths = await listUntrackedPaths(pi, plan.pathspecs);
		if (untrackedPaths.length > 0) {
			const worktreeRoot = await getGitWorktreeRoot(pi);
			for (const path of untrackedPaths) {
				const untrackedDiff = await diffUntrackedPath(pi, path, worktreeRoot);
				if (untrackedDiff.trim()) chunks.push(untrackedDiff);
			}
		}
	}

	return joinDiffChunks(chunks);
}

async function listUntrackedPaths(pi: ExtensionAPI, pathspecs: string[]): Promise<string[]> {
	const args = ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"];
	if (pathspecs.length > 0) args.push("--", ...pathspecs);

	const result = await pi.exec("git", args, { timeout: 60_000 });
	if (result.code !== 0) {
		throw new Error(commandFailureMessage(result.stderr, result.stdout, "git ls-files failed"));
	}

	return result.stdout.split("\0").filter(Boolean);
}

async function getGitWorktreeRoot(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 60_000 });
	if (result.code !== 0) {
		throw new Error(commandFailureMessage(result.stderr, result.stdout, "git rev-parse failed"));
	}

	const root = result.stdout.replace(/\r?\n$/, "");
	if (!root) throw new Error("git rev-parse did not return a worktree root.");
	return root;
}

async function diffUntrackedPath(pi: ExtensionAPI, path: string, worktreeRoot: string): Promise<string> {
	const result = await pi.exec(
		"git",
		[
			"diff",
			"--no-ext-diff",
			"--no-color",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--no-index",
			"--",
			"/dev/null",
			resolve(worktreeRoot, path),
		],
		{ timeout: 60_000 },
	);

	// `git diff --no-index` exits with 1 when differences are found, which is
	// the expected result for an untracked file compared against /dev/null.
	if (result.code !== 0 && result.code !== 1) {
		throw new Error(commandFailureMessage(result.stderr, result.stdout, `git diff --no-index failed for ${path}`));
	}

	return normalizeUntrackedDiff(result.stdout, path);
}

function normalizeUntrackedDiff(raw: string, path: string): string {
	if (!raw.trim()) return raw;

	let beforeHunk = true;
	let normalizedNewHeader = false;

	return raw
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => {
			if (line.startsWith("@@ ")) beforeHunk = false;
			if (line.startsWith("diff --git ")) {
				return `diff --git ${quoteGitDiffPath(`a/${path}`)} ${quoteGitDiffPath(`b/${path}`)}`;
			}
			if (beforeHunk && !normalizedNewHeader && line.startsWith("+++ ")) {
				normalizedNewHeader = true;
				return `+++ ${quoteGitDiffPath(`b/${path}`)}`;
			}
			if (beforeHunk && line.startsWith("Binary files /dev/null and ")) {
				return `Binary files /dev/null and ${quoteGitDiffPath(`b/${path}`)} differ`;
			}
			return line;
		})
		.join("\n");
}

function quoteGitDiffPath(path: string): string {
	return `"${path
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\t/g, "\\t")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")}"`;
}

function joinDiffChunks(chunks: string[]): string {
	return chunks
		.map((chunk) => chunk.trimEnd())
		.filter(Boolean)
		.join("\n");
}

function commandFailureMessage(stderr: string | undefined, stdout: string | undefined, fallback: string): string {
	return (stderr || stdout || fallback).trim();
}

function parseContextLines(value: string | undefined): number {
	if (!value) throw new Error("Missing value for --unified.");
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 500) {
		throw new Error("--unified must be an integer between 0 and 500.");
	}
	return parsed;
}

function splitArgs(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;

	for (const char of value) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) current += "\\";
	if (quote) throw new Error("Unclosed quote in /diff arguments.");
	if (current) tokens.push(current);
	return tokens;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function usageText(): string {
	return `# /diff usage

Open a local browser diff-review UI, add line comments, then submit to prefill Pi's editor with a compact review prompt.

\`/diff [--staged|--cached|--all] [--no-untracked] [--unified N] [--] [path ...]\`

- Default: review unstaged tracked changes plus untracked files.
- \`--staged\` / \`--cached\`: review staged changes only.
- \`--all\` / \`--head\`: review staged + unstaged tracked changes plus untracked files.
- \`--no-untracked\`: exclude untracked files.
- \`--unified N\`: amount of context fetched for the browser UI (default ${DEFAULT_CONTEXT_LINES}).
- Use \`--\` before paths that start with \`-\`.

The server binds to \`127.0.0.1\`, uses a random token in the URL and POST requests, and closes after submit/cancel/timeout.`;
}
