export const EVENT_TYPE = "factory-event";
export const PHASES = ["running", "waiting_user"] as const;
export const STATUSES = ["active", "blocked", "completed", "cancelled"] as const;
export const OUTCOMES = ["completed", "blocked", "cancelled"] as const;
export const RUNTIME_STATES = ["working", "idle", "blocked", "unknown", "missing", "unavailable"] as const;
export type Phase = (typeof PHASES)[number];
export type AssignmentStatus = (typeof STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export interface AgentRef {
	paneId: string;
	workspaceId: string;
	terminalId: string;
	handle?: string;
	sessionFile: string;
	cwd: string;
}

export interface Observation {
	state: RuntimeState;
	detail: string;
	at: string;
}

export interface Assignment {
	id: string;
	name: string;
	role: string;
	task: string;
	agent: AgentRef;
	status: AssignmentStatus;
	note: string;
	evidence: string[];
	createdAt: string;
	updatedAt: string;
	observation?: Observation;
}

export interface Run {
	id: string;
	goal: string;
	ownerSessionId: string;
	sessionFile: string;
	cwd: string;
	/** Host + inherited Herdr socket, not an unqualified pane/name. */
	scope: string;
	phase: Phase;
	note: string;
	createdAt: string;
	updatedAt: string;
	assignments: Assignment[];
	finish?: { outcome: Outcome; summary: string; evidence: string[]; at: string; receipt: string };
}

interface EventBase {
	version: 1;
	runId: string;
	at: string;
}
export type FactoryEvent = EventBase & (
	| { kind: "start"; goal: string; ownerSessionId: string; sessionFile: string; cwd: string; scope: string; note: string }
	| { kind: "assign"; id: string; name: string; role: string; task: string; agent: AgentRef; evidence?: string[] }
	| { kind: "update"; assignmentId?: string; status?: AssignmentStatus; phase?: Phase; note: string; evidence: string[] }
	| { kind: "observe"; assignmentId: string; state: RuntimeState; detail: string }
	| { kind: "finish"; outcome: Outcome; summary: string; evidence: string[]; receipt: string }
);
export interface FactoryState {
	runs: Run[];
	events: FactoryEvent[];
}
export const emptyState = (): FactoryState => ({ runs: [], events: [] });
export const currentRun = (state: FactoryState): Run | undefined => state.runs.at(-1);
export const isOpen = (assignment: Assignment): boolean => assignment.status === "active" || assignment.status === "blocked";

/** Validate first, then return new state; callers persist the event before adopting it. */
export function applyEvent(state: FactoryState, event: FactoryEvent): FactoryState {
	if (!event || event.version !== 1) throw new Error("Unsupported factory log version; history was not reset.");
	requireText(event.runId, "runId");
	if (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid factory timestamp.");
	const previous = currentRun(state);
	let run: Run;
	if (event.kind === "start") {
		for (const field of ["goal", "ownerSessionId", "sessionFile", "cwd", "scope"] as const) requireText(event[field], field);
		if (typeof event.note !== "string") throw new Error("Invalid run note.");
		if (state.runs.some((item) => item.id === event.runId)) throw new Error("Run ID already exists.");
		if (previous && !previous.finish && previous.ownerSessionId === event.ownerSessionId) {
			throw new Error("A factory run is already open. Update or finish it before starting another.");
		}
		run = {
			id: event.runId, goal: event.goal, ownerSessionId: event.ownerSessionId,
			sessionFile: event.sessionFile, cwd: event.cwd, scope: event.scope,
			phase: "running", note: event.note, createdAt: event.at, updatedAt: event.at, assignments: [],
		};
		return { runs: [...state.runs, run], events: [...state.events, event] };
	}
	if (!previous || previous.id !== event.runId) throw new Error("Event does not belong to the current factory run.");
	if (previous.finish) throw new Error("This run is finished. Start a new run for follow-up work.");
	run = structuredClone(previous);
	switch (event.kind) {
		case "assign": {
			for (const field of ["id", "name", "role", "task"] as const) requireText(event[field], field);
			requireEvidence(event.evidence ?? []);
			for (const field of ["paneId", "workspaceId", "terminalId", "sessionFile", "cwd"] as const) {
				requireText(event.agent?.[field], `agent.${field}`);
			}
			if (run.assignments.some((a) => a.id === event.id)) throw new Error("Assignment ID already exists; use a new ID for each handoff.");
			if (run.assignments.some((a) => isOpen(a) && a.agent.sessionFile === event.agent.sessionFile)) {
				throw new Error("That helper already has an open assignment. Acknowledge its outcome before reassigning it.");
			}
			run.assignments.push({
				id: event.id, name: event.name, role: event.role, task: event.task, agent: { ...event.agent },
				status: "active", note: event.task, evidence: [...event.evidence ?? []], createdAt: event.at, updatedAt: event.at,
			});
			run.note = `${event.name}: ${event.task}`;
			break;
		}
		case "update": {
			requireText(event.note, "note");
			requireEvidence(event.evidence);
			if (event.assignmentId) {
				if (event.phase !== undefined) throw new Error("Update a run phase separately from an assignment.");
				const assignment = getAssignment(run, event.assignmentId);
				if (!isOpen(assignment)) throw new Error("Assignment is already acknowledged. Create another assignment for follow-ups.");
				if (event.status !== undefined) {
					requireEnum(event.status, STATUSES, "assignment status");
					assignment.status = event.status;
				}
				assignment.note = event.note;
				assignment.evidence = [...assignment.evidence, ...event.evidence];
				assignment.updatedAt = event.at;
			} else {
				if (event.status !== undefined) throw new Error("An assignment ID is required for a status update.");
				if (event.phase !== undefined) {
					requireEnum(event.phase, PHASES, "phase");
					run.phase = event.phase;
				}
			}
			run.note = event.note;
			break;
		}
		case "observe": {
			requireEnum(event.state, RUNTIME_STATES, "runtime state");
			if (typeof event.detail !== "string") throw new Error("Invalid observation detail.");
			const assignment = getAssignment(run, event.assignmentId);
			if (!isOpen(assignment)) throw new Error("Cannot observe an acknowledged assignment.");
			assignment.observation = { state: event.state, detail: event.detail, at: event.at };
			break;
		}
		case "finish": {
			requireEnum(event.outcome, OUTCOMES, "outcome");
			requireText(event.summary, "summary");
			requireText(event.receipt, "receipt");
			requireEvidence(event.evidence);
			if (event.outcome === "completed" && run.assignments.some(isOpen)) {
				throw new Error("Acknowledge all assignment outcomes before reporting completion. Idle is not completed.");
			}
			run.finish = { outcome: event.outcome, summary: event.summary, evidence: [...event.evidence], at: event.at, receipt: event.receipt };
			break;
		}
		default: throw new Error("Unknown factory event; history was not reset.");
	}
	if (event.kind !== "observe") run.updatedAt = event.at;
	return { runs: [...state.runs.slice(0, -1), run], events: [...state.events, event] };
}

/** Use the active branch, NOT all entries in a session file. Compaction does not erase this history. */
export function replay(entries: readonly { type: string; customType?: string; data?: unknown }[]): FactoryState {
	let state = emptyState();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === EVENT_TYPE) state = applyEvent(state, entry.data as FactoryEvent);
	}
	return state;
}

