import { strict as assert } from "node:assert";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyEvent, currentRun, emptyState, EVENT_TYPE, replay, type FactoryEvent } from "../extensions/factory/core.ts";
import { bindAgent, herdrScope, listAgents, observeAgent, parseAgents, type LiveAgent } from "../extensions/factory/herdr.ts";
import { createFactoryExtension } from "../extensions/factory/index.ts";
import { FactoryMonitor } from "../extensions/factory/monitor.ts";
import { safeText, widgetLines } from "../extensions/factory/ui.ts";

const originalEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = "/tmp/fictional-factory-test.sock";
const cleanups: (() => Promise<void>)[] = [];
try {
	const inventory = () => JSON.stringify({ result: { type: "agent_list", agents: [{
		agent: "pi", name: "lucia-test", pane_id: "w1:p2", workspace_id: "w1", terminal_id: "term-1",
		cwd: "/tmp/fictional-project", agent_status: "done",
		agent_session: { kind: "path", value: "/tmp/fictional-helper.jsonl" },
	}] } });
	const live = parseAgents(inventory());
	assert.equal(live[0].state, "idle", "Herdr done means input-ready, not completed");
	const ref = bindAgent(live, "lucia-test");
	assert.equal(ref.sessionFile, "/tmp/fictional-helper.jsonl");
	assert.throws(() => bindAgent(live, "missing"), /found 0/);
	assert.throws(() => bindAgent([...live, ...live], "lucia-test"), /found 2/);
	assert.throws(() => bindAgent([{ ...live[0], sessionFile: "" }], "lucia-test"), /absolute session file/);
	assert.throws(() => parseAgents('{"result":{}}'), /Unexpected/);
	assert.throws(() => parseAgents('{"result":{"type":"agent_list","agents":[{}]}}'), /Incomplete/);
	assert.equal(observeAgent(ref, []).state, "missing");
	assert.equal(observeAgent(ref, [{ ...live[0], sessionFile: "/tmp/replacement.jsonl" }]).state, "unknown");
	assert.match(observeAgent(ref, [{ ...live[0], paneId: "w2:p3", workspaceId: "w2" }]).detail, /Moved to/);
	let adapterCalls = 0;
	const exec = async (command: string, args: string[]) => {
		adapterCalls++; assert.equal(command, "herdr"); assert.deepEqual(args, ["agent", "list"]);
		return { stdout: inventory(), stderr: "", code: 0, killed: false };
	};
	await listAgents(exec, herdrScope());
	const beforeGuard = adapterCalls;
	await assert.rejects(listAgents(exec, "another-host:another-socket"), /differs/);
	process.env.HERDR_ENV = "0";
	await assert.rejects(listAgents(exec, "elsewhere"), /HERDR_ENV/);
	assert.equal(adapterCalls, beforeGuard, "Never inspect another session/outside Herdr");
	process.env.HERDR_ENV = "1";
	await assert.rejects(listAgents(async () => ({ stdout: "", stderr: "", code: 0, killed: true }), herdrScope()), /timed out/);

	const at = "2026-01-01T00:00:00.000Z";
	let state = applyEvent(emptyState(), { version: 1, kind: "start", runId: "test-run", at, goal: "Synthetic Borges-like run", ownerSessionId: "parent", sessionFile: "/tmp/parent.jsonl", cwd: ref.cwd, scope: herdrScope(), note: "Approved" });
	state = applyEvent(state, { version: 1, kind: "assign", runId: "test-run", at, id: "implementation", name: "Lucía", role: "implementor", task: "Write code", agent: ref });
	let agents = live.map((a) => ({ ...a, state: "working" as LiveAgent["state"] }));
	let samples = 0;
	let fail = false;
	let pending: ReturnType<typeof deferred<LiveAgent[]>> | undefined;
	const monitor = new FactoryMonitor({
		intervalMs: 60_000,
		getRun: () => currentRun(state),
		sample: async () => { samples++; if (pending) return pending.promise; if (fail) throw new Error("Socket unavailable"); return agents; },
		record: (assignmentId, observation) => { state = applyEvent(state, { version: 1, kind: "observe", runId: "test-run", assignmentId, ...observation }); },
		refresh() {},
	});
	cleanups.push(async () => monitor.stop());
	assert.equal(samples, 0, "Construction must not start resources");
	monitor.start();
	await monitor.poll();
	const afterFirst = state.events.length;
	for (let i = 0; i < 10; i++) await monitor.poll();
	assert.equal(state.events.length, afterFirst, "Polls must not flood the durable log");
	const wait = monitor.wait();
	await tick();
	await assert.rejects(monitor.wait(), /already active/);
	agents = [{ ...agents[0], state: "idle" }];
	await monitor.poll();
	assert.match(await bounded(wait), /acknowledge/);
	assert.equal(currentRun(state)!.assignments[0].status, "active");
	fail = true;
	await monitor.poll();
	assert.equal(currentRun(state)!.assignments[0].observation!.state, "unavailable");
	fail = false;
	agents = [{ ...agents[0], state: "working" }];
	await monitor.poll();
	assert.match(await bounded(monitor.wait(undefined, 0.01)), /timed out/);
	// Cancellation is immediate even when the shared status request hasn't returned.
	pending = deferred<LiveAgent[]>();
	const abort = new AbortController();
	const cancelled = monitor.wait(abort.signal);
	abort.abort();
	assert.match(await bounded(cancelled), /cancelled/);
	const stillPending = pending;
	const eventsBeforeStop = state.events.length;
	monitor.stop();
	stillPending.resolve([{ ...agents[0], state: "idle" }]);
	await tick();
	assert.equal(state.events.length, eventsBeforeStop, "Late samples must not append after shutdown/branch replacement");
	assert.equal(monitor.lastCheckedAt, undefined, "Restored observations start stale");

	const h = harness(live);
	cleanups.push(() => h.emit("session_shutdown"));
	assert.equal(h.execCalls.length, 0, "Extension factory must be inactive until a session/run starts");
	assert.equal(h.tool.executionMode, "sequential");
	await h.emit("session_start");
	assert.equal(h.execCalls.length, 0);
	await h.emit("agent_start");
	await h.call({ action: "start", goal: "Developer workflow", note: "User approved Makefile work; review its launch safety" });
	const runId = currentRun(replay(h.entries))!.id;
	await h.call({ action: "assign", runId, assignmentId: "dev", name: "Lucía", role: "implementor", task: "Add make dev", target: "lucia-test", evidence: ["main at abc123; approved tooling plan"] });
	assert.equal(currentRun(replay(h.entries))!.assignments[0].agent.sessionFile, ref.sessionFile);
	assert.deepEqual(currentRun(replay(h.entries))!.assignments[0].evidence, ["main at abc123; approved tooling plan"]);
	await assert.rejects(h.call({ action: "finish", runId, outcome: "completed", note: "Ready" }), /Acknowledge all/);
	await assert.rejects(h.call({ action: "update", runId: "stale-run", note: "wrong" }), /current runId/);
	await h.call({ action: "update", runId, phase: "waiting_user", note: "Approve patch scope" });
	const noticesBeforeApproval = h.notifications.length;
	await h.emit("agent_settled");
	await h.emit("agent_settled");
	assert.equal(h.notifications.length, noticesBeforeApproval, "Approval pauses aren't missing closeouts");
	assert.match(text(await h.call({ action: "wait", runId })), /Waiting for you/);
	await h.emit("agent_start");
	await h.call({ action: "update", runId, phase: "running", note: "Approved; implementation resumed" });
	h.agents = h.agents.map((a) => ({ ...a, state: "working" }));
	const liveWait = h.call({ action: "wait", runId });
	setTimeout(() => { h.agents = h.agents.map((a) => ({ ...a, state: "idle" })); }, 20);
	assert.match(text(await bounded(liveWait)), /acknowledge/);
	assert.ok(h.execCalls.every((call) => call.command === "herdr" && JSON.stringify(call.args) === '["agent","list"]'));
	await h.call({ action: "update", runId, assignmentId: "dev", status: "completed", note: "make dev committed", evidence: ["commit abc123; tests passed"] });
	await h.emit("agent_settled");
	const notifiedOnce = h.notifications.length;
	assert.match(h.notifications.at(-1)!, /Closeout/);
	await h.emit("agent_settled");
	assert.equal(h.notifications.length, notifiedOnce, "Missing-closeout warnings are deduplicated");
	await h.command("log");
	assert.match(h.entries.at(-1).data.text, /Approve patch scope/);
	await h.command("");
	assert.match(h.entries.at(-1).data.text, /Helper session: \/tmp\/fictional-helper.jsonl/);
	assert.equal(h.modelTurns, 0, "Views and monitoring must not invoke models");

	const receiptResult = await h.call({ action: "finish", runId, outcome: "completed", note: "Ready for user inspection", evidence: ["Review skipped: small isolated change", "No push or cleanup"] });
	assert.match(text(receiptResult), /Lucía · implementor · dev: completed/);
	const finishEntries = () => h.entries.filter((e) => e.customType === EVENT_TYPE && e.data.kind === "finish");
	assert.equal(finishEntries().length, 1);
	const renderedReceipt = h.renderers.get(EVENT_TYPE)(finishEntries()[0], { expanded: false }, theme()).render(60).join("\n");
	assert.match(renderedReceipt, /Ready for user inspection/);
	await h.call({ action: "finish", runId, outcome: "completed", note: "repeat" });
	assert.equal(finishEntries().length, 1, "Retries must not duplicate receipts");
	await h.call({ action: "start", goal: "Follow-up", note: "Next request" });
	const secondId = currentRun(replay(h.entries))!.id;
	assert.notEqual(secondId, runId);
	await h.call({ action: "assign", runId: secondId, assignmentId: "follow-up", name: "Lucía", role: "implementor", task: "Follow-up", target: "lucia-test" });
	const saved = structuredClone(h.entries);
	await h.emit("session_shutdown");

	const restored = harness(live, saved);
	cleanups.push(() => restored.emit("session_shutdown"));
	await restored.emit("session_start");
	await tick();
	assert.equal(currentRun(replay(restored.entries))!.id, secondId);
	await restored.emit("session_compact");
	assert.match(text(await restored.call({ action: "status" })), /Follow-up/);
	// Restore an older branch with no second run; don't import abandoned future events.
	restored.entries.splice(0, restored.entries.length, ...saved.slice(0, saved.findIndex((e) => e.data?.kind === "start" && e.data.runId === secondId)));
	await restored.emit("session_tree");
	assert.equal(currentRun(replay(restored.entries))!.id, runId);
	assert.match(text(await restored.call({ action: "status" })), /Developer workflow/);
	await restored.emit("session_shutdown");

	const fork = harness(live, saved, "fork-owner");
	cleanups.push(() => fork.emit("session_shutdown"));
	await fork.emit("session_start");
	assert.equal(fork.execCalls.length, 0, "A fork must not resume monitoring someone else's run");
	await assert.rejects(fork.call({ action: "update", runId: secondId, note: "Should not mutate inherited run" }), /Inherited runs are read-only/);
	await fork.call({ action: "start", goal: "Fork's own work" });
	assert.equal(currentRun(replay(fork.entries))!.ownerSessionId, "fork-owner");

	const broken = harness(live, [{ type: "custom", customType: EVENT_TYPE, data: { version: 999 } }]);
	cleanups.push(() => broken.emit("session_shutdown"));
	await broken.emit("session_start");
	await assert.rejects(broken.call({ action: "start", goal: "Don't overwrite broken history" }), /history unavailable/);
	assert.equal(broken.execCalls.length, 0);

	const run = currentRun(replay(saved))!;
	run.goal = "👩🏽‍💻 Lucía \u001b[31munsafe\u001b[0m title";
	assert.match(widgetLines(run, 180, { owned: true, idle: true }).join("\n"), /Runtime not refreshed/);
	assert.doesNotMatch(widgetLines(run, 180, { owned: true, idle: true }).join("\n"), /is idle/);
	for (const width of [1, 8, 20, 60, 120]) {
		const lines = widgetLines(run, width, { owned: true, idle: true });
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.every((line) => !line.replace(/\x1b\[0m/g, "").includes("\u001b")), "Only the TUI truncator's own ANSI resets may remain");
	}
	assert.equal(safeText("hello\u001b]0;injected\u0007world"), "helloworld");
	assert.match(h.widgetText(50), /Factory/);
	assert.equal(h.modelTurns, 0);
	console.log("factory runtime smoke ok (mocked Herdr only; no live agents touched)");
} finally {
	for (const cleanup of cleanups.reverse()) await cleanup();
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
}

