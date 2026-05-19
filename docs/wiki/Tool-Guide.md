# Tool Guide

Use the intuitive front-door tools first.

| Task | Tool |
| --- | --- |
| One Codex task | `codex_task` |
| Several independent tasks | `codex_task_group` |
| Persistent session | `codex_task`, then `codex_followup` |
| Long-running session | `codex_task` with `background: true`, then `codex_followup` |
| Live steering | `codex_followup` with `mode: "steer"` |
| Diagnostics | Resources `codex://status`, `codex://doctor`, `codex://usage` |

## One Agent

```text
Ask Codex to review the MCP server read-only. Return the top reliability risks with file paths.
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
