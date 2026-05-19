# Contributing

Thanks for improving `claude-code-codex-subagents`.

## Development

```sh
npm install
npm run build
npm test
npm run test:ci
```

`test:ci` is the portable suite used by GitHub Actions. It uses the fake Codex binary and does not require Claude Code, the Codex desktop app, or live credentials.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full local setup, dev-link workflow, test tiers, and release checklist.

Desktop-only and live-token checks are available when you need end-to-end validation:

```sh
npm run test:comprehensive
npm run test:claude-orchestration
npm run test:claude-real-codex
```

## Pull Requests

- Keep the default sandbox behavior read-only unless a change explicitly requires otherwise.
- Prefer small, focused changes with tests that cover the MCP contract.
- Do not commit credentials, local logs, generated temp files, or machine-specific paths.
- Run `npm run build` before committing changes to `src/`, because the plugin manifest loads `dist/index.js`.
- Run `npm run check:dist` before publishing changes that touch TypeScript source.
- Update user-facing docs when tool names, defaults, safety behavior, or validation commands change.