function harness(initial: LiveAgent[], existing: any[] = [], owner = "parent") {
	const handlers = new Map<string, ((event: unknown, ctx: any) => unknown)[]>();
	const renderers = new Map<string, any>();
	let command: any;
	let tool: any;
	let widget: any;
	const h = {
		agents: structuredClone(initial), entries: structuredClone(existing), notifications: [] as string[], renderers,
		execCalls: [] as { command: string; args: string[] }[], modelTurns: 0,
		get tool() { return tool; },
		async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({ type: name }, context); },
		call(params: any, signal?: AbortSignal) { return tool.execute("test-call", params, signal, undefined, context); },
		command(args: string) { return command(args, context); },
		widgetText(width: number) { return typeof widget === "function" ? widget({}, theme()).render(width).join("\n") : (widget ?? []).join("\n"); },
	};
	const context = {
		cwd: "/tmp/fictional-project", mode: "tui", hasUI: true, isIdle: () => false,
		sessionManager: { getSessionId: () => owner, getSessionFile: () => `/tmp/${owner}.jsonl`, getBranch: () => h.entries },
		ui: {
			setWidget(_key: string, value: unknown) { widget = value; },
			notify(message: string) { h.notifications.push(message); },
		},
	};
	const pi = {
		on(name: string, handler: (event: unknown, ctx: any) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerEntryRenderer(name: string, renderer: unknown) { renderers.set(name, renderer); },
		registerTool(value: unknown) { tool = value; },
		registerCommand(name: string, options: any) { assert.equal(name, "factory"); command = options.handler; },
		appendEntry(customType: string, data: unknown) { h.entries.push({ type: "custom", customType, data: structuredClone(data) }); },
		async exec(cmd: string, args: string[]) {
			h.execCalls.push({ command: cmd, args });
			assert.equal(cmd, "herdr"); assert.deepEqual(args, ["agent", "list"]);
			return { stdout: JSON.stringify({ result: { type: "agent_list", agents: h.agents.map((a) => ({
				agent: a.kind, name: a.handle, pane_id: a.paneId, workspace_id: a.workspaceId, terminal_id: a.terminalId,
				cwd: a.cwd, agent_status: a.state, agent_session: { kind: "path", value: a.sessionFile },
			})) } }), stderr: "", code: 0, killed: false };
		},
		sendMessage() { h.modelTurns++; throw new Error("No injected model messages expected"); },
		sendUserMessage() { h.modelTurns++; throw new Error("No model continuations expected"); },
	};
	createFactoryExtension(pi as unknown as ExtensionAPI, { intervalMs: 5 });
	return h;
}
function theme() { return { fg: (_name: string, text: string) => text }; }
function text(result: any): string { return result.content.map((item: any) => item.text ?? "").join("\n"); }
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)); }
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Test timed out")), 2_000); })]);
	} finally { if (timeout) clearTimeout(timeout); }
}
