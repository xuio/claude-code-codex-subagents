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

- `codex_task` - one Task-like Codex subagent with an answer-first result.
- `codex_task_group` - several independent Task-like Codex subagents in parallel.
- `codex_followup` - continue, steer, wait on, or cancel the `session_id`
  returned by `codex_task` or `codex_task_group` when `background` or
  `keep_session` is used.

Legacy compatibility tools are hidden by default. Set
`CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS=1` only for older clients that still call
pre-refactor names such as `ask_codex`, `run_agent`, or `start_session`.

Diagnostic resources are available without cluttering the tool picker:

- `codex://usage`
- `codex://status`
- `codex://doctor`

Native tool responses are intentionally lean by default. For a single debugging
call, set `advanced.include_diagnostics: true` to include cwd/model/sandbox,
event summaries, command events, and compacted session state in the response.

Tool-callable diagnostics are hidden by default. Set
`CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS=1` only when a client needs:

- `codex_usage_guide`
- `codex_choose_tool`
- `codex_status`
- `codex_doctor`
- `codex_export_debug_bundle`

## Choosing The Right Tool

Use this decision path when writing prompts or debugging Claude tool choice:

| User intent | Best tool |
| --- | --- |
| One normal read-only second opinion | `codex_task` |
| Two or more independent workstreams | Multiple parallel `codex_task` calls, or `codex_task_group` for one rolled-up response |
| Same Codex agent should keep context | `codex_task` with `keep_session: true`, then `codex_followup` |
| Long first turn, user wants to keep working | `codex_task` with `background: true` |
| Add a normal follow-up to a running session | `codex_followup` with `mode: "queue"` |
| Redirect the active app-server turn | `codex_followup` with `mode: "steer"` |
| Wait for a background session | `codex_followup` with `mode: "wait"` |
| Stop a background or running session | `codex_followup` with `mode: "cancel"` |

When in doubt, read `codex://usage` and then choose among the three native tools.

## Example: One Agent

Ask Claude:

```text
Use Codex to review the MCP server read-only. Return the top reliability risks with file paths and line references.
```

Representative tool arguments:

```json
{
  "description": "Review MCP server reliability",
  "prompt": "Review the MCP server read-only. Return the top reliability risks with file paths and line references.",
  "project_dir": "/path/to/project",
  "reasoning": "medium"
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
      "description": "Review API behavior",
      "prompt": "Review MCP tool schemas and runtime behavior read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "tests",
      "description": "Review tests",
      "prompt": "Review test coverage read-only. Identify missing scenarios with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "security",
      "description": "Review security posture",
      "prompt": "Review sandboxing, env forwarding, and logging read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    }
  ],
  "max_parallel": 3,
  "reasoning": "medium"
}
```

## Example: Persistent Session

Use a persistent session when Codex should keep context across prompts.

```json
{
  "description": "Investigate session manager",
  "prompt": "Investigate the session manager read-only. Keep a compact working map of the code.",
  "project_dir": "/path/to/project",
  "reasoning": "medium",
  "keep_session": true
}
```

`codex_task` returns a `session_id` when `keep_session` is true. Then:

```json
{
  "session_id": "session-...",
  "mode": "queue",
  "prompt": "Now focus on recovery after MCP restart. Cite the relevant code paths."
}
```

To steer an active app-server turn:

```json
{
  "session_id": "session-...",
  "mode": "steer",
  "prompt": "Prioritize app-server recovery and ignore UI/documentation polish."
}
```

If `session.supportsRealSteering` is false, the session fell back to the exec
protocol and steering becomes a high-priority queued turn.

To stop a background or actively running session:

```json
{
  "session_id": "session-...",
  "mode": "cancel",
  "reason": "user changed direction"
}
```

The cancel response includes partial output if Codex streamed any before the
interrupt. Foreground `codex_task` calls are cancelled by Claude Code's normal
request interruption path, not by a tool call from the same in-flight turn.

## Spark And Reasoning

Do not use `advanced.model: "spark"` by default. Use Spark only when the user asks
for Spark or when a quick focused sidecar check is clearly more appropriate than
the default Codex model.

Recommended reasoning:

- `low` for small, tactical checks.
- `medium` for normal exploration and review.
- `high` or `xhigh` for complex architecture, correctness, or security analysis.

Avoid `minimal`. The plugin rejects it because the current Codex CLI can attach
tools that are incompatible with minimal reasoning.

Spark does not support `reasoning_summary`; with `advanced.model: "spark"`, use
`advanced.reasoning_summary: "none"` or omit it.

## Nested Codex Subagents

To let a Codex parent agent launch Codex subagents, pass:

- `advanced.codex_subagents` - custom subagent definitions.
- `advanced.subagent_tasks` - the specific subagents the parent should spawn.
- `advanced.subagent_runtime` - limits such as `max_threads`, `max_depth`, and `job_max_runtime_seconds`.

Custom definitions are written into a temporary Codex home for that run. The
project directory is not modified.

## Full Access Mode

Default mode is read-only. If the user explicitly wants normal unrestricted Codex
capabilities, pass:

```json
{
  "full_access": true
}
```

This maps to Codex's `--dangerously-bypass-approvals-and-sandbox` flag and allows
DNS/network access, file writes, package installs, and git writes. Keep it scoped
to the specific tool call that needs it.

`advanced.sandbox: "workspace-write"` is a narrower advanced mode for
project-scoped writes without DNS/network or arbitrary filesystem access. The
`patcher` role uses `workspace-write`; all other built-in roles stay read-only.
Responses include a `safety` block so callers can see which sandbox actually ran.

## Sharp Edges

See [Known limitations](KNOWN_LIMITATIONS.md) for the current operational sharp
edges. The most important ones:

- raw debug logs are sensitive
- async one-shot jobs are not durable across MCP restarts
- real steering requires app-server support
- full-access mode is intentionally dangerous

## Structured Output

Use `advanced.output_contract` when Claude needs machine-readable results:

- `review_findings`
- `plan`
- `risk_matrix`
- `patch_suggestions`

Use `advanced.output_schema` for a custom JSON Schema. The plugin passes the schema to
Codex, parses the final JSON message, and returns `structuredOutput`.

## MCP Config Sharing

MCP config sharing is explicit:

- `inherit_codex` - use the user's normal Codex config.
- `isolated` - use a temporary Codex home without inherited MCP servers.
- `explicit` - use only `advanced.codex_mcp_servers`.
- `inherit_claude_project` - import `.mcp.json` or `.claude/mcp.json` from `project_dir`.

Use `advanced.isolated_codex_home: true` when unrelated user-level Codex MCP
servers should not be loaded for the run.

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
| `CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS` | Set `1` to expose tool-callable diagnostics |
| `CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS` | Set `1` to expose pre-refactor compatibility tools |
| `CODEX_SUBAGENTS_OUTPUT_ARTIFACTS` | Set `0` to disable output artifact files |
| `CODEX_SUBAGENTS_ARTIFACT_DIR` | Directory for retained output artifacts |
| `CODEX_SUBAGENTS_ARTIFACT_REDACT` | Set `0` to keep output artifacts unredacted |
| `CODEX_SUBAGENTS_KEEP_OUTPUT_ARTIFACTS` | Set `1` to retain artifacts even without truncation |
| `CODEX_SUBAGENTS_DIAGNOSTIC_EVENTS` | Number of recent diagnostic events retained |
| `CODEX_SUBAGENTS_DEBUG_BUNDLE_DIR` | Parent directory for debug bundles |
