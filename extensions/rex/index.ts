import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	REX_SECTION,
	loadRexContext,
	resolveRexExecutable,
	shouldLoadRexContext,
	type ExecCommand,
	type RexEnv,
} from "./core.ts";

export interface RexRuntime {
	env?: RexEnv;
	exec?: ExecCommand;
	exists?: (path: string) => boolean;
}

/**
 * Gives Pi the startup context that Rex's SessionStart hook gives Claude Code and Codex: which Rex
 * session and pane it runs in, and, when `rex skill setup --session-naming` is installed, the
 * instruction to name the session after its task.
 *
 * The text comes from the installed Rex each session, so upgrading Rex updates it. It goes into a
 * system prompt section rather than a transcript message, so it survives compaction and follows
 * the pane when a session is resumed somewhere else.
 */
export default function rexExtension(pi: ExtensionAPI, runtime: RexRuntime = {}) {
	const env = runtime.env ?? process.env;
	const exec: ExecCommand = runtime.exec ?? ((command, args, options) => pi.exec(command, args, options));
	let pending: Promise<string | undefined> = Promise.resolve(undefined);

	pi.on("session_start", (_event, ctx) => {
		// Start loading without delaying startup; the first run awaits the result.
		pending = shouldLoadRexContext(ctx.mode, env)
			? loadRexContext(exec, resolveRexExecutable(env, runtime.exists))
			: Promise.resolve(undefined);
	});

	pi.on("before_agent_start", async (event) => {
		const context = await pending;
		const sections = event.systemPromptOptions.sections;
		if (context) sections[REX_SECTION] = context;
		else delete sections[REX_SECTION];
	});
}
