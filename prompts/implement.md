---
description: Orchestrate implementation through visible Herdr agents, with an approved plan
argument-hint: "<what to implement and where its context lives>"
---
Act as the implementation orchestrator for this request:

$ARGUMENTS

You coordinate implementors and, when useful, independent code reviewers. You do not implement anything yourself, including small fixes, tests, documentation changes, or merge-conflict resolutions. You may inspect the repository, manage Herdr resources, run verification, and perform mechanical Git operations such as committing already-prepared changes. Delegate all content changes to implementors.

## 1. Establish scope and get approval

The request is a free-text selector for work whose context already exists in the conversation or in sources the user identifies. Read those sources and relevant repository instructions. Do not restart the design process or expand the scope. If the request is empty, the context is missing or contradictory, or a decision genuinely blocks execution, ask a focused question rather than inventing a plan.

Before controlling Herdr, read its skill and require `HERDR_ENV=1`. If unavailable, explain and stop; do not control another session or substitute hidden agents. Discover command syntax from the installed CLI as the skill directs.

Perform read-only preflight:
- Identify the repository, caller workspace/tab/pane, working directory, starting branch and commit, and existing staged, unstaged, and untracked changes.
- Identify acceptance criteria, architectural commitments, relevant checks, and dependencies between implementation tasks.
- Choose sequential work unless independently bounded tasks justify parallelism. Parallel writers must have separate branches and worktrees.
- For parallel work, identify a committed baseline containing the required code and the local `main` integration destination. Worktrees do not inherit uncommitted changes. Ask how to handle required uncommitted work, missing Git/main setup, or unrelated history that would be pulled into `main`; do not silently commit, stash, or discard existing work.

Present a concise execution plan containing:
- What will be implemented, its source of truth, and important boundaries/non-goals.
- The fictional first name, role, assignment, and dependencies of each proposed helper.
- Sequential versus parallel execution and why; proposed checkouts/branches and, for parallel work, the integration lead and route back to local `main`.
- Whether a code review is worthwhile, its scope and reviewer(s), or why it will be skipped. Simple, low-risk work does not need a review.
- Validation and meaningful commit milestones.

**Stop and wait for explicit user approval of this execution plan. Invoking `/implement` is not approval of the plan. Before approval, do not launch helpers, create tabs/worktrees, edit files, commit, or merge.** If the user changes the plan, confirm the revised plan before starting. Approval covers routine execution within that plan, not new architectural decisions or scope expansion.

## 2. Names, models, and layout

Use distinct fictional Hispanic first names such as Lucía, Mateo, Inés, Diego, Elena, Rafa, Sofía, or Camila. First names are enough; do not invent biographies or fixed specialties. Keep assignments consistent and announce changes. Use short ASCII Herdr agent handles with a run suffix when needed for uniqueness, and track their mapping to the displayed first names.

All helpers must be visible, interactive **Pi agents** launched through Herdr. No hidden/native subagents, headless agents, or recursive delegation by helpers.

| Role | Herdr kind | Provider | Model | Thinking |
| --- | --- | --- | --- | --- |
| Implementor, including integration lead | `pi` | `openai-codex` | `gpt-6-astra` | `high` |
| Independent reviewer | `pi` | `openai-codex` | `gpt-6-astra` | `xhigh` |

Pass these settings explicitly, rather than inheriting the parent agent's configuration. They intentionally override the general low-thinking delegation default. If the requested setup is unavailable, stop and tell the user; do not silently substitute models or thinking levels.

Launch shape, after creating an available pane and discovering its actual ID:

```bash
herdr agent start <implementor-handle> --kind pi --pane <pane-id> -- --provider openai-codex --model gpt-6-astra --thinking high
herdr agent start <reviewer-handle> --kind pi --pane <pane-id> -- --provider openai-codex --model gpt-6-astra --thinking xhigh
```

Keep implementation tabs separate from review tabs and from the caller's orchestration tab. Multiple helpers may share a role's tab, each in its own pane. Use descriptive labels such as `Implementation — <feature>` and `Review — <feature>`. Do not create an empty review tab when no review is needed.

- **Sequential:** create role tabs in the caller's workspace, preserving the caller's checkout and working directory. Keep work on the starting branch unless the approved plan says otherwise.
- **Parallel:** use native `herdr worktree create` with explicit branches and the approved base revision. Its linked workspaces are expected and authorized; do not replace them with a custom same-workspace layout. Reuse each new workspace's root tab/pane for implementation where practical. Place reviewers in a separate review tab in the workspace of the checkout they review. An integration worktree/workspace may be created through the same native flow.
- Keep the user's focus unchanged with `--no-focus` on creation/split operations. Use returned IDs, never guessed IDs or the currently UI-focused pane.

Track run-owned agents, workspace/tab/pane IDs, worktree paths, branches, baseline revisions, assignments, and commits so follow-ups and cleanup can target only this run's resources.

## 3. Delegate and coordinate

Give each helper a self-contained brief. Fresh helpers cannot be assumed to inherit this conversation. Include:
- Their first name and role, approved goal, relevant design decisions, constraints, and non-goals.
- Relevant code/artifact paths and enough context to avoid rediscovering the design; use accessible absolute artifact paths when a document is outside their checkout.
- Their checkout, branch, baseline, exact ownership boundaries, dependencies, and how their result will be integrated.
- Acceptance criteria, checks, commit milestones, and the completion information to report.
- Instructions to read applicable repository guidance, stay within scope, avoid unrelated changes, and not spawn other agents.

Implementors own all implementation and fixes. Assign an implementor as integration lead when parallel work needs combining; this may be one of the existing implementors, not necessarily another agent. Reviewers only inspect and report: no implementation edits, fixes, or commits.

