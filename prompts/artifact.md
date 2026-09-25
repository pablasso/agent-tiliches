---
description: Persist a focused outcome from this session as a durable artifact
argument-hint: "<what to preserve>"
---
Create a durable Markdown artifact based on this request:

$ARGUMENTS

Treat this request as the strict selection criterion for the artifact.

Write the artifact to the destination specified in the request. If no destination is specified, ask a concise clarifying question about where to save it before writing. Create the destination directory if it does not exist.

## Scope

Use the conversation and relevant repository material only as sources for reconstructing the focused subject. Do not summarize the session as a whole, recount the conversation chronologically, or include unrelated work.

If the request is too ambiguous to determine what belongs in the artifact, ask a concise clarifying question before writing.

The artifact is intended for a future agent that has no access to this conversation.

## Artifact requirements

1. Produce a self-contained synthesis, not a transcript summary.
2. Clearly distinguish, where applicable:
   - Established facts and findings
   - Decisions already made, including their rationale
   - Proposed designs that have not yet been approved
   - Constraints and invariants
   - Open questions, risks, and unresolved trade-offs
3. Include concrete references such as file paths, APIs, commands, source links, or examples where useful.
4. Preserve enough relevant detail for a future agent to continue without rediscovering the context.
5. Include implementation considerations and suggested next steps when relevant, but do not implement anything.
6. Omit irrelevant discussion, abandoned ideas, repetition, and conversational history.
7. Do not invent certainty. Explicitly label assumptions and confidence where appropriate.
8. Use only sections that add value; avoid empty boilerplate headings.

Begin with a clear, descriptive title.

Use the filename specified in the request. If no filename is specified, use:

`YYYY-MM-DD-<concise-descriptive-title>.md`

Do not overwrite an existing artifact unless explicitly instructed; choose a more specific title if necessary.

## Response after writing

After writing the file:

1. Report its path.
2. Paste the complete artifact contents verbatim so the user can review and provide feedback.
3. Then mention any unresolved issue, uncertainty, or suggested refinement that would be useful during review.
