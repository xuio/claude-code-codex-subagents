# Troubleshooting

Start with `codex_status` and `codex_doctor`. They do not invoke a model and are
safe to run during installation or debugging.

## Codex Binary Is Not Found

Run:

```sh
npm run build
claude --plugin-dir .
```

Then ask Claude to call `codex_status`.

The resolver prefers:

1. Per-call `codex_bin`.
2. `CODEX_SUBAGENTS_CODEX_BIN`.
3. `/Applications/Codex.app/Contents/Resources/codex`.
4. `CODEX_BIN`.
5. `codex` on `PATH`.

If needed, set:

```sh
export CODEX_SUBAGENTS_CODEX_BIN=/absolute/path/to/codex
```

## Claude Does Not Pick The Plugin

Check that Claude was started with the plugin directory:

```sh
claude --plugin-dir .
```

For installed-plugin development, run:

```sh
npm run install:local
npm run dev:watch
```

Then ask Claude to use Codex naturally, for example:

```text
Ask Codex to review this repository read-only.
```

The plugin includes a skill and front-door tools so Claude should not need to know
the low-level tool names.

## A Long Run Times Out

Prefer session or async tools for long work:

- `codex_session_start`
- `codex_session_status`
- `codex_session_wait`
- `codex_session_steer`

Persistent sessions are the better choice when the work must survive an MCP
restart. Async one-shot jobs are process-local and do not survive restarts.

## Session Recovery Fails

Use `codex_session_status`, then `codex_session_recover`.

Check:

- whether the session has a `codexThreadId`
- whether it used `protocol: "app-server"`
- whether `supports.threadResume` is true
- whether `thread/read` is unavailable but recovery still succeeded

If app-server is unavailable, the plugin falls back to exec sessions unless
`CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK=1` is set.

## Tool Results Are Too Large

The plugin compacts large responses before returning them to Claude. If
`mcpResponse.compacted` is true, inspect the returned summary first. Full retained
stdout/stderr/final-message artifacts are written under the artifact directory
when output artifacts are enabled.

Useful settings:

```sh
export CODEX_SUBAGENTS_OUTPUT_ARTIFACTS=1
export CODEX_SUBAGENTS_ARTIFACT_DIR=/tmp/codex-subagents-artifacts
```

## Debug Logs

Verbose JSONL logging is on by default and goes to stderr. To also write a file:

```sh
export CODEX_SUBAGENTS_LOG_FILE=/tmp/codex-subagents.log
export CODEX_SUBAGENTS_LOG_LEVEL=debug
```

The default debug profile intentionally logs raw MCP traffic. Treat logs as
sensitive project data.

For quieter local usage:

```sh
export CODEX_SUBAGENTS_LOG_PROFILE=production
```

To disable logging:

```sh
export CODEX_SUBAGENTS_LOG_LEVEL=silent
```

## Export A Debug Bundle

Ask Claude to call `codex_export_debug_bundle`, or run:

```sh
npm run diagnostics
```

Bundles include status, selected session/job state, recent failures, queue/session
limits, logging/artifact settings, lifecycle stats, and a bounded log tail when a
log file is configured.

## Real Claude/Codex Validation

Use fake-Codex Claude tests first:

```sh
npm run test:claude-autodiscovery
npm run test:claude-orchestration
npm run test:claude-session-steering
```

Then use real Codex tests only when needed:

```sh
npm run test:real-app-server-steering
npm run test:claude-real-codex
npm run test:claude-real-session
```

These spend live Claude and/or Codex tokens.

## Release Or Update Looks Stale

Run the local update flow:

```sh
npm run update:local
```

Then restart Claude Code. If Claude still loads an old version, run:

```sh
npm run dev:link
npm run validate:plugin
```

`dev:link` prints the marketplace and installed cache symlinks that Claude Code
and Claude Desktop share.
