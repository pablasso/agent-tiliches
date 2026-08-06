import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { SessionManager, type ExecResult } from "@earendil-works/pi-coding-agent";

const OSASCRIPT = "/usr/bin/osascript";

const FRONT_WINDOW_SCRIPT = [
	'tell application id "com.mitchellh.ghostty"',
	'if (count of windows) is 0 then error "Ghostty has no open windows."',
	"return id of front window",
	"end tell",
];

const NEW_TAB_SCRIPT = [
	"on run argv",
	"set targetWindowId to item 1 of argv",
	"set projectDirectory to item 2 of argv",
	"set startupInput to item 3 of argv",
	'tell application id "com.mitchellh.ghostty"',
	"set matchingWindows to every window whose id is targetWindowId",
	'if (count of matchingWindows) is 0 then error "The originating Ghostty window is no longer open."',
	"set targetWindow to item 1 of matchingWindows",
	"set cfg to new surface configuration",
	"set initial working directory of cfg to projectDirectory",
	"set initial input of cfg to startupInput",
	"set cloneTab to new tab in targetWindow with configuration cfg",
	"select tab cloneTab",
	"return id of cloneTab",
	"end tell",
	"end run",
];

export type ExecCommand = (command: string, args: string[]) => Promise<ExecResult>;

export interface CloneLaunchOptions {
	piExecutable: string;
	cloneFile: string;
	sessionDir: string;
	projectTrusted: boolean;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCloneLaunchCommand(options: CloneLaunchOptions): string {
	const args = [
		options.piExecutable,
		"--session",
		options.cloneFile,
		"--session-dir",
		options.sessionDir,
		options.projectTrusted ? "--approve" : "--no-approve",
	];
	return `${args.map(shellQuote).join(" ")}\n`;
}

export function resolvePiExecutable(pathValue = process.env.PATH): string {
	const override = process.env.PI_CLONE_TAB_PI?.trim();
	if (override) return override;

	for (const directory of (pathValue ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = resolve(directory, "pi");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep looking through PATH.
		}
	}

	// A normal interactive Ghostty shell may still add pi to PATH during shell
	// startup even when it was absent from the environment inherited by Pi.
	return "pi";
}

export function cloneSessionAtLeaf(sourceFile: string, sessionDir: string, leafId: string): string {
	if (!existsSync(sourceFile)) {
		throw new Error("The current session has not been persisted yet.");
	}

	// Use a separate manager: createBranchedSession mutates its manager to point
	// at the clone, so it must never be called on the live session manager.
	const source = SessionManager.open(sourceFile, sessionDir);
	const cloneFile = source.createBranchedSession(leafId);
	if (!cloneFile) throw new Error("Pi did not create a persisted clone session.");
	return cloneFile;
}

export async function getFrontGhosttyWindowId(exec: ExecCommand): Promise<string> {
	const result = await runAppleScript(exec, FRONT_WINDOW_SCRIPT);
	const windowId = result.stdout.trim();
	if (!windowId) throw new Error("Ghostty did not return its front window ID.");
	return windowId;
}

export async function openGhosttyCloneTab(
	exec: ExecCommand,
	options: { windowId: string; cwd: string; startupInput: string },
): Promise<string> {
	const result = await runAppleScript(exec, NEW_TAB_SCRIPT, [options.windowId, options.cwd, options.startupInput]);
	const tabId = result.stdout.trim();
	if (!tabId) throw new Error("Ghostty created no identifiable tab.");
	return tabId;
}

async function runAppleScript(exec: ExecCommand, source: string[], argv: string[] = []): Promise<ExecResult> {
	const args = source.flatMap((line) => ["-e", line]);
	args.push(...argv);
	const result = await exec(OSASCRIPT, args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `osascript exited with code ${result.code}`;
		throw new Error(detail);
	}
	return result;
}
