# Known Limitations

The plugin is read-only by default, but several behaviors are intentionally sharp
because this is a local Claude/Codex power-user tool.

## Raw Logs Are Sensitive

The default debug profile logs raw MCP traffic, tool arguments/results, prompts,
and Codex stdin/stdout/stderr. Use `CODEX_SUBAGENTS_LOG_PROFILE=production` for
normal work, or `CODEX_SUBAGENTS_LOG_LEVEL=silent` to disable logging.

## Async Jobs Are Not Durable

`start_agent_run` and `start_agents_run` are process-local. Use
`start_codex_session_async` when the work should be recoverable after restart.

## Steering Requires App-Server

Live steering requires `supportsRealSteering: true`. If Codex falls back to the
exec protocol, steering becomes a high-priority queued turn.

## Full Access Is Dangerous

Full local access requires `dangerously_bypass_approvals_and_sandbox: true`. It
can write files, mutate git state, use network/DNS, and install packages.

