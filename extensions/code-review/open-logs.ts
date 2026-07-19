import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export async function openPath(ctx: ExtensionCommandContext, targetPath: string): Promise<boolean> {
	try {
		await stat(targetPath);
	} catch {
		ctx.ui.notify(`Log path does not exist: ${targetPath}`, "error");
		return false;
	}

	const invocation = getOpenInvocation(targetPath);
	if (!invocation) {
		ctx.ui.notify(`Logs: ${targetPath}`, "info");
		return false;
	}

	return new Promise((resolve) => {
		const child = spawn(invocation.command, invocation.args, {
			stdio: "ignore",
			shell: false,
		});
		let settled = false;
		const finish = (ok: boolean, error?: Error): void => {
			if (settled) return;
			settled = true;
			if (!ok) {
				ctx.ui.notify(`Could not open logs: ${error?.message || "unknown error"}. Path: ${targetPath}`, "error");
			}
			resolve(ok);
		};
		child.once("error", (error) => finish(false, error));
		child.once("close", (code) => finish(code === 0, code === 0 ? undefined : new Error(`${invocation.command} exited with code ${code}`)));
	});
}

function getOpenInvocation(targetPath: string): { command: string; args: string[] } | null {
	switch (process.platform) {
		case "darwin":
			return { command: "open", args: [targetPath] };
		case "win32":
			return { command: "explorer.exe", args: [targetPath] };
		case "linux":
			return { command: "xdg-open", args: [targetPath] };
		default:
			return null;
	}
}
