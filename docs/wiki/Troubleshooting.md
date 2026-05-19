# Troubleshooting

## Start With Diagnostics

Ask Claude to call:

- `codex_status`
- `codex_doctor`
- `codex_export_debug_bundle`

These are the fastest way to inspect binary resolution, defaults, app-server
capabilities, queue limits, and recent failures.

## Claude Does Not Use The Plugin

Start Claude Code with:

```sh
claude --plugin-dir .
```

For installed-plugin development:

```sh
npm run dev:link
npm run dev:watch
```

Then ask naturally:

```text
Ask Codex to review this repository read-only.
```

## Long Runs

Use persistent or async tools instead of one blocking request:

- `codex_session_start`
- `codex_session_status`
- `codex_session_wait`
- `codex_session_steer`

Persistent sessions are the right path for work that should be recoverable after
an MCP restart.

## Logs

Verbose logs are on by default and include raw MCP traffic. Treat them as
sensitive project data.

Optional file logging:

```sh
export CODEX_SUBAGENTS_LOG_FILE=/tmp/codex-subagents.log
export CODEX_SUBAGENTS_LOG_LEVEL=debug
```

Quiet mode:

```sh
export CODEX_SUBAGENTS_LOG_LEVEL=silent
```
