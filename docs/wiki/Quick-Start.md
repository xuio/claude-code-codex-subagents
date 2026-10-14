# Quick Start

Requirements:

- Node.js 20 or newer
- Git (for marketplace downloads)
- Claude Code
- Codex CLI, preferably the Codex desktop app

Install from Claude Code's marketplace:

```sh
claude plugin marketplace add xuio/claude-code-codex-subagents
claude plugin install codex-subagents@codex-subagents --scope user
```

Or use `/plugin marketplace add xuio/claude-code-codex-subagents` and
`/plugin install codex-subagents@codex-subagents` inside Claude Code.
The built server is included; no npm install or build step is needed.
Start a new session after installation.

Ask Claude:

```text
Use Codex to review this repository read-only. Focus on reliability risks and missing tests.
```

For local development against Claude's installed plugin cache:

```sh
npm run dev:link
npm run dev:watch
```

`dev:link` symlinks Claude's plugin install back to the repository, so Claude Code
CLI and the Claude Desktop bundled Claude Code binary load the same working tree
after `dist/index.js` is rebuilt.

To update a marketplace install:

```sh
claude plugin marketplace update codex-subagents
claude plugin update codex-subagents@codex-subagents --scope user
```

For an editable local install, clone the repository and run `npm run install:local`.
To update that local install:

```sh
npm run update:local
```

## Defaults

- Codex binary: Codex desktop app binary when available.
- Sandbox: `read-only`.
- Approvals: `approval_policy="never"`.
- Sessions: Codex app-server by default, exec fallback when allowed.
- Logging: verbose JSONL on stderr.
- Full access: explicit per-call opt-in with `full_access`.
