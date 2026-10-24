import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecOptions, ExecResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Prompt section name. Pi renders it as `<rex>...</rex>` in the system prompt. */
export const REX_SECTION = "rex";

/** The same command Rex's SessionStart hook runs for Claude Code and Codex. */
export const REX_SESSION_START_ARGS = ["__internal", "session-start", "--agent", "pi"];

/** Rex's own hook gives up after five seconds; match it. */
export const REX_SESSION_START_TIMEOUT_MS = 5000;

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

/** Run Rex's session-start hook. Returns undefined when Rex is missing, fails, or prints nothing. */
export async function loadRexContext(exec: ExecCommand, executable: string): Promise<string | undefined> {
	try {
		const result = await exec(executable, REX_SESSION_START_ARGS, { timeout: REX_SESSION_START_TIMEOUT_MS });
		if (result.killed || result.code !== 0) return undefined;
		const text = result.stdout.trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}
