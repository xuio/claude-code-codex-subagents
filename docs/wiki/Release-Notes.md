# Release Notes

## v0.3.0

Native Claude-facing tool surface:

- `codex_task`
- `codex_task_group`
- `codex_followup`

`codex_task` defaults to a lean answer-first result, returns `session_id` only
for `background`, `keep_session`, or failure cases, diagnostics moved to
resources, and debug/legacy tools are hidden unless explicitly enabled.

## v0.2.0

First public-ready release candidate.

Highlights:

- Read-only-by-default Codex delegation from Claude Code.
- Codex desktop binary preferred automatically.
- Single, parallel, aggregate, persistent-session, async-session, steering,
  recovery, and diagnostics tools.
- Codex Spark preset and nested Codex subagent support.
- App-server sessions with recoverable metadata and live steering.
- Backpressure, progress events, response compaction, output artifacts, verbose
  logs, and debug bundles.
- Local install/update script and tracked wiki source.

Recommended install:

```sh
npm run install:local
```

Recommended CI-safe validation:

```sh
npm run test:ci
npm run check:dist
```
