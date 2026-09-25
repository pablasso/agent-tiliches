import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import type { AgentRef, Observation } from "./core.ts";

export interface LiveAgent extends AgentRef {
	kind: string;
	state: Observation["state"];
}
export type Exec = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number }) => Promise<{
	stdout: string; stderr: string; code: number; killed: boolean;
}>;

export function herdrScope(env: NodeJS.ProcessEnv = process.env): string {
	if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH) {
		throw new Error("Factory monitoring requires HERDR_ENV=1 and the inherited HERDR_SOCKET_PATH. No other session was inspected.");
	}
	return `${hostname()}:${env.HERDR_SOCKET_PATH}`;
}

/** The monitor's entire Herdr surface: one read-only JSON inventory. No shell parsing or terminal input. */
export async function listAgents(exec: Exec, expectedScope: string, signal?: AbortSignal): Promise<LiveAgent[]> {
	if (herdrScope() !== expectedScope) throw new Error("Herdr host/socket differs from the recorded run; monitoring is unavailable here.");
	const result = await exec("herdr", ["agent", "list"], { signal, timeout: 5_000 });
	if (result.killed || result.code !== 0) throw new Error(`Herdr status check failed${result.killed ? " or timed out" : ""}.`);
	return parseAgents(result.stdout);
}

export function parseAgents(stdout: string): LiveAgent[] {
	const payload = JSON.parse(stdout);
	if (payload?.result?.type !== "agent_list" || !Array.isArray(payload.result.agents)) throw new Error("Unexpected Herdr agent-list response.");
	return payload.result.agents.map((row: Record<string, unknown>) => {
		if (!row || ["pane_id", "workspace_id", "terminal_id"].some((key) => typeof row[key] !== "string" || !row[key])) {
			throw new Error("Incomplete Herdr inventory; not treating unrecognized entries as missing agents.");
		}
		const session = row.agent_session as { kind?: string; value?: string } | undefined;
		const sessionFile = session?.kind === "path" && typeof session.value === "string" ? session.value : "";
		const state = row.agent_status === "done" ? "idle" : row.agent_status;
		return {
			paneId: row.pane_id as string, workspaceId: row.workspace_id as string, terminalId: row.terminal_id as string,
			handle: typeof row.name === "string" ? row.name : undefined,
			kind: typeof row.agent === "string" ? row.agent : "unknown",
			sessionFile, cwd: typeof row.cwd === "string" ? row.cwd : "",
			state: (["working", "idle", "blocked"] as unknown[]).includes(state) ? state as LiveAgent["state"] : "unknown",
		};
	});
}

export function bindAgent(agents: LiveAgent[], target: string): AgentRef {
	const matches = agents.filter((a) => a.handle === target || a.paneId === target);
	if (matches.length !== 1) throw new Error(`Expected one live agent matching ${target}; found ${matches.length}.`);
	const agent = matches[0];
	if (agent.kind !== "pi" || !isAbsolute(agent.sessionFile) || !agent.cwd) {
		throw new Error("The helper must be Pi and report its absolute session file and checkout before registration. Inspect its setup, then retry.");
	}
	const { kind: _kind, state: _state, ...ref } = agent;
	return ref;
}

export function observeAgent(ref: AgentRef, agents: LiveAgent[]): Omit<Observation, "at"> {
	// Moving a pane is okay; replacing its process/session is not the same assignment.
	const current = agents.find((a) => a.terminalId === ref.terminalId && a.sessionFile === ref.sessionFile && a.kind === "pi");
	if (current) return { state: current.state, detail: current.paneId === ref.paneId ? "" : `Moved to ${current.paneId}` };
	if (agents.some((a) => a.paneId === ref.paneId || a.terminalId === ref.terminalId)) {
		return { state: "unknown", detail: "Helper session/occupant changed; replacement was not adopted." };
	}
	return { state: "missing", detail: "Registered helper is no longer in Herdr's live inventory." };
}
