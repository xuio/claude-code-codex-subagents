# Usage Guide

This guide is for people using the plugin from Claude Code or wiring it into a
Claude Code development workflow.

## Defaults

| Setting | Default |
| --- | --- |
| Codex binary | `/Applications/Codex.app/Contents/Resources/codex` when present, then configured overrides, then `codex` on `PATH` |
| Sandbox | `read-only` |
| Approvals | `approval_policy="never"` |
| Session protocol | `codex app-server --listen stdio://`, with `codex exec resume` fallback |
| Prompt delivery | stdin |
| Model | Codex account or config default unless a tool call supplies one |
| Reasoning effort | `medium` when a default is needed |
| Logging | verbose JSONL on stderr |

Claude should pass `project_dir` when Codex should inspect the same repository or
subdirectory that Claude is working in. If omitted, the server uses
`CLAUDE_PROJECT_DIR` when Claude Code provides it.

## Front-Door Tools

Prefer these tools in normal Claude usage:

- `ask_codex` - one blocking Codex task.
- `ask_codex_parallel` - several independent blocking Codex tasks.
- `run_agents_aggregate` - parallel tasks plus deterministic aggregation.
- `start_codex_session` - create a persistent session and wait for the first turn.
- `continue_codex_session` - send another prompt into an existing session.
- `start_codex_session_async` - start a persistent session and return immediately.
- `send_codex_session_prompt` - queue a normal follow-up prompt.
- `steer_codex_session` - steer the active app-server turn when supported.
- `get_codex_session` and `wait_codex_session` - inspect or wait on sessions.

Lower-level compatibility tools remain available:

- `run_agent`
- `run_agents`
- `start_agent_run`
- `start_agents_run`
- `get_agent_run`
- `wait_agent_run`
- `cancel_agent_run`
- `start_session`
- `send_session_prompt`
- `get_session`
- `list_sessions`
- `cancel_session`

Diagnostics tools:

- `codex_usage_guide`
- `codex_choose_tool`
- `codex_status`
- `codex_doctor`
- `codex_export_debug_bundle`

## Example: One Agent

Ask Claude:

```text
Use Codex to review the MCP server read-only. Return the top reliability risks with file paths and line references.
```

Representative tool arguments:

