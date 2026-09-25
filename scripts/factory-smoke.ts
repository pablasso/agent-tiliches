import { strict as assert } from "node:assert";
import {
	applyEvent, attention, completionReceipt, currentRun, emptyState, EVENT_TYPE, replay,
	type AgentRef, type FactoryEvent, type FactoryState,
} from "../extensions/factory/core.ts";

const at = "2026-01-01T00:00:00.000Z";
const agent: AgentRef = {
	paneId: "w1:p2", workspaceId: "w1", terminalId: "term-a", handle: "lucia-test",
	sessionFile: "/tmp/fictional-lucia.jsonl", cwd: "/tmp/fictional-project",
};
const start: FactoryEvent = {
	version: 1, kind: "start", runId: "run-1", at, goal: "Fictional editor",
	ownerSessionId: "parent-1", sessionFile: "/tmp/fictional-parent.jsonl", cwd: agent.cwd, scope: "test-host:test-socket", note: "Approved plan",
};
const assign: FactoryEvent = {
	version: 1, kind: "assign", runId: start.runId, at, id: "editor", name: "Lucía", role: "implementor", task: "Implement editor", agent,
};
let state = applyEvent(emptyState(), start);
state = applyEvent(state, assign);
assert.throws(() => applyEvent(state, { ...start, runId: "run-2" }), /already open/);
assert.throws(() => applyEvent(state, assign), /already exists/);
assert.throws(() => applyEvent(state, { ...assign, id: "another" }), /already has an open assignment/);
const original = state;
state = applyEvent(state, { version: 1, kind: "observe", runId: start.runId, at: "2026-01-01T00:01:00.000Z", assignmentId: "editor", state: "working", detail: "" });
assert.equal(original.runs[0].assignments[0].observation, undefined, "Reducer must not mutate previous state");
assert.equal(currentRun(state)!.updatedAt, at, "Liveness observations are not meaningful progress");
assert.deepEqual(attention(currentRun(state)!), []);
state = applyEvent(state, { version: 1, kind: "observe", runId: start.runId, at, assignmentId: "editor", state: "idle", detail: "" });
assert.equal(currentRun(state)!.assignments[0].status, "active", "Idle must never imply completion");
assert.match(attention(currentRun(state)!).join("\n"), /acknowledge/);
const finish: FactoryEvent = { version: 1, kind: "finish", runId: start.runId, at, outcome: "completed", summary: "Implemented", evidence: ["tests passed"], receipt: "receipt" };
assert.throws(() => applyEvent(state, finish), /Acknowledge all/);
state = applyEvent(state, { version: 1, kind: "update", runId: start.runId, at, phase: "waiting_user", note: "Approve dependency patch", evidence: [] });
assert.deepEqual(attention(currentRun(state)!), ["Waiting for you: Approve dependency patch"]);
state = applyEvent(state, { version: 1, kind: "update", runId: start.runId, at, phase: "running", note: "Patch approved", evidence: [] });
state = applyEvent(state, { version: 1, kind: "update", runId: start.runId, at, assignmentId: "editor", status: "completed", note: "Editor committed", evidence: ["commit abc123; 10 tests passed"] });
assert.match(attention(currentRun(state)!).join("\n"), /Closeout/);
const priorBranch = structuredClone(state);
// Reuse the same helper for a DIFFERENT assignment; retain both outcomes.
state = applyEvent(state, { ...assign, id: "patch", task: "Patch typography" });
assert.equal(currentRun(state)!.assignments.length, 2);
state = applyEvent(state, { version: 1, kind: "update", runId: start.runId, at, assignmentId: "patch", status: "blocked", note: "Needs approval", evidence: [] });
assert.throws(() => applyEvent(state, finish), /Acknowledge all/);
state = applyEvent(state, { version: 1, kind: "update", runId: start.runId, at, assignmentId: "patch", status: "cancelled", note: "User deferred patch", evidence: [] });
const receipt = completionReceipt(currentRun(state)!, "completed", "Editor ready; patch deferred", ["Review skipped: bounded change"]);
assert.match(receipt, /Lucía · implementor · editor: completed/);
assert.match(receipt, /patch: cancelled/);
assert.match(receipt, /Review skipped/);
state = applyEvent(state, { ...finish, receipt });
assert.deepEqual(attention(currentRun(state)!), []);
assert.throws(() => applyEvent(state, assign), /finished/);
state = applyEvent(state, { ...start, runId: "run-2", goal: "Developer workflow" });
assert.equal(state.runs.length, 2);
assert.equal(currentRun(state)!.assignments.length, 0);

const entries = (source: FactoryState) => source.events.map((data) => ({ type: "custom", customType: EVENT_TYPE, data }));
assert.deepEqual(replay(entries(state)), state);
assert.deepEqual(replay([...entries(state), { type: "compaction" }, { type: "message" }]), state, "Compaction doesn't erase native custom entries");
assert.deepEqual(replay(entries(priorBranch)), priorBranch, "Restore only selected branch, not abandoned histories");
assert.throws(() => replay([{ type: "custom", customType: EVENT_TYPE, data: { version: 99 } }]), /Unsupported/);
assert.throws(() => applyEvent(priorBranch, { ...finish, outcome: "invented" } as never), /Invalid outcome/);
// A fork can begin a new owned run without mutating the original session's inherited run.
const forked = applyEvent(priorBranch, { ...start, runId: "fork-run", ownerSessionId: "fork-owner" });
assert.equal(currentRun(forked)!.ownerSessionId, "fork-owner");
assert.equal(priorBranch.runs[0].finish, undefined);

console.log("factory core smoke ok");
