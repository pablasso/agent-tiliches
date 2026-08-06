# Codex usage

Tracks the account-level limits attached to Pi's `openai-codex` provider (the provider authenticated through **OpenAI Codex / ChatGPT login**, not the API-key `openai` provider).

## What it shows

- A compact footer status while an `openai-codex` model is selected: `Codex: 86%` for one limit, or every labeled limit when OpenAI reports multiple windows
- The server-reported 5-hour window, when present
- The server-reported weekly window, when present
- Reset countdowns, plan, credits, and named/model-specific limits through `/codex-usage`

OpenAI does not always return both windows. The extension classifies windows by their server-reported duration, so a lone 7-day window is shown as weekly rather than incorrectly labeled as the historical primary 5-hour window. Windows OpenAI does not return are omitted.

## Commands

```text
/codex-usage           Fetch and show current limits
/codex-usage refresh   Same, explicitly bypassing the in-memory observation
/codex-usage cached    Show the latest values observed in this Pi session
```

## How it works

1. Pi resolves and refreshes the existing `openai-codex` OAuth token through its model registry.
2. The extension requests `https://chatgpt.com/backend-api/wham/usage` with that token and account id.
3. It also passively reads `x-codex-*` headers from provider responses when Pi's transport exposes them.
4. For Codex WebSocket runs, whose HTTP response headers are not exposed to extensions, it refreshes the usage endpoint after the run.

The token is sent only to `chatgpt.com`; it is never logged or persisted by this extension. The usage endpoint and `x-codex-*` headers are private OpenAI interfaces and can change. The official fallback is <https://chatgpt.com/codex/settings/usage>.

## Request and token usage

The extension has no idle polling timer and does not call a model:

- It makes one small usage request when Pi opens with an `openai-codex` model selected.
- SSE model responses update usage from their existing `x-codex-*` headers, with no extra request.
- The default Codex WebSocket transport does not expose those headers, so the extension makes one usage request after the agent run settles. During a long multi-turn WebSocket run, it can refresh at turn boundaries, at most once per minute.
- `/codex-usage` explicitly makes a fresh request; `/codex-usage cached` does not once this session has observed usage.
- OAuth token refreshes and usage requests are account metadata operations, not model inference, so they consume no model tokens or Codex allowance.

If no `openai-codex` model is selected, the automatic paths make no requests. On a computer without an OpenAI Codex login, the extension remains inert; explicitly running `/codex-usage` only reports that no login is available.

Set `PI_CODEX_USAGE_DEBUG=1` to log background refresh errors. Interactive `/codex-usage` errors are always shown directly.
