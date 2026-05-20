# Architecture

`claude-code-codex-subagents` is a Claude Code plugin that exposes Codex through a
stdio MCP server. Claude Code owns the MCP process lifecycle; no separate daemon
needs to be installed or supervised.

```mermaid
flowchart LR
  Claude["Claude Code"] -->|"stdio MCP"| MCP["codex-subagents MCP server"]
  MCP --> Resolver["Codex binary resolver"]
  Resolver --> Desktop["Codex.app bundled binary"]
  Resolver --> Env["Configured binary"]
  Resolver --> Path["codex on PATH"]
  MCP --> Exec["codex exec"]
  MCP --> AppServer["codex app-server --listen stdio://"]
  AppServer --> Session["Persistent Codex thread"]
  Exec --> OneShot["One-shot or parallel agents"]
```

## Process Model

- Claude Code starts `dist/index.js` from the plugin manifest.
- The MCP server communicates with Claude over stdio.
- The server launches Codex child processes only when a tool call asks for work.
- One-shot tools use `codex exec`.
- Persistent sessions prefer `codex app-server --listen stdio://`.
- If app-server startup fails and fallback is allowed, session tools fall back to
  `codex exec resume`.

The app-server process is a child of the MCP server. When Claude shuts down the
MCP server, there is no background daemon left behind.

App-server threads are started as normal top-level Codex threads, not as nested
Codex subagent threads. When the Codex app-server supports `thread/name/set`, the
plugin best-effort names the thread from Claude's task label so the run is easy
to find in Codex Desktop history.

## Binary Resolution

The resolver checks candidates in this order:

1. Per-call `codex_bin`.
2. `CODEX_SUBAGENTS_CODEX_BIN`.
3. `/Applications/Codex.app/Contents/Resources/codex`.
4. `CODEX_BIN`.
5. `codex` on `PATH`.

The `codex://status` resource reports the resolved binary and source. The
tool-callable `codex_status` helper is hidden unless
`CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS=1`.

## Safety Boundary

The default command line uses read-only sandboxing and non-interactive approvals.
Prompt text is sent through stdin so task bodies do not appear in the process
argument list.

Nested subagent MCP/skills/extra config is written into a temporary Codex home
instead of being exposed through argv. The temp home is removed after the run.

Full access is available only when the tool call sets `full_access: true`.

## Sessions And Durability

Persistent sessions store resumable metadata in `CODEX_SUBAGENTS_SESSION_STATE_FILE`
or `~/.codex-subagents/sessions.json` by default. The persisted file contains
metadata needed to reattach to a Codex thread; prompt text and environment values
are not persisted.

After an MCP runtime shutdown, app-server sessions with a Codex thread id are
preserved as recoverable internally. The default Claude-facing flow is to keep the
`session_id` returned by `codex_task` and use `codex_followup` while the MCP
process is alive. `codex_task` returns that id for `background: true`,
`keep_session: true`, or failure cases; hidden debug tools can inspect
lower-level recovery state.

Async one-shot jobs are process-local and do not survive MCP restarts. Their tool
results advertise this limitation and recommend persistent sessions for recoverable
long-running work.

## Progress, Backpressure, And Retention

The server emits MCP progress notifications when the client supplies a progress
token. Long waits include heartbeat progress so Claude Code can keep the request
alive.

Background Codex sessions also expose `codex://sessions/{session_id}` resources.
Each resource carries a small in-memory milestone ring buffer and a compact
`last_result`; milestones are deliberately not persisted to durable session
state. The server sends `notifications/resources/updated` for queued turns, turn
starts, meaningful Codex output, terminal changes, and resource pruning. Updates
are debounced per session, while terminal changes flush immediately.

Global and per-project queue limits prevent Claude from flooding the MCP process.
When limits are exceeded, tools return structured recovery hints instead of
accepting unbounded work.

Completed jobs, idle sessions, and terminal sessions are pruned according to the
configured retention windows.

## Logging And Diagnostics

Verbose JSONL logging is on by default. Logs include raw MCP traffic, tool
arguments/results, progress events, queue and session lifecycle, and Codex
stdin/stdout/stderr traffic.

Diagnostic events are retained in memory and can be exported with
`codex_export_debug_bundle`. Log files and durable session state are written with
owner-only permissions.
