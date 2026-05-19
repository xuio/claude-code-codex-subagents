# Tool Guide

Use the intuitive front-door tools first.

| Task | Tool |
| --- | --- |
| One Codex task | `codex_task` |
| Several independent tasks | `codex_task_group` |
| Persistent session | `codex_session_start`, `codex_session_prompt` |
| Long-running session | `codex_session_start`, `codex_session_status`, `codex_session_wait`, `codex_session_steer` |
| Session lifecycle | `codex_sessions`, `codex_session_recover`, `codex_session_cancel` |
| Diagnostics | `codex_status`, `codex_doctor`, `codex_export_debug_bundle` |

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
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

## Full Access

Default mode is read-only. For explicit unrestricted Codex work:

```json
{
  "dangerously_bypass_approvals_and_sandbox": true
}
```

Use this only when the user asks Codex to edit files, write git state, use
DNS/network, install packages, or behave like normal non-sandbox Codex.
