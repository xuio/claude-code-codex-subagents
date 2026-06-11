# Development

## Setup

```sh
npm install
npm run build
```

The Claude plugin manifest points at `dist/index.js`, so rebuild after changing
TypeScript source.

For the normal local install/update path:

```sh
npm run install:local
npm run update:local
```

`install:local` builds, validates plugin wiring, and symlinks Claude's local
plugin cache to this working tree. `update:local` first runs `git pull --ff-only`.

## Local Claude Plugin Link

For active development, link Claude's installed plugin cache back to this working
tree:

```sh
npm run dev:link
npm run dev:watch
```

`dev:watch` rebuilds `dist/index.js` as source changes. The symlinked install lets
Claude Code CLI and the Claude Desktop bundled Claude Code binary load the same
working tree.

## Test Tiers

Portable CI suite:

```sh
npm run test:ci
```

This uses the fake Codex binary and does not require Claude Code, Codex desktop,
or live model credentials.

Focused checks:

```sh
npm run build
npm test
npm run smoke:mcp
npm run test:reliability
npm run test:stress
npm run test:progress
npm run test:advanced
npm run test:plugin-manifest
npm run validate:plugin
```

Real-runtime checks that do not invoke a model:

```sh
npm run test:codex-runtime
npm run test:app-server-contract
npm run test:real-matrix
```

Opt-in live Claude/Codex checks:

```sh
npm run test:claude-autodiscovery
npm run test:claude-orchestration
npm run test:claude-session-steering
npm run test:real-app-server-steering
npm run test:claude-large-output
npm run test:claude-real-codex
npm run test:claude-real-session
```

The live tests spend Claude and/or Codex tokens. Use them when changing tool
descriptions, session behavior, app-server integration, or real runtime handling.
Some Claude Desktop CLI checks create a local `.in_use/` directory with lock
markers. The directory is gitignored and can be removed after tests if all
matching processes are gone.

Longer soak:

```sh
CODEX_SUBAGENTS_REAL_SOAK_ROUNDS=10 npm run test:real-soak
```

Set `CODEX_SUBAGENTS_REAL_SOAK_FULL=1` to include the real Claude-to-real Codex
scenario in every round.

## Release Checklist

1. Keep defaults read-only unless the change explicitly concerns full-access mode.
2. Update tests in the same change as behavior changes.
3. Run `npm run test:ci`.
4. Run relevant real-runtime or live tests for the touched area.
5. Run `npm run check:dist`.
6. For release candidates, run `npm run test:real-soak`.
7. Check for local artifacts and secrets before committing.
8. Push and verify GitHub Actions on Node 20 and Node 22.
9. Create the GitHub release from `docs/RELEASE.md`.

## Wiki Publishing

Tracked wiki source lives in `docs/wiki/`.

```sh
npm run wiki:publish
```

If GitHub returns `Repository not found` for the `.wiki.git` remote, create the
first wiki page once in the GitHub web UI, then rerun `npm run wiki:publish`.
GitHub does not expose an initialized wiki git remote until that first page
exists.
The wiki files intentionally duplicate selected docs pages. Update the tracked
`docs/wiki/*.md` source before running `npm run wiki:publish`.

## Plugin Validation

`npm run test:ci` is portable and uses a local manifest wiring check. Run
`npm run validate:plugin` locally when changing `.claude-plugin/`, `skills/`, or
installation behavior; it requires Claude Code to be installed.

## Useful Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Type-check and bundle `dist/index.js` |
| `npm run check:dist` | Rebuild and verify committed dist has no diff |
| `npm run install:local` | Build, validate, and symlink the local Claude plugin install |
| `npm run update:local` | Pull latest main, then run the local install flow |
| `npm run dev:link` | Symlink Claude's plugin cache to this repo |
| `npm run dev:watch` | Rebuild dist on TypeScript changes |
| `npm run wiki:publish` | Publish `docs/wiki/*.md` to the GitHub wiki repo |
| `npm run diagnostics` | Write a sanitized local diagnostics bundle |
| `npm run validate:plugin` | Run Claude's plugin manifest validator |
