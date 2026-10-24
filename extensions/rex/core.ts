import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecOptions, ExecResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Prompt section name. Pi renders it as `<rex>...</rex>` in the system prompt. */
export const REX_SECTION = "rex";

/** The same command Rex's SessionStart hook runs for Claude Code and Codex. */
export const REX_SESSION_START_ARGS = ["__internal", "session-start", "--agent", "pi"];

/** Reports the naming choice `rex skill setup` installed for each agent. */
export const REX_SKILL_STATUS_ARGS = ["skill", "status", "--json"];

/** Rex's own hook gives up after five seconds; match it. */
export const REX_SESSION_START_TIMEOUT_MS = 5000;

/**
 * Replaces Rex's session-naming instruction. Several agents can share one Rex session, and the
 * user names it, so each agent names only the tab that holds its pane. The first paragraph mirrors
 * Rex's wording; the second overrides the session-naming section of the rex skill.
 */
export const TAB_NAMING_PARAGRAPHS = [
	`Name your tab as part of handling the first request that identifies the work,
without waiting for the user to ask and before loading the skill. Your tab is the
Rex window that holds your pane: read its ID from \`.block.window_id\` in
\`rex block inspect -s "$REX_SESSION" "$REX_BLOCK" --json\`, then run
\`rex window rename -s "$REX_SESSION" <window-id> <label>\`. Use two to four
lowercase words joined by hyphens, such as \`fix-login-redirect\`. Name the task or
project. Keep the existing label if it already describes the same work.`,
	`Leave the session's name alone: the user and other agents share it. Don't run
\`rex session rename\` unless the user asks. Where the rex skill says to name the
session, apply its guidance to your tab instead.`,
];

export type RexEnv = Record<string, string | undefined>;

export type ExtensionMode = ExtensionContext["mode"];

export type ExecCommand = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/**
 * Rex context applies only to an interactive Pi running in a Rex terminal.
 *
 * Non-interactive Pi (print, JSON, RPC), such as background subagents, inherits the parent's
 * REX_SESSION. Skipping it keeps those runs from acting on, or renaming, the user's Rex session.
 */
export function shouldLoadRexContext(mode: ExtensionMode, env: RexEnv): boolean {
	if (mode !== "tui") return false;
	if (!env.REX_SESSION?.trim()) return false;
	return !/^(0|false|no|off)$/i.test(env.PI_REX_CONTEXT?.trim() ?? "");
}

/**
 * Prefer the `rex` beside the server that opened this terminal. A shell startup file can reorder
 * PATH and pick up a different copy, which the Rex CLI docs call out.
 */
export function resolveRexExecutable(env: RexEnv, exists: (path: string) => boolean = existsSync): string {
	const binDir = env.REX_BIN_DIR?.trim();
	if (binDir) {
		const candidate = join(binDir, "rex");
		if (exists(candidate)) return candidate;
	}
	return "rex";
}

/** Session-start arguments for one naming choice, passed explicitly so Rex's default can't drift. */
export function sessionStartArgs(sessionNaming: boolean): string[] {
	return [...REX_SESSION_START_ARGS, `--feature-session-naming=${sessionNaming}`];
}

/**
 * Reads Pi's installed naming choice from `rex skill status --json`. Rex omits `session_naming`
 * when it is false. Returns undefined when the output doesn't describe Pi.
 */
export function parseSessionNaming(stdout: string | undefined): boolean | undefined {
	if (!stdout) return undefined;
	try {
		const harnesses: unknown = JSON.parse(stdout)?.harnesses;
		if (!Array.isArray(harnesses)) return undefined;
		const pi = harnesses.find((harness) => harness?.id === "pi");
		return pi ? pi.session_naming === true : undefined;
	} catch {
		return undefined;
	}
}

function paragraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
}

/**
 * Swaps Rex's session-naming text for tab naming. The paragraphs that appear only when naming is
 * on are Rex's naming instruction, found without matching its wording. Paragraphs that appear only
 * when naming is off, such as the "setup is out of date" note that the mismatched flag causes, are
 * dropped. When the two outputs match, this Rex gives no naming instruction and nothing is added.
 */
export function nameTabNotSession(withNaming: string, withoutNaming: string): string {
	const shared = new Set(paragraphs(withoutNaming));
	const result: string[] = [];
	let replaced = false;
	for (const paragraph of paragraphs(withNaming)) {
		if (shared.has(paragraph)) result.push(paragraph);
		else if (!replaced) {
			result.push(...TAB_NAMING_PARAGRAPHS);
			replaced = true;
		}
	}
	return result.join("\n\n");
}

/** Runs one rex command. Returns undefined when Rex is missing, fails, or prints nothing. */
async function runRex(exec: ExecCommand, executable: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await exec(executable, args, { timeout: REX_SESSION_START_TIMEOUT_MS });
		if (result.killed || result.code !== 0) return undefined;
		const text = result.stdout.trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Builds the startup context from Rex's session-start hook. When `rex skill setup` turned naming
 * on, or Rex can't say, the session-naming instruction becomes tab naming. When naming is off, the
 * hook's output is used as is. The three commands run together so startup waits for one timeout.
 */
export async function loadRexContext(exec: ExecCommand, executable: string): Promise<string | undefined> {
	const [status, withNaming, withoutNaming] = await Promise.all([
		runRex(exec, executable, REX_SKILL_STATUS_ARGS),
		runRex(exec, executable, sessionStartArgs(true)),
		runRex(exec, executable, sessionStartArgs(false)),
	]);
	if (parseSessionNaming(status) === false) return withoutNaming;
	// Without both outputs the session-naming text can't be told apart, so give no context.
	if (!withNaming || !withoutNaming) return undefined;
	return nameTabNotSession(withNaming, withoutNaming);
}