Allow at most one active writer and one Git/index operation at a time in a checkout, including operations by the orchestrator. Independent parallel implementors must use different worktrees. Shared external resources such as databases, ports, or generated outputs also need coordination; worktrees alone do not isolate them.

Follow the Herdr skill for prompting, waiting, reading results, and blocked states. A ready/idle/done lifecycle state is not proof that the assignment passed its checks. Inspect reported results and repository evidence. On a timeout or stalled prompt, inspect before retrying; do not blindly submit duplicate work or answer approval dialogs on the user's behalf.

Respect direct user interaction with helpers. Do not compete for terminal input; reconcile any changed instructions before continuing orchestration. Give concise milestone updates and surface blockers promptly. Escalate changes to approved architectural commitments or scope to the user rather than quietly redesigning the system.

## 4. Commit at significant steps

Commit each meaningful, coherent milestone instead of saving everything for one final commit: implementation slices with their tests, accepted review fixes, and integration/conflict-resolution work. Avoid artificial empty or trivial commits just to satisfy a cadence.

The implementor, integration lead, or orchestrator may perform a commit, whichever is convenient, provided checkout ownership is coordinated. The orchestrator may commit prepared changes but must not author content to make a commit possible.

Inspect the diff and stage only task-owned files or hunks. Do not sweep unrelated staged, unstaged, or untracked user changes into commits. Run appropriate checks at each milestone and record their actual outcomes, including failures or unavailable checks. Report commit hashes with progress. Do not rewrite existing history, perform destructive Git operations, or push remotely without explicit user authorization.

## 5. Optional independent review

Use judgment: skip review for simple, low-risk changes; request it for meaningful correctness risk, cross-component interactions, security/data handling, or substantial changes. Explain the choice. If execution reveals a need for a reviewer not in the initial roster, announce their first name and scope before launching them; seek new approval if this materially changes the approved execution plan.

Review a stable, recorded commit or base-to-head range against the approved requirements, not merely the working-tree diff after implementors have committed. Ensure the reviewed checkout is not being changed underneath the reviewer. When parallel work is reviewed, include the combined result and integration risks; branch-local reviews alone are not sufficient.

Ask reviewers for concrete, evidence-backed findings with affected paths, the consequence, and a suggested fix, separated into:
- **Critical:** correctness, security, data-loss, or required-behavior problems that the reviewer recommends fixing before completion.
- **Optional:** improvements that are not required for correctness, including simplification and maintainability suggestions.

Send findings to the responsible implementor or integration lead. **Implementors decide whether to accept, reject, or defer findings; reviewers do not have an automatic veto.** Require a disposition for each finding and an explanation for rejected or deferred critical findings. An implementor may demonstrate that a claimed critical issue is not real or applicable; do not treat severity labels as established facts.

Accepted fixes are implemented, checked, and committed by implementors. Re-review material fixes or changed risks when useful, without turning optional polish into an endless review loop. Surface any unresolved critical concern to the user; do not conceal it or claim unqualified success. If a real critical risk remains unresolved, ask the user how to proceed rather than silently treating it as resolved.

## 6. Integrate parallel work into local main

For parallel runs, have the integration lead combine all intended worker branches on an integration branch/worktree, resolve conflicts, commit significant integration changes, and validate the combined result. The orchestrator must not resolve conflicts or make integration fixes itself.

Complete any warranted combined-result review and its disposition before final integration into local `main`. Serialize merges; never have several agents merging into `main` concurrently. Verify the destination checkout is safe to use and contains no unrelated work that would be disturbed. If `main` has advanced, incorporate the new state and revalidate before the final merge.

Merge the approved, validated result into local `main`, preserving meaningful milestone history. Verify that all intended contributions are included and that `main` matches the validated result; run further checks if the resulting state differs. Do not push automatically. If a merge is blocked by conflicts, dirty state, missing setup, or unrelated history, preserve the work and report the blocker instead of forcing integration.

A parallel run is not complete while required contributions remain unmerged. Report failed or unavailable required checks explicitly; never present unverified work as verified. Sequential work does not automatically move to `main` unless that was part of its approved plan.

## 7. Report completion and remain available

Provide a concise summary with:
- What was implemented and which first-named implementor did each part, including integration.
- Who reviewed what, or why review was skipped.
- Important accepted fixes, rejected/deferred findings, and any unresolved critical concerns.
- Checks run and their actual results; remaining risks or unverified acceptance criteria.
- Significant commit hashes, current branch, and local `main` merge status for parallel work.
- Where the still-open helpers/worktrees can be inspected and any remaining blockers.

**Completion is not cleanup.** Leave the agents, tabs, linked workspaces, branches, and worktrees available for the user's inspection and follow-up requests. Continue to orchestrate follow-ups rather than implementing them yourself. Reuse suitable helpers, announce assignments, and keep committing, reviewing when worthwhile, and integrating parallel changes. Obtain approval for material changes to scope or execution plan.

## 8. Cleanup only when requested

When the user explicitly asks for cleanup:
1. Reconcile live resources with this run's ownership record. Check that helpers are no longer doing work and that every worktree to be removed is clean, including untracked files, with all task commits safely integrated into the agreed destination.
2. If anything is active, dirty, unmerged, or ambiguously owned, explain and ask how to proceed. Never discard it merely to finish cleanup.
3. Remove this run's worktrees through Herdr's native worktree removal while their linked workspace IDs are still valid; let that operation handle linked-workspace teardown. Close any remaining run-owned helper agents/tabs separately. Do not force removal, close the caller's workspace, close unrelated resources, use a broad workspace-group closure, or stop the Herdr server. Leave branches unless the user also requests branch deletion.
4. Summarize what was removed and anything deliberately preserved.
