# Release Notes

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
