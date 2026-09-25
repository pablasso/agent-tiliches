import { randomUUID } from "node:crypto";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	applyEvent, attention, completionReceipt, currentRun, emptyState, EVENT_TYPE, isOpen, OUTCOMES, PHASES, replay, STATUSES,
	type AssignmentStatus, type FactoryEvent, type Outcome, type Phase, type Run,
} from "./core.ts";
import { bindAgent, herdrScope, listAgents, observeAgent } from "./herdr.ts";
import { FactoryMonitor } from "./monitor.ts";
import { describeRun, historyText, safeText, widgetLines } from "./ui.ts";

const VIEW_TYPE = "factory-view";
const Parameters = Type.Object({
	action: StringEnum(["start", "assign", "update", "wait", "finish", "status"] as const),
	runId: Type.Optional(Type.String({ description: "Returned by start; required for every action except start/status." })),
	goal: Type.Optional(Type.String({ maxLength: 500 })),
	assignmentId: Type.Optional(Type.String({ maxLength: 64 })),
	name: Type.Optional(Type.String({ maxLength: 64, description: "Human-facing first name, not identity." })),
	role: Type.Optional(Type.String({ maxLength: 64 })),
	task: Type.Optional(Type.String({ maxLength: 1_000 })),
	target: Type.Optional(Type.String({ maxLength: 128, description: "Live Herdr agent handle or pane ID to register." })),
	status: Type.Optional(StringEnum(STATUSES)),
	phase: Type.Optional(StringEnum(PHASES)),
	note: Type.Optional(Type.String({ maxLength: 4_000, description: "Meaningful progress, review rationale/disposition, blocker, or final summary." })),
	evidence: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 30, description: "Commit/check/review references and known limitations; no invented verification." })),
	outcome: Type.Optional(StringEnum(OUTCOMES)),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600, description: "Optional wait limit. Otherwise wait until attention is needed or cancelled." })),
});
interface Params {
	action: "start" | "assign" | "update" | "wait" | "finish" | "status";
	runId?: string; goal?: string; assignmentId?: string; name?: string; role?: string; task?: string; target?: string;
	status?: AssignmentStatus; phase?: Phase; note?: string; evidence?: string[]; outcome?: Outcome; timeoutSeconds?: number;
}

