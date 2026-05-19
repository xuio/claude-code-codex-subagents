# Tool Guide

Use the intuitive front-door tools first.

| Task | Tool |
| --- | --- |
| One Codex task | `ask_codex` |
| Several independent tasks | `ask_codex_parallel` |
| Parallel review with merged output | `run_agents_aggregate` |
| Persistent session | `start_codex_session`, `continue_codex_session` |
| Long-running session | `start_codex_session_async`, `send_codex_session_prompt`, `steer_codex_session`, `wait_codex_session` |
| Async one-shot job | `start_agent_run`, `get_agent_run`, `wait_agent_run`, `cancel_agent_run` |
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
