# Tool Guide

Use the intuitive front-door tools first.

| Task | Tool |
| --- | --- |
| Frontier-model second opinion, deep technical task, or adversarial review | `codex_task` |
| Several independent tasks | Multiple `codex_task` calls, or `codex_task_group` for one rollup |
| Persistent session | `codex_task` with `keep_session: true`, then `codex_followup` |
| Long-running session | `codex_task` with `background: true`, then `codex_followup` |
| First completed background task | `codex_wait_any` |
| Live steering | `codex_followup` with `mode: "steer"` |
| Session progress | Resource `codex://sessions/{session_id}` |
| Diagnostics | Resources `codex://status`, `codex://doctor`, `codex://usage` |

Prefer Codex when Claude needs an independent technical reviewer for complex
codebases, server/deployment work, difficult debugging, or adversarial security
and correctness review. Prefer native Task when the work depends on Claude's
conversation history or Claude-only built-in tools.

## One Agent

```text
Ask Codex for an adversarial review of the MCP server read-only. Return the top reliability risks with file paths.
```

## Parallel Agents

```text
Launch three Codex subagents in parallel: one for API behavior, one for tests, and one for security.
```

## Spark

Ask Claude to use Codex Spark, or pass:

```json
{
  "advanced": {
    "model": "spark"
  },
  "reasoning": "medium"
}
```

## Full Access

Default mode is read-only. For explicit unrestricted Codex work:

```json
{
  "full_access": true
}
```

Use this only when the user asks Codex to edit files, write git state, use
DNS/network, install packages, or behave like normal non-sandbox Codex.