export function getAssignment(run: Run, id: string): Assignment {
	const assignment = run.assignments.find((a) => a.id === id);
	if (!assignment) throw new Error(`Unknown assignment: ${id}`);
	return assignment;
}

export function attention(run: Run): string[] {
	if (run.finish) return [];
	if (run.phase === "waiting_user") return [`Waiting for you: ${run.note}`];
	const open = run.assignments.filter(isOpen);
	if (!open.length) return ["Closeout or next assignment needed; this run is still open."];
	return open.flatMap((a) => {
		if (a.status === "blocked") return [`${a.name} [${a.id}] reported blocked: ${a.note}`];
		const observation = a.observation;
		if (!observation) return [`${a.name} [${a.id}]: runtime not yet observed.`];
		if (observation.state === "working") return [];
		if (observation.state === "idle") return [`${a.name} [${a.id}] is idle; inspect delivery/result and acknowledge the outcome.`];
		return [`${a.name} [${a.id}]: ${observation.state}${observation.detail ? ` — ${observation.detail}` : ""}`];
	});
}

export function completionReceipt(run: Run, outcome: Outcome, summary: string, evidence: string[]): string {
	return [
		`Factory ${outcome} — ${run.goal}`, `Run: ${run.id}`, "", summary, "",
		...run.assignments.map((a) => `${a.name} · ${a.role} · ${a.id}: ${a.status} — ${a.note}${a.evidence.length ? `\n  ${a.evidence.join("; ")}` : ""}`),
		...evidence.map((item) => `Evidence / caveat: ${item}`),
		"", "Reported outcomes, not an independent correctness certification. Helpers/resources were not stopped or cleaned up.",
		`Audit source: ${run.sessionFile}`,
	].join("\n");
}

function requireText(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text.`);
}
function requireEvidence(value: unknown): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Evidence must be a list of text references.");
}
function requireEnum(value: unknown, values: readonly string[], label: string): void {
	if (typeof value !== "string" || !values.includes(value)) throw new Error(`Invalid ${label}.`);
}
