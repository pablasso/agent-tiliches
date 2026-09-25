import { truncateToWidth } from "@earendil-works/pi-tui";
import { attention, isOpen, type FactoryEvent, type FactoryState, type Run } from "./core.ts";

/** Never let agent-provided labels/notes become terminal control sequences. */
export function safeText(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
const oneLine = (value: string): string => safeText(value).replace(/\s+/g, " ").trim();
function age(at: string | number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - (typeof at === "string" ? Date.parse(at) : at)) / 1_000));
	return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`;
}

export function widgetLines(run: Run, width: number, options: { checkedAt?: number; owned: boolean; idle: boolean; now?: number }): string[] {
	const now = options.now ?? Date.now();
	const lines = [`Factory · ${run.goal} · ${run.finish?.outcome ?? (options.owned ? run.phase : "history — another session owns this run")}`];
	if (!run.finish) {
		const open = run.assignments.filter(isOpen);
		const shown = open.length ? open.slice(0, 4) : run.assignments.slice(-2);
		for (const a of shown) {
			const runtime = !options.checkedAt ? "not refreshed" : a.observation?.state ?? "not observed";
			lines.push(`${a.name} · ${a.role} · ${a.id}: ${isOpen(a) ? `${a.status} / ${runtime}${runtime === "idle" ? " — outcome pending" : ""}` : `reported ${a.status}`}`);
		}
		if (open.length > shown.length) lines.push(`+${open.length - shown.length} active assignments; /factory for details`);
		if (run.phase === "waiting_user") lines.push(`Waiting for you: ${run.note}`);
		else if (options.idle && options.owned) lines.push(open.length && !options.checkedAt
			? "Runtime not refreshed; helper outcomes remain unverified."
			: attention(run)[0] ?? "Orchestrator idle; helpers still working.");
		else lines.push(`Latest: ${run.note}`);
		lines.push(`Last meaningful update: ${age(run.updatedAt, now)} ago · Runtime: ${options.checkedAt ? `checked ${age(options.checkedAt, now)} ago` : "unverified"} · /factory`);
	} else lines.push(`${run.finish.summary} · /factory for receipt and audit source`);
	return lines.map((line) => truncateToWidth(oneLine(line), Math.max(1, width), "…"));
}

export function describeRun(run: Run): string {
	return safeText([
		`Factory: ${run.goal}`, `Run ID: ${run.id}`, `Phase: ${run.finish?.outcome ?? run.phase}`, `Latest reported update: ${run.updatedAt} — ${run.note}`,
		`Session: ${run.sessionFile}`, `Owner: ${run.ownerSessionId}`, `Checkout: ${run.cwd}`, "",
		...run.assignments.flatMap((a) => [
			`${a.id} — ${a.name} (${a.role}): reported ${a.status}`, `  Task: ${a.task}`, `  Outcome/note: ${a.note}`,
			`  Observed: ${a.observation ? `${a.observation.state} at ${a.observation.at} ${a.observation.detail}` : "not yet observed"}`,
			`  Herdr: ${a.agent.handle ?? a.agent.paneId} · ${a.agent.paneId} · ${a.agent.workspaceId}`,
			`  Helper session: ${a.agent.sessionFile}`, `  Helper checkout: ${a.agent.cwd}`,
			...a.evidence.map((item) => `  Evidence / disposition: ${item}`),
		]),
		"", ...(run.finish ? [run.finish.receipt] : attention(run)),
	].join("\n"));
}

export function historyText(state: FactoryState, run: Run): string {
	const events = state.events.filter((e) => e.runId === run.id);
	return safeText([
		`Factory history — ${run.goal} (${run.id})`, "Observed runtime is separate from reported task outcomes.",
		...(events.length > 100 ? [`Showing last 100 of ${events.length} events. Full history: ${run.sessionFile}`] : []),
		...events.slice(-100).map((e) => `${e.at} [${e.kind === "observe" ? "observed" : "reported"}] ${eventText(e)}`),
		`Source: ${run.sessionFile}`,
	].join("\n"));
}
function eventText(e: FactoryEvent): string {
	switch (e.kind) {
		case "start": return `Started: ${e.goal} — ${e.note}`;
		case "assign": return `${e.id}: ${e.name} / ${e.role} — ${e.task}`;
		case "update": return `${e.assignmentId ?? "run"}: ${e.status ?? e.phase ?? "update"} — ${e.note}${e.evidence.length ? ` (${e.evidence.join("; ")})` : ""}`;
		case "observe": return `${e.assignmentId}: ${e.state} ${e.detail}`;
		case "finish": return `${e.outcome}: ${e.summary}`;
	}
}
