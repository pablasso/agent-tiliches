import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildCloneLaunchCommand,
	cloneSessionAtLeaf,
	getFrontGhosttyWindowId,
	openGhosttyCloneTab,
	resolvePiExecutable,
} from "./core.ts";

export interface CloneTabRuntime {
	platform?: NodeJS.Platform;
	termProgram?: string;
	piExecutable?: string;
}

export default function cloneTabExtension(pi: ExtensionAPI, runtime: CloneTabRuntime = {}) {
	const platform = runtime.platform ?? process.platform;
	const termProgram = runtime.termProgram ?? process.env.TERM_PROGRAM;
	const piExecutable = runtime.piExecutable ?? resolvePiExecutable();
	let lastCompletedLeafId: string | null = null;
	let cloning = false;

	const rememberLeaf = (ctx: ExtensionContext) => {
		lastCompletedLeafId = ctx.sessionManager.getLeafId();
	};

	pi.on("session_start", (_event, ctx) => rememberLeaf(ctx));
	// agent_start fires before the new run's user message is persisted, so this
	// captures the latest safe pre-run checkpoint (including model/tool changes
	// or user bash entries made since the previous settled turn).
	pi.on("agent_start", (_event, ctx) => rememberLeaf(ctx));
	pi.on("turn_end", (_event, ctx) => rememberLeaf(ctx));
	pi.on("agent_settled", (_event, ctx) => rememberLeaf(ctx));

	pi.registerCommand("clone-tab", {
		description: "Clone the active conversation into an independent Pi session in a new Ghostty tab",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /clone-tab", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/clone-tab requires interactive TUI mode.", "error");
				return;
			}
			if (platform !== "darwin" || termProgram?.toLowerCase() !== "ghostty") {
				ctx.ui.notify("/clone-tab requires Ghostty on macOS.", "error");
				return;
			}
			if (cloning) {
				ctx.ui.notify("A session clone is already being opened.", "warning");
				return;
			}

			const sourceFile = ctx.sessionManager.getSessionFile();
			if (!sourceFile) {
				ctx.ui.notify("The current session is ephemeral and cannot be cloned.", "error");
				return;
			}

			const idleAtInvocation = ctx.isIdle();
			const liveLeafId = ctx.sessionManager.getLeafId();
			const cloneLeafId = idleAtInvocation ? liveLeafId : lastCompletedLeafId;
			if (!cloneLeafId) {
				ctx.ui.notify(
					idleAtInvocation
						? "The current session has no conversation to clone yet."
						: "No completed turn is available to clone yet. Retry after the current turn finishes.",
					"error",
				);
				return;
			}

			cloning = true;
			let cloneFile: string | undefined;
			try {
				// Capture the window while the command's originating tab is still frontmost.
				const exec = (command: string, commandArgs: string[]) => pi.exec(command, commandArgs);
				const windowId = await getFrontGhosttyWindowId(exec);
				const sessionDir = ctx.sessionManager.getSessionDir();
				cloneFile = cloneSessionAtLeaf(sourceFile, sessionDir, cloneLeafId);
				const startupInput = buildCloneLaunchCommand({
					piExecutable,
					cloneFile,
					sessionDir,
					projectTrusted: ctx.isProjectTrusted(),
				});

				await openGhosttyCloneTab(exec, { windowId, cwd: ctx.cwd, startupInput });
				const snapshotNote = idleAtInvocation
					? ""
					: " The clone includes conversation through the last completed turn; the original agent is still running.";
				ctx.ui.notify(`Opened independent session clone in a new Ghostty tab.${snapshotNote}`, "info");
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				const retained = cloneFile ? ` The cloned session remains available at ${cloneFile}.` : "";
				ctx.ui.notify(`Could not open clone tab: ${detail}${retained}`, "error");
			} finally {
				cloning = false;
			}
		},
	});
}
