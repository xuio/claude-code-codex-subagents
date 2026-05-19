# Known Limitations

This project is designed to be conservative by default, but several behaviors are
intentionally sharp because the goal is deep Claude/Codex debugging and local
power-user workflows.

## Raw Debug Logging Is Sensitive

The default debug profile logs raw MCP traffic, tool arguments/results, prompt
text, progress events, and Codex stdin/stdout/stderr traffic. Treat these logs and
debug bundles as sensitive project data.

Use quieter logging for normal work:

```sh
export CODEX_SUBAGENTS_LOG_PROFILE=production
```

Disable logging entirely:

```sh
export CODEX_SUBAGENTS_LOG_LEVEL=silent
```

## Legacy Async Jobs Are Not Durable

Legacy async one-shot jobs are process-local. They keep Claude responsive during
long one-shot work, but they do not survive MCP process restart. These legacy
tools are hidden unless `CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS=1` is set.

Use `codex_task` with `background: true` for long-running work, then keep the
returned `session_id` and call `codex_followup` with `mode: "wait"` or
`mode: "steer"`.

## Real Steering Requires App-Server

`codex_followup` with `mode: "steer"` delivers live steering only when the
session is running through Codex app-server.

If app-server is unavailable and the session falls back to `codex exec`, steering
degrades to a high-priority queued follow-up turn. It cannot alter an already
running `codex exec` process in place.

## Full-Access Mode Is Deliberately Dangerous

The default sandbox is read-only. Full local access requires this per-call flag:

```json
{
  "full_access": true
}
```

That maps to Codex's unrestricted local mode. It can write files, mutate git
state, use DNS/network, and run package installs. Use it only when the user
explicitly asks for that capability.

## Nested Subagents Can Increase Cost And Latency

Nested Codex subagents are supported, including Spark. Keep nested work scoped,
set explicit `advanced.subagent_tasks`, and keep
`advanced.subagent_runtime.max_depth` at `1` unless recursive delegation is
deliberately needed.

## Claude Tool Choice Still Benefits From Clear Prompts

The plugin has a skill, tool descriptions, and `codex://usage`, but Claude can
still make better choices when the user names the intended shape:

- "ask one Codex agent"
- "run three Codex agents in parallel"
- "start Codex in the background"
- "steer the running Codex session"
