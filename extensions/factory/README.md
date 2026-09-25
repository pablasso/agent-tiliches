# Factory

Small, local monitoring for `/implement`: a persistent widget beside the editor, an assignment/event log in Pi's existing session file, and code-based waiting instead of model-driven polling.

**This is an observer, not an orchestration engine.** It never launches, prompts, interrupts, merges, cleans up, or makes model calls. The orchestrator still makes decisions and delegates through Herdr.

## Requirements and use

- Pi **0.87+**, including custom entry renderers and `agent_settled`.
- A saved Pi session, running inside Herdr with its inherited `HERDR_ENV=1` and `HERDR_SOCKET_PATH`.
- This package loaded; run `/reload` after updating it.

Use `/implement <what to implement and where its context lives>` as usual. It still proposes a plan and waits for your approval. After approval it starts a monitored run and registers helpers.

The widget does not take keyboard focus or replace the conversation. Up to four open assignments are shown, with reported task status, observed runtime status, and the age of the last meaningful update.

| Command | Effect |
| --- | --- |
| `/factory` | Put current status, assignments, helper session paths, and run IDs in the transcript. |
| `/factory log` | Show the latest run's event timeline (last 100 events; full history stays in the session). |
| `/factory hide` / `/factory show` | Hide/show the widget without changing monitoring. |
| `/factory cancel-wait` | Release the orchestrator's pending wait, including while a status query is in flight. Helpers and monitoring are unchanged. |

These commands do not invoke a model. Escape/aborting the agent can also cancel its wait. While waiting you can still use the editor; cancel the wait if you want to interrupt the waiting step rather than queue input.

## Agent-facing tool protocol

There is one `factory` tool. All actions after `start`, except `status`, require its returned `runId`.

| Action | Required fields / behavior |
| --- | --- |
| `start` | `goal`; optional `note` with approved plan/review strategy. One open owned run per session branch. |
| `assign` | `assignmentId`, `name`, `role`, `task`, `target` (live Herdr handle or pane); optional `evidence`. Captures the helper's session and location. Does not dispatch work. |
| `update` | `note`; optionally `assignmentId` and `status`, or run-level `phase`; optional `evidence`. |
| `wait` | Wait locally for a helper to need attention. Optional `timeoutSeconds` (1–3600); otherwise wait until attention or cancellation. |
| `finish` | `outcome`, final summary in `note`, optional `evidence`. Emits a durable transcript receipt and notification without another model call. |
| `status` | Read current state, or a historical `runId` on the current branch. |

Assignment status is `active`, `blocked`, `completed`, or `cancelled`. Run phase is `running` or `waiting_user`. Finish outcomes are `completed`, `blocked`, or `cancelled`.

Typical sequence:

1. After approval, `start` and retain the run ID.
2. Launch a helper normally through Herdr. `assign` it with a fresh assignment ID and bounded task; include branch/base/review rationale in `evidence`.
3. Dispatch using `herdr agent prompt` **without `--wait` for this workflow**; then call `factory` with `action: "wait"`.
4. Inspect substantive results when it returns. A fast idle result may mean the prompt did not start, not that work finished. Never blindly resubmit it.
5. `update` the assignment outcome with actual commits/checks and review disposition. Acknowledge it before assigning that helper another task. Reassignments use new assignment IDs.
6. Record decisions only at meaningful milestones. Use `waiting_user` for approval pauses and return to `running` after approval. Do not ask helpers to send progress heartbeats.
7. When all outcomes and integration are handled, `finish`. A later feature/follow-up starts another run, even in the same conversation.

`completed` is rejected while assignments remain active/blocked. Outcomes are **reported by the orchestrator**, not independently verified by the extension. The receipt preserves names, assignments, outcomes, evidence, and caveats. It is not a correctness certification.

`finish` ends monitoring, even for blocked/cancelled runs; it does not stop any helper. Use `waiting_user`, not `finish`, for ordinary pauses. Cleanup remains explicitly requested and performed through the existing Herdr workflow.

## Runtime observations and missing closure

While an owned run is open, the extension polls `herdr agent list` every five seconds, with one request at a time and a five-second request timeout. Only registered open assignments contribute events; unrelated inventory is not stored. Only changes are appended, not poll heartbeats.

- `working`, `idle`, `blocked`, `unknown`, `missing`, and `unavailable` describe **observations**, not task outcomes. Herdr's `done` is normalized to input-ready `idle`.
- Bindings include host/socket, terminal identity, and Pi session path. Moving the original pane is supported; a replacement session is not silently adopted. Other Herdr sessions are never inspected as a fallback.
- Resume starts with runtime observations marked unrefreshed until a new check. A missing/unreachable helper never becomes successful.
- A settled orchestrator with pending idle/blocked/unavailable helpers, or no remaining assignments but an open run, gets a deduplicated attention notification. Explicit approval pauses suppress these warnings.
- The extension never auto-wakes the model to repair a missed closeout. It makes missing closure visible. It cannot infer delivery or correctness from runtime readiness.

## Persistence and auditing

Version-1 `factory-event` custom entries in the **orchestrator's native session JSONL** are the only run store. They are excluded from model context. The widget reconstructs from the current branch, including across compaction, reload, and resume. Unsupported/corrupt history is reported rather than silently reset.

Forked/cloned sessions may inspect inherited runs but cannot mutate or monitor them; start a new owned run in the new session. Monitoring exists only while the owning Pi process is running—there is no daemon. No helper instrumentation, database, web UI, periodic auditor, cost dashboard, or shared append file is required.

Open a separate interactive Pi tab and invoke:

```text
/audit-factory <orchestrator-session-path> <run-id>
```

Find those references through `/factory` or the completion receipt. The [auditor prompt](../../prompts/audit-factory.md) reads that run and its relevant helper sessions, proposes at most three evidence-backed process findings, and recommends one experiment. It does not start agents, change the workflow, or run another code review. Legacy sessions without Factory events can also be audited, with inferred boundaries explicitly labeled.

Session files can contain sensitive project/user data. Keep them local; do not commit or upload them. The smoke tests use synthetic data only.

## Checks

`npm run check` includes ledger replay, assignment handoffs, approval pauses, runtime identity/failure handling, cancellable waits, deduplication, completion receipts, narrow rendering, reload/branch/fork behavior, and real extension handlers with a mocked Herdr inventory. Tests never launch or touch live helpers.
