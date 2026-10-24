import { strict as assert } from "node:assert";
import type { ExecOptions, ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rexExtension from "../extensions/rex/index.ts";
import {
	REX_SECTION,
	REX_SESSION_START_ARGS,
	REX_SESSION_START_TIMEOUT_MS,
	REX_SKILL_STATUS_ARGS,
	TAB_NAMING_PARAGRAPHS,
	nameTabNotSession,
	parseSessionNaming,
	resolveRexExecutable,
	sessionStartArgs,
	shouldLoadRexContext,
} from "../extensions/rex/core.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Reply = ExecResult | Error;
type Replies = { status?: Reply; withNaming?: Reply; withoutNaming?: Reply };

const BIN_DIR = "/Applications/Rex Server.app/Contents/MacOS";
const REX = `${BIN_DIR}/rex`;

// Rex's session-start output, copied from Rex 0.0.1792787366 with the paragraphs the flag changes.
const BASE = `You're running in a Rex terminal.

\`\`\`text
REX_SERVER=unix:///tmp/rex.sock
REX_SESSION=session:test
REX_BLOCK=block:test
\`\`\`

\`REX_SESSION\` identifies your session, and \`REX_BLOCK\` identifies your terminal
pane. Both variables are set in your shell.

The rex skill (/skill:rex) provides instructions and
examples for Rex tasks.`;
const SESSION_NAMING = `Name the session as part of handling the first request that identifies the work.
Run \`rex session rename "$REX_SESSION" <label>\` without waiting for the user to
ask and before loading the skill. Use two to four lowercase words joined by
hyphens, such as \`fix-login-redirect\`. Name the task or project. Keep the existing
label if it already describes the same work.`;
const OUT_OF_DATE = `The Rex setup for this agent is out of date. Suggest running \`rex skill setup\`
to update it.`;
const TAB_CONTEXT = [BASE, ...TAB_NAMING_PARAGRAPHS].join("\n\n");

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const status = (pi?: Record<string, unknown>) =>
	ok(JSON.stringify({ scope: "user", harnesses: [{ id: "codex", session_naming: true }, ...(pi ? [{ id: "pi", ...pi }] : [])] }));
const namingOn: Replies = {
	status: status({ detected: true, session_naming: true }),
	withNaming: ok(`${BASE}\n\n${SESSION_NAMING}\n`),
	withoutNaming: ok(`${BASE}\n\n${OUT_OF_DATE}\n`),
};
// Rex omits session_naming when it is false, and the mismatched flag adds the note.
const namingOff: Replies = {
	status: status({ detected: true }),
	withNaming: ok(`${BASE}\n\n${SESSION_NAMING}\n\n${OUT_OF_DATE}\n`),
	withoutNaming: ok(`${BASE}\n`),
};

function harness(options: { env: Record<string, string | undefined>; replies: Replies[] }) {
	const handlers = new Map<string, Handler[]>();
	const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
	const loads = [...options.replies];
	let replies: Replies | undefined;
	const fakePi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	rexExtension(fakePi, {
		env: options.env,
		exists: (path) => path === REX,
		async exec(command, args, execOptions) {
			calls.push({ command, args, options: execOptions });
			const key = args.join(" ");
			const reply =
				key === REX_SKILL_STATUS_ARGS.join(" ")
					? replies?.status
					: key === sessionStartArgs(true).join(" ")
						? replies?.withNaming
						: key === sessionStartArgs(false).join(" ")
							? replies?.withoutNaming
							: undefined;
			if (!reply) throw new Error(`unexpected exec: ${key}`);
			if (reply instanceof Error) throw reply;
			return reply;
		},
	});

	return {
		calls,
		events: [...handlers.keys()],
		async start(mode: ExtensionContext["mode"] = "tui") {
			if (mode === "tui") replies = loads.shift();
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ type: "session_start" }, { mode } as ExtensionContext);
			}
		},
		async run(sections: Record<string, string> = {}) {
			const event = { type: "before_agent_start", systemPromptOptions: { sections } };
			for (const handler of handlers.get("before_agent_start") ?? []) {
				await handler(event, {} as ExtensionContext);
			}
			return sections;
		},
	};
}

const rexEnv = { REX_SESSION: "session:test", REX_BIN_DIR: BIN_DIR };

// Naming on: Rex's session-naming paragraph becomes tab naming, and the flag's note is dropped.
{
	const h = harness({ env: rexEnv, replies: [namingOn] });
	assert.deepEqual(h.events, ["session_start", "before_agent_start"]);
	await h.start();
	assert.deepEqual(await h.run({ other: "kept" }), { other: "kept", [REX_SECTION]: TAB_CONTEXT });
	assert.deepEqual(await h.run(), { [REX_SECTION]: TAB_CONTEXT }, "later runs reuse the loaded context");
	assert.equal(h.calls.length, 3, "loads once per session");
	assert.ok(h.calls.every((call) => call.command === REX && call.options?.timeout === REX_SESSION_START_TIMEOUT_MS));
	assert.deepEqual(
		h.calls.map((call) => call.args),
		[
			["skill", "status", "--json"],
			[...REX_SESSION_START_ARGS, "--feature-session-naming=true"],
			[...REX_SESSION_START_ARGS, "--feature-session-naming=false"],
		],
	);
	const context = (await h.run())[REX_SECTION];
	assert.ok(!context.includes("Name the session"), "Rex's session-naming text is gone");
	assert.ok(!context.includes("out of date"), "the mismatched flag's note is gone");
	assert.ok(context.includes('rex window rename -s "$REX_SESSION" <window-id> <label>'));
	assert.ok(context.includes('rex block inspect -s "$REX_SESSION" "$REX_BLOCK" --json'));
	assert.ok(context.includes("Leave the session's name alone"));
}

