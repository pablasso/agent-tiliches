import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cloneTabExtension from "../extensions/clone-tab/index.ts";
import { buildCloneLaunchCommand, shellQuote } from "../extensions/clone-tab/core.ts";

const root = await mkdtemp(join(tmpdir(), "clone-tab-smoke-"));
try {
	const cwd = join(root, "project's checkout");
	const sessionDir = join(root, "sessions");
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDir, { recursive: true });

	const sourceFile = join(sessionDir, "source.jsonl");
	const sourceEntries = [
		{
			type: "session",
			version: 3,
			id: "source-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		},
		{
			type: "message",
			id: "11111111",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "root", timestamp: 1 },
		},
		assistantEntry("22222222", "11111111", "root answer", 2),
		{
			type: "message",
			id: "33333333",
			parentId: "22222222",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "user", content: "active branch", timestamp: 3 },
		},
		assistantEntry("44444444", "33333333", "active answer", 4),
		{
			type: "message",
			id: "55555555",
			parentId: "22222222",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: { role: "user", content: "other branch", timestamp: 5 },
		},
	];
	const originalText = `${sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	await writeFile(sourceFile, originalText, "utf8");

	const liveManager = SessionManager.open(sourceFile, sessionDir);
	liveManager.branch("44444444");

	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const notifications: Array<{ message: string; level: string }> = [];

	const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
	const fakePi = {
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, options);
		},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			const source = args.join("\n");
			if (source.includes("return id of front window")) return ok("window-test\n");
			if (source.includes("new tab in targetWindow")) return ok("tab-test\n");
			return { stdout: "", stderr: "unexpected command", code: 1, killed: false } satisfies ExecResult;
		},
	} as unknown as ExtensionAPI;

	const piExecutable = "/Applications/Pi's bin/pi";
	cloneTabExtension(fakePi, { platform: "darwin", termProgram: "ghostty", piExecutable });
	assert.deepEqual([...commands.keys()], ["clone-tab"]);
	assert.deepEqual([...events.keys()], ["session_start", "agent_start", "turn_end", "agent_settled"]);

	let idle = true;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: liveManager,
		isIdle: () => idle,
		isProjectTrusted: () => true,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionCommandContext;

	for (const handler of events.get("session_start") ?? []) handler({}, ctx);
	const command = commands.get("clone-tab");
	assert(command);
	await command.handler("", ctx);

	assert.equal(await readFile(sourceFile, "utf8"), originalText, "the live session file must remain untouched");
	let cloneFiles = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl") && name !== "source.jsonl");
	assert.equal(cloneFiles.length, 1);
	await assertActiveBranchClone(join(sessionDir, cloneFiles[0]), sourceFile);
	assert.equal(execCalls.length, 2);
	assert.equal(execCalls[0].command, "/usr/bin/osascript");
	assert.equal(execCalls[1].command, "/usr/bin/osascript");

	const firstCloneName = cloneFiles[0];
	const firstCloneFile = join(sessionDir, firstCloneName);
	const [windowId, tabCwd, startupInput] = execCalls[1].args.slice(-3);
	assert.equal(windowId, "window-test");
	assert.equal(tabCwd, cwd);
	assert.equal(
		startupInput,
		buildCloneLaunchCommand({
			piExecutable,
			cloneFile: firstCloneFile,
			sessionDir,
			projectTrusted: true,
		}),
	);
	assert(startupInput.endsWith("\n"));
	assert(startupInput.includes(`'"'"'`), "apostrophes must be shell-quoted safely");
	assert.match(notifications.at(-1)?.message ?? "", /Opened independent session clone/);
	assert.equal(notifications.at(-1)?.level, "info");

	// While the original agent is running, clone the last completed leaf rather
	// than the live (possibly incomplete) one.
	liveManager.branch("55555555");
	idle = false;
	await command.handler("", ctx);
	cloneFiles = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl") && name !== "source.jsonl");
	assert.equal(cloneFiles.length, 2);
	const secondClone = cloneFiles.find((name) => name !== firstCloneName);
	assert(secondClone);
	await assertActiveBranchClone(join(sessionDir, secondClone), sourceFile);
	assert.match(notifications.at(-1)?.message ?? "", /last completed turn/);
	assert.match(notifications.at(-1)?.message ?? "", /original agent is still running/);

	assert.equal(shellQuote("plain"), "'plain'");
	assert.equal(shellQuote("it's"), `'it'"'"'s'`);

	console.log("clone-tab smoke ok");
} finally {
	await rm(root, { recursive: true, force: true });
}

function assistantEntry(id: string, parentId: string, text: string, timestamp: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:0${timestamp}.000Z`,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		},
	};
}

async function assertActiveBranchClone(cloneFile: string, sourceFile: string): Promise<void> {
	const lines = (await readFile(cloneFile, "utf8")).trim().split("\n").map(JSON.parse);
	assert.equal(lines[0].type, "session");
	assert.equal(lines[0].parentSession, sourceFile);
	assert.deepEqual(
		lines.slice(1).map((entry) => entry.id),
		["11111111", "22222222", "33333333", "44444444"],
	);
}