```json
{
  "task": "Review the MCP server read-only. Return the top reliability risks with file paths and line references.",
  "project_dir": "/path/to/project",
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

## Example: Parallel Agents

Ask Claude:

```text
Launch three read-only Codex subagents: API behavior, tests, and security. Compare their findings.
```

Representative tool arguments:

```json
{
  "tasks": [
    {
      "name": "api",
      "task": "Review MCP tool schemas and runtime behavior read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "tests",
      "task": "Review test coverage read-only. Identify missing scenarios with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "security",
      "task": "Review sandboxing, env forwarding, and logging read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    }
  ],
  "max_parallel": 3,
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

## Example: Persistent Session

Use a persistent session when Codex should keep context across prompts.

```json
{
  "task": "Investigate the session manager read-only. Keep a compact working map of the code.",
  "project_dir": "/path/to/project",
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

For a long-running first turn, use `start_codex_session_async`. Then:

```json
{
  "session_id": "session-...",
  "prompt": "Now focus on recovery after MCP restart. Cite the relevant code paths."
}
```

To steer an active app-server turn:

```json
{
  "session_id": "session-...",
  "steering_prompt": "Prioritize app-server recovery and ignore UI/documentation polish."
}
```

If `session.supportsRealSteering` is false, the session fell back to the exec
protocol and steering becomes a high-priority queued turn.

## Spark And Reasoning

Use `model_preset: "spark"` for fast, focused Codex work. Exact `model` still
wins when both `model` and `model_preset` are provided.

Recommended reasoning:

- `low` for small, tactical checks.
- `medium` for normal exploration and review.
- `high` or `xhigh` for complex architecture, correctness, or security analysis.

Avoid `minimal`. The plugin rejects it because the current Codex CLI can attach
tools that are incompatible with minimal reasoning.

Spark does not support `reasoning_summary`; with `model_preset: "spark"`, use
`reasoning_summary: "none"` or omit it.

## Nested Codex Subagents

To let a Codex parent agent launch Codex subagents, pass:

- `codex_subagents` - custom subagent definitions.
- `subagent_tasks` - the specific subagents the parent should spawn.
- `subagent_runtime` - limits such as `max_threads`, `max_depth`, and `job_max_runtime_seconds`.

Custom definitions are written into a temporary Codex home for that run. The
project directory is not modified.

## Full Access Mode

Default mode is read-only. If the user explicitly wants normal unrestricted Codex
capabilities, pass:

```json
{
  "dangerously_bypass_approvals_and_sandbox": true
}
```

This maps to Codex's `--dangerously-bypass-approvals-and-sandbox` flag and allows
DNS/network access, file writes, package installs, and git writes. Keep it scoped
to the specific tool call that needs it.

## Structured Output

Use `output_contract` when Claude needs machine-readable results:

- `review_findings`
- `plan`
- `risk_matrix`
- `patch_suggestions`

Use `output_schema` for a custom JSON Schema. The plugin passes the schema to
Codex, parses the final JSON message, and returns `structuredOutput`.

## MCP Config Sharing

MCP config sharing is explicit:

- `inherit_codex` - use the user's normal Codex config.
- `isolated` - use a temporary Codex home without inherited MCP servers.
- `explicit` - use only `codex_mcp_servers`.
- `inherit_claude_project` - import `.mcp.json` or `.claude/mcp.json` from `project_dir`.

Use `isolated_codex_home: true` when unrelated user-level Codex MCP servers should
not be loaded for the run.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `CODEX_SUBAGENTS_CODEX_BIN` | Explicit Codex CLI path |
| `CODEX_SUBAGENTS_DEFAULT_MODEL` | Default model when a tool call omits `model` |
| `CODEX_SUBAGENTS_DEFAULT_REASONING_EFFORT` | Default reasoning effort |
| `CODEX_SUBAGENTS_MAX_GLOBAL_PROCESSES` | Maximum Codex child processes across the server |
| `CODEX_SUBAGENTS_MAX_PROJECT_PROCESSES` | Maximum Codex child processes per project key |
| `CODEX_SUBAGENTS_MAX_QUEUE_PENDING` | Maximum queued one-shot/async tasks |
| `CODEX_SUBAGENTS_JOB_TTL_SECONDS` | Completed async job retention window |
| `CODEX_SUBAGENTS_MAX_SESSIONS` | Maximum retained persistent sessions |
| `CODEX_SUBAGENTS_MAX_SESSION_QUEUED_TURNS` | Maximum queued turns per session |
| `CODEX_SUBAGENTS_SESSION_COMPLETED_TTL_SECONDS` | Retention for failed/cancelled sessions |
| `CODEX_SUBAGENTS_SESSION_IDLE_TTL_SECONDS` | Retention for idle resumable sessions |
| `CODEX_SUBAGENTS_SESSION_STATE_FILE` | Durable session metadata path |
| `CODEX_SUBAGENTS_SESSION_PROTOCOL` | Set `exec` to force legacy exec sessions |
| `CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK` | Set `1` to fail instead of falling back to exec |
| `CODEX_SUBAGENTS_LOG_PROFILE` | `debug` or `production` |
| `CODEX_SUBAGENTS_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |
| `CODEX_SUBAGENTS_LOG_RAW_REDACT` | Set `1` to redact raw traffic logs |
| `CODEX_SUBAGENTS_LOG_FILE` | Optional JSONL log file path |
| `CODEX_SUBAGENTS_LOG_FILE_MAX_BYTES` | Rotate the log file after this size |
| `CODEX_SUBAGENTS_LOG_MAX_STRING_CHARS` | Maximum retained string payload per log field |
| `CODEX_SUBAGENTS_PROGRESS_HEARTBEAT_MS` | Progress heartbeat interval |
| `CODEX_SUBAGENTS_OUTPUT_ARTIFACTS` | Set `0` to disable output artifact files |
| `CODEX_SUBAGENTS_ARTIFACT_DIR` | Directory for retained output artifacts |
| `CODEX_SUBAGENTS_ARTIFACT_REDACT` | Set `0` to keep output artifacts unredacted |
| `CODEX_SUBAGENTS_KEEP_OUTPUT_ARTIFACTS` | Set `1` to retain artifacts even without truncation |
| `CODEX_SUBAGENTS_DIAGNOSTIC_EVENTS` | Number of recent diagnostic events retained |
| `CODEX_SUBAGENTS_DEBUG_BUNDLE_DIR` | Parent directory for debug bundles |