// Naming off: Rex's output without naming is used as is, with no tab naming.
{
	const h = harness({ env: rexEnv, replies: [namingOff] });
	await h.start();
	assert.deepEqual(await h.run(), { [REX_SECTION]: BASE });
}

// Rex can't report the choice: naming is treated as on, Rex's default.
for (const [label, reply] of [
	["status fails", new Error("unknown command skill")],
	["status lists no Pi", status()],
	["status is not JSON", ok("Pi (found)")],
] as const) {
	const h = harness({ env: rexEnv, replies: [{ ...namingOn, status: reply }] });
	await h.start();
	assert.equal((await h.run())[REX_SECTION], TAB_CONTEXT, label);
}

// A Rex without naming text passes through unchanged, and a real out-of-date note is kept.
{
	const withNote = `${BASE}\n\n${OUT_OF_DATE}`;
	const h = harness({ env: rexEnv, replies: [{ ...namingOn, withNaming: ok(withNote), withoutNaming: ok(withNote) }] });
	await h.start();
	assert.equal((await h.run())[REX_SECTION], withNote);
}

// A new session (/new, /resume, reload) loads the context again.
{
	const h = harness({ env: rexEnv, replies: [namingOn, namingOff] });
	await h.start();
	assert.equal((await h.run())[REX_SECTION], TAB_CONTEXT);
	await h.start();
	assert.equal((await h.run())[REX_SECTION], BASE);
	assert.equal(h.calls.length, 6);
}

// Skipped outside Rex, in non-interactive modes, and when turned off. A stale section is removed.
for (const [label, env, mode] of [
	["outside Rex", { REX_BIN_DIR: BIN_DIR }, "tui"],
	["blank REX_SESSION", { ...rexEnv, REX_SESSION: " " }, "tui"],
	["print mode", rexEnv, "print"],
	["json mode", rexEnv, "json"],
	["rpc mode", rexEnv, "rpc"],
	["PI_REX_CONTEXT=0", { ...rexEnv, PI_REX_CONTEXT: "0" }, "tui"],
	["PI_REX_CONTEXT=off", { ...rexEnv, PI_REX_CONTEXT: "off" }, "tui"],
] as const) {
	const h = harness({ env, replies: [] });
	await h.start(mode);
	assert.deepEqual(await h.run({ [REX_SECTION]: "stale", other: "kept" }), { other: "kept" }, label);
	assert.equal(h.calls.length, 0, label);
}

// Rex failures never block a run and never leave a section behind. Without both session-start
// outputs the naming text can't be found, so no context is given rather than session naming.
for (const [label, result] of [
	["non-zero exit", { stdout: BASE, stderr: "boom", code: 1, killed: false }],
	["timeout", { stdout: "", stderr: "", code: 0, killed: true }],
	["empty output", ok("  \n")],
	["missing binary", new Error("spawn rex ENOENT")],
] as const) {
	for (const replies of [
		{ status: result, withNaming: result, withoutNaming: result },
		{ ...namingOn, withNaming: result },
		{ ...namingOn, withoutNaming: result },
		{ ...namingOff, withoutNaming: result },
	]) {
		const h = harness({ env: rexEnv, replies: [replies] });
		await h.start();
		assert.deepEqual(await h.run({ [REX_SECTION]: "stale" }), {}, label);
	}
}

// Installed naming choice parsing.
assert.equal(parseSessionNaming(status({ session_naming: true }).stdout), true);
assert.equal(parseSessionNaming(status({ session_naming: false }).stdout), false);
assert.equal(parseSessionNaming(status({}).stdout), false, "Rex omits a false session_naming");
assert.equal(parseSessionNaming(status().stdout), undefined);
assert.equal(parseSessionNaming("{}"), undefined);
assert.equal(parseSessionNaming("null"), undefined);
assert.equal(parseSessionNaming(undefined), undefined);

// The tab paragraphs take the place of the first naming paragraph; later ones are dropped.
assert.equal(
	nameTabNotSession(`A\n\nNAME 1\n\nB\n\nNAME 2\n\n\nC`, `A\n\nB\n\nC\n\nNOTE`),
	["A", ...TAB_NAMING_PARAGRAPHS, "B", "C"].join("\n\n"),
);

// Executable resolution prefers REX_BIN_DIR and falls back to PATH.
assert.equal(resolveRexExecutable({ REX_BIN_DIR: BIN_DIR }, (path) => path === REX), REX);
assert.equal(resolveRexExecutable({ REX_BIN_DIR: BIN_DIR }, () => false), "rex");
assert.equal(resolveRexExecutable({}, () => true), "rex");
assert.equal(shouldLoadRexContext("tui", { REX_SESSION: "s", PI_REX_CONTEXT: "1" }), true);

console.log("rex smoke ok");
