import { strict as assert } from "node:assert";
import type { ExecOptions, ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rexExtension from "../extensions/rex/index.ts";
import {
	REX_SECTION,
	REX_SESSION_START_ARGS,
	REX_SESSION_START_TIMEOUT_MS,
	resolveRexExecutable,
	shouldLoadRexContext,
} from "../extensions/rex/core.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

const BIN_DIR = "/Applications/Rex Server.app/Contents/MacOS";
const REX = `${BIN_DIR}/rex`;
const CONTEXT = "You're running in a Rex terminal.\n\nREX_SESSION=session:test";

function harness(options: { env: Record<string, string | undefined>; results: Array<ExecResult | Error> }) {
	const handlers = new Map<string, Handler[]>();
	const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
	const results = [...options.results];
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
			const next = results.shift();
			if (!next) throw new Error("unexpected exec");
			if (next instanceof Error) throw next;
			return next;
		},
	});

	return {
		calls,
		events: [...handlers.keys()],
		async start(mode: ExtensionContext["mode"] = "tui") {
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

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const rexEnv = { REX_SESSION: "session:test", REX_BIN_DIR: BIN_DIR };

// Interactive Pi in Rex: runs Rex's hook once and adds its output as a prompt section.
{
	const h = harness({ env: rexEnv, results: [ok(`\n${CONTEXT}\n\n`)] });
	assert.deepEqual(h.events, ["session_start", "before_agent_start"]);
	await h.start();
	assert.deepEqual(await h.run({ other: "kept" }), { other: "kept", [REX_SECTION]: CONTEXT });
	assert.deepEqual(await h.run(), { [REX_SECTION]: CONTEXT }, "later runs reuse the loaded context");
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].command, REX);
	assert.deepEqual(h.calls[0].args, ["__internal", "session-start", "--agent", "pi"]);
	assert.equal(h.calls[0].options?.timeout, REX_SESSION_START_TIMEOUT_MS);
	assert.deepEqual(REX_SESSION_START_ARGS, h.calls[0].args);
}

// A new session (/new, /resume, reload) loads the context again.
{
	const h = harness({ env: rexEnv, results: [ok("first"), ok("second")] });
	await h.start();
	assert.equal((await h.run())[REX_SECTION], "first");
	await h.start();
	assert.equal((await h.run())[REX_SECTION], "second");
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
	const h = harness({ env, results: [] });
	await h.start(mode);
	assert.deepEqual(await h.run({ [REX_SECTION]: "stale", other: "kept" }), { other: "kept" }, label);
	assert.equal(h.calls.length, 0, label);
}

// Rex failures never block a run and never leave a section behind.
for (const [label, result] of [
	["non-zero exit", { stdout: CONTEXT, stderr: "boom", code: 1, killed: false }],
	["timeout", { stdout: "", stderr: "", code: 0, killed: true }],
	["empty output", ok("  \n")],
	["missing binary", new Error("spawn rex ENOENT")],
] as const) {
	const h = harness({ env: rexEnv, results: [result] });
	await h.start();
	assert.deepEqual(await h.run({ [REX_SECTION]: "stale" }), {}, label);
}

// Executable resolution prefers REX_BIN_DIR and falls back to PATH.
assert.equal(resolveRexExecutable({ REX_BIN_DIR: BIN_DIR }, (path) => path === REX), REX);
assert.equal(resolveRexExecutable({ REX_BIN_DIR: BIN_DIR }, () => false), "rex");
assert.equal(resolveRexExecutable({}, () => true), "rex");
assert.equal(shouldLoadRexContext("tui", { REX_SESSION: "s", PI_REX_CONTEXT: "1" }), true);

console.log("rex smoke ok");