/** Optional interval is only for deterministic local tests; production needs no configuration. */
export function createFactoryExtension(pi: ExtensionAPI, options: { intervalMs?: number } = {}): void {
	let state = emptyState();
	let ctx: ExtensionContext | undefined;
	let epoch = 0;
	let fault: string | undefined;
	let hidden = false;
	let idle = true;
	let notified = "";

	function ownedRun(): Run | undefined {
		const run = currentRun(state);
		return !fault && run?.ownerSessionId === ctx?.sessionManager.getSessionId() ? run : undefined;
	}
	function record(event: FactoryEvent): void {
		if (fault) throw new Error(fault);
		const next = applyEvent(state, event);
		try { pi.appendEntry(EVENT_TYPE, event); }
		catch (error) {
			fault = `Factory could not persist its log: ${errorText(error)}`;
			monitor.stop();
			refresh();
			throw error;
		}
		state = next;
	}
	function refresh(): void {
		if (!ctx) return;
		const run = currentRun(state);
		if (ctx.mode === "tui") {
			if (hidden || (!run && !fault)) ctx.ui.setWidget("factory", undefined);
			else ctx.ui.setWidget("factory", (_tui, theme) => ({
				render(width: number) {
					const current = currentRun(state);
					if (fault) return new Text(safeText(fault), 0, 0).render(width);
					return current ? widgetLines(current, width, { checkedAt: monitor.lastCheckedAt, owned: !!ownedRun(), idle })
						.map((line, index) => theme.fg(index === 0 ? "accent" : "muted", line)) : [];
				},
				invalidate() {},
			}));
		}
		const owned = ownedRun();
		const freshEnough = owned && (!owned.assignments.some(isOpen) || monitor.lastCheckedAt !== undefined);
		const notices = owned && freshEnough && !owned.finish && owned.phase !== "waiting_user" ? attention(owned) : [];
		const key = notices.length ? `${owned!.id}:${notices.join("\n")}` : "";
		if (!key) notified = "";
		else if (idle && key !== notified && ctx.hasUI) {
			notified = key;
			ctx.ui.notify(safeText(`Factory needs attention: ${notices[0]}`), "warning");
		}
	}
	const monitor = new FactoryMonitor({
		intervalMs: options.intervalMs,
		getRun: ownedRun,
		sample: (run, signal) => listAgents(pi.exec.bind(pi), run.scope, signal),
		record: (assignmentId, observation) => {
			const run = ownedRun();
			if (run && !run.finish) record({ version: 1, kind: "observe", runId: run.id, assignmentId, ...observation });
		},
		refresh,
	});
	function sync(): void {
		const run = ownedRun();
		if (run && !run.finish) monitor.start();
		else monitor.stop();
		monitor.changed();
	}
	function restore(context: ExtensionContext): void {
		epoch++;
		monitor.stop();
		ctx = context;
		fault = undefined;
		notified = "";
		idle = context.isIdle();
		try { state = replay(context.sessionManager.getBranch()); }
		catch (error) { state = emptyState(); fault = `Factory history unavailable: ${errorText(error)}`; }
		sync();
		void monitor.poll().catch(() => {});
	}
	function requireRun(context: ExtensionContext, runId?: string): Run {
		if (fault) throw new Error(fault);
		const run = ownedRun();
		if (!run || run.ownerSessionId !== context.sessionManager.getSessionId()) {
			throw new Error("No factory run is owned by this session. Inherited runs are read-only; start a new run here.");
		}
		if (!runId || runId !== run.id) throw new Error("Supply the current runId returned by factory start/status.");
		return run;
	}

	// These hooks/renderers require the current Pi runtime (0.87+); local dev typings predate them.
	const modern = pi as unknown as {
		registerEntryRenderer<T>(type: string, render: (entry: { data?: T }, options: { expanded: boolean }, theme: Theme) => Text | undefined): void;
		on(event: "agent_settled", handler: (event: unknown, context: ExtensionContext) => void): void;
	};
	if (typeof modern.registerEntryRenderer !== "function") throw new Error("Factory requires Pi 0.87+ with custom entry renderers and agent_settled.");
	modern.registerEntryRenderer<FactoryEvent>(EVENT_TYPE, (entry) => entry.data?.kind === "finish" ? new Text(safeText(entry.data.receipt), 0, 0) : undefined);
	modern.registerEntryRenderer<{ text: string }>(VIEW_TYPE, (entry) => entry.data ? new Text(safeText(entry.data.text), 0, 0) : undefined);

	pi.on("session_start", (_event, context) => restore(context));
	pi.on("session_tree", (_event, context) => restore(context));
	pi.on("session_compact", (_event, context) => { ctx = context; refresh(); });
	pi.on("agent_start", (_event, context) => { ctx = context; idle = false; refresh(); });
	modern.on("agent_settled", (_event, context) => { ctx = context; idle = true; refresh(); });
	pi.on("session_shutdown", () => { epoch++; monitor.stop(); ctx = undefined; });

	const tool = {
		name: "factory",
		label: "Factory",
		description: "Monitor an approved Herdr implementation run without executing work. start(goal,note) returns runId. assign(runId,assignmentId,name,role,task,target) binds a live Pi helper/session; use a new assignment ID for each handoff. update(runId,note,evidence,assignmentId?,status?,phase?) records real progress/decisions. wait(runId) waits locally for attention, without model polling; idle is NOT completion. finish(runId,outcome,note,evidence) records a visible receipt; completed requires all assignments acknowledged. status(runId?) reads durable state. Only the orchestrator reports; helpers must not create their own runs. No launching, prompting, cleanup, code changes, or automatic model turns.",
		parameters: Parameters,
		executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: Params, signal: AbortSignal | undefined, _onUpdate: unknown, context: ExtensionContext) {
			if (!ctx) restore(context);
			if (fault) throw new Error(fault);
			const token = epoch;
			const at = new Date().toISOString();
			let message: string;
			if (params.action === "status") {
				const selected = params.runId ? state.runs.find((r) => r.id === params.runId) : currentRun(state);
				if (params.runId && !selected) throw new Error("Unknown run ID on this session branch.");
				message = selected ? describeRun(selected) : "No factory runs on this session branch.";
			} else if (params.action === "start") {
				const sessionFile = context.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Factory needs a saved Pi session; ephemeral sessions cannot provide a durable audit log.");
				record({ version: 1, kind: "start", runId: randomUUID(), at, goal: required(params.goal, "goal"),
					ownerSessionId: context.sessionManager.getSessionId(), sessionFile, cwd: context.cwd, scope: herdrScope(), note: params.note?.trim() || "Approved implementation started" });
				sync();
				message = "Run started. Register the approved helpers; preserve the plan's user-approval gate.";
			} else {
				const run = requireRun(context, params.runId);
				if (params.action === "finish" && run.finish) {
					if (params.outcome !== run.finish.outcome) throw new Error("Run is already finished with a different outcome.");
					message = run.finish.receipt; // Idempotent: no duplicate receipt/notification.
				} else if (run.finish) throw new Error("Run is finished; start another for follow-up work.");
				else if (params.action === "assign") {
					const id = required(params.assignmentId, "assignmentId");
					const name = required(params.name, "name");
					const role = required(params.role, "role");
					const task = required(params.task, "task");
					const target = required(params.target, "target");
					const agents = await listAgents(pi.exec.bind(pi), run.scope, signal);
					if (signal?.aborted || token !== epoch || currentRun(state)?.id !== run.id) throw new Error("Assignment cancelled/session changed; no helper was registered.");
					const agent = bindAgent(agents, target);
					if (agent.sessionFile === run.sessionFile) throw new Error("Do not register the orchestrator as its own helper.");
					record({ version: 1, kind: "assign", runId: run.id, at: new Date().toISOString(), id, name, role, task, agent, evidence: params.evidence ?? [] });
					record({ version: 1, kind: "observe", runId: run.id, at: new Date().toISOString(), assignmentId: id, ...observeAgent(agent, agents) });
					sync();
					message = `Registered ${name} [${id}]. Audit session: ${agent.sessionFile}. Dispatch through Herdr, then use factory wait.`;
				} else if (params.action === "update") {
					record({ version: 1, kind: "update", runId: run.id, at, assignmentId: params.assignmentId, status: params.status,
						phase: params.phase, note: required(params.note, "note"), evidence: params.evidence ?? [] });
					sync();
					message = "Progress/decision recorded. Reported outcomes are not runtime observations.";
				} else if (params.action === "wait") {
					message = await monitor.wait(signal, params.timeoutSeconds);
				} else if (params.action === "finish") {
					const summary = required(params.note, "note");
					if (!params.outcome) throw new Error("finish requires an explicit outcome.");
					const evidence = params.evidence ?? [];
					const receipt = completionReceipt(run, params.outcome, summary, evidence);
					record({ version: 1, kind: "finish", runId: run.id, at, outcome: params.outcome, summary, evidence, receipt });
					sync();
					if (context.hasUI) context.ui.notify(safeText(`Factory ${params.outcome}: ${run.goal}`), params.outcome === "completed" ? "info" : "warning");
					message = receipt;
				} else throw new Error("Unknown factory action.");
			}
			const run = currentRun(state);
			return {
				content: [{ type: "text" as const, text: `${message}${run && !["status", "finish"].includes(params.action) ? `\nRun ID: ${run.id}\nPhase: ${run.phase}; ${run.assignments.filter((a) => a.status === "active" || a.status === "blocked").length} open assignment(s).` : ""}` }],
				details: { action: params.action, runId: run?.id },
			};
		},
		renderCall(params: Params, theme: Theme) { return new Text(theme.fg("toolTitle", `factory ${params.action}`), 0, 0); },
		renderResult(result: { content: { type: string; text?: string }[] }, options: { expanded: boolean }) {
			const text = safeText(result.content.map((c) => c.text ?? "").join("\n"));
			return new Text(options.expanded ? text : text.split("\n")[0], 0, 0);
		},
	};
	pi.registerTool(tool);

	pi.registerCommand("factory", {
		description: "Show factory status/history without a model call: /factory [log|hide|show|cancel-wait]",
		handler: async (args, context) => {
			if (!ctx) restore(context);
			const action = args.trim();
			if (action === "hide" || action === "show") { hidden = action === "hide"; refresh(); return; }
			if (action === "cancel-wait") { monitor.cancelWait(); context.ui.notify("Factory wait released; helpers and monitoring are unchanged.", "info"); return; }
			if (action && action !== "log") { context.ui.notify("Usage: /factory [log|hide|show|cancel-wait]", "warning"); return; }
			const run = currentRun(state);
			const text = fault ?? (run ? (action === "log" ? historyText(state, run) : [
				describeRun(run), "", "Runs on this branch:", ...state.runs.map((r) => `${r.id}: ${r.goal} — ${r.finish?.outcome ?? r.phase}`),
			].join("\n")) : "No factory runs on this session branch.");
			pi.appendEntry(VIEW_TYPE, { text }); // Native transcript entry; no model turn or context injection.
			if (context.mode !== "tui" && context.hasUI) context.ui.notify(safeText(text), "info");
		},
	});
}

export default function factoryExtension(pi: ExtensionAPI): void { createFactoryExtension(pi); }
function required(value: string | undefined, field: string): string {
	if (!value?.trim()) throw new Error(`${field} is required.`);
	return value.trim();
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
