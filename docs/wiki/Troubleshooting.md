# Troubleshooting

## Start With Diagnostics

Ask Claude to read:

- `codex://status`
- `codex://doctor`
- `codex://usage`

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

Use the native background/follow-up flow instead of one blocking request:

- `codex_task` with `background: true`
- `codex_followup` with `mode: "wait"`
- `codex_followup` with `mode: "steer"`

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
