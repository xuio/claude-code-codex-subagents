import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJsonResult } from "./json-result.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const codexBin =
  process.env.CLAUDE_REAL_CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex";
const installedPluginDir =
  process.env.CLAUDE_REAL_SESSION_PLUGIN_DIR ??
  path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "cache",
    "codex-subagents-local",
    "codex-subagents",
    packageJson.version,
  );
const claudeCodeRoot = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code",
);

function compareVersions(a, b) {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function resolveClaudeCodeBinary() {
  if (process.env.CLAUDE_REAL_SESSION_CLAUDE_BIN) {
    return { version: "override", binary: process.env.CLAUDE_REAL_SESSION_CLAUDE_BIN };
  }

  const entries = await readdir(claudeCodeRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const binary = path.join(
      claudeCodeRoot,
      entry.name,
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    );
    try {
      const info = await stat(binary);
      if (info.isFile()) candidates.push({ version: entry.name, binary });
    } catch {
      // Ignore incomplete desktop app installs.
    }
  }

  candidates.sort((a, b) => compareVersions(a.version, b.version));
  const resolved = candidates.at(-1);
  if (!resolved) {
    throw new Error(`No Claude Code desktop CLI found under ${claudeCodeRoot}`);
  }
  return resolved;
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

const prompt = `Validate the installed codex-subagents plugin persistent-session path using the real Codex binary. Use only the codex-subagents MCP tools. Use this exact real Codex binary for every Codex tool call: ${codexBin}. Use this exact project_dir only on the initial codex_task calls: ${root}.

Perform exactly these checks:
1. Call codex_task with description "Real persistent session validation", prompt "Real persistent session validation. Stay read-only. Reply exactly REAL_SESSION_START_OK", project_dir "${root}", keep_session true, reasoning "low", advanced.codex_bin "${codexBin}", advanced.model "spark", advanced.timeout_ms 180000, and advanced.include_diagnostics true.
2. Verify the codex_task result has ok true, diagnostics.cwd equal to "${root}", a non-empty session_id, and result containing REAL_SESSION_START_OK.
3. Call codex_followup for that session id with description "Real persistent follow-up", prompt "Follow-up persistent session validation. Stay read-only. Reply exactly REAL_SESSION_FOLLOW_OK", reasoning "low", advanced.codex_bin "${codexBin}", advanced.model "spark", advanced.timeout_ms 180000, and advanced.include_diagnostics true. Important: intentionally omit project_dir and cwd from this follow-up call.
4. Verify the codex_followup result has ok true, diagnostics.cwd equal to "${root}", diagnostics.session.turns is at least 2, the same session_id, and result containing REAL_SESSION_FOLLOW_OK. Use this codex_followup result's diagnostics.session.turns value for details.turns.
5. Call codex_task with description "Real async app-server steering validation", prompt "Real async app-server steering validation. Stay read-only. Run the shell command \`sleep 30\`, then reply exactly REAL_SESSION_ASYNC_START_OK unless a later steering instruction changes the exact final reply.", project_dir "${root}", background true, reasoning "low", advanced.codex_bin "${codexBin}", advanced.model "spark", and advanced.timeout_ms 180000. Verify it returns a second session_id and a turn immediately.
6. Call codex_followup for that second session id with mode "steer", prompt "Steering validation. Change the exact final reply to REAL_SESSION_STEER_OK.", background true, reasoning "low", advanced.codex_bin "${codexBin}", advanced.model "spark", and advanced.timeout_ms 180000. Verify it returns delivery "delivered_to_active_turn" and a completed steer turn.
7. Call codex_followup for the second session id with mode "wait", wait_timeout_ms 300000, and advanced.include_diagnostics true. Verify completed true, diagnostics.session.protocol is "app-server", diagnostics.session.turns is at least 1, recentTurns contains a completed steer turn, and result contains REAL_SESSION_STEER_OK. Use this wait result's diagnostics.session.turns value for details.asyncTurns.

Return exactly one compact JSON object and no markdown. Shape: {"ok": boolean, "checks": {"start": boolean, "follow": boolean, "asyncStart": boolean, "steer": boolean, "asyncWait": boolean}, "details": {"sessionId": string, "startCwd": string, "followCwd": string, "turns": number, "asyncTurns": number}}`;

const systemPrompt =
  "You are a deterministic Claude Code plugin validation harness. You may use Skill only to load codex-subagents guidance, then use only the explicitly named codex-subagents MCP tools. Do not use Bash, Read, files, shell commands, or any other non-MCP tool. Return only the requested JSON.";

const { version, binary } = await resolveClaudeCodeBinary();
console.log(`Using Claude Code for real Codex session validation ${version}: ${binary}`);
console.log(`Using real Codex binary: ${codexBin}`);
console.log(`Using installed plugin directory: ${installedPluginDir}`);

const env = { ...process.env };
delete env.CODEX_SUBAGENTS_CODEX_BIN;
env.CODEX_SUBAGENTS_SESSION_STATE_FILE = path.join(os.tmpdir(), `codex-subagents-real-session-${process.pid}.sessions.json`);

const result = spawnSync(
  binary,
  [
    "--plugin-dir",
    installedPluginDir,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "local",
    "--disable-slash-commands",
    "--allowedTools",
    [
      "mcp__plugin_codex-subagents_codex-subagents__codex_task",
      "mcp__plugin_codex-subagents_codex-subagents__codex_followup",
      "Skill",
    ].join(","),
    "--append-system-prompt",
    systemPrompt,
    "--model",
    process.env.CLAUDE_REAL_SESSION_MODEL ?? "sonnet",
    "--effort",
    process.env.CLAUDE_REAL_SESSION_EFFORT ?? "low",
    "--max-budget-usd",
    process.env.CLAUDE_REAL_SESSION_MAX_BUDGET_USD ?? "1.00",
    "--no-session-persistence",
    "--output-format",
    "json",
    "-p",
    prompt,
  ],
  {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env,
    maxBuffer: 32 * 1024 * 1024,
  },
);

const output = [result.stdout, result.stderr].filter(Boolean).join("");
if (result.status !== 0) {
  throw new Error(`Claude real Codex session command failed (${result.status}):\n${output}`);
}

const envelope = JSON.parse(result.stdout);
assert(envelope.subtype === "success", "Claude real Codex session validation should succeed", envelope);
assert(envelope.is_error === false, "Claude real Codex session validation should not report an error", envelope);
assert(
  Array.isArray(envelope.permission_denials) && envelope.permission_denials.length === 0,
  "Claude real Codex session validation should not hit permission denials",
  envelope.permission_denials,
);

assert(String(envelope.result ?? "").trim() !== "", "Claude real Codex session validation returned an empty result", envelope);
const validation = extractJsonResult(envelope.result);
assert(validation.ok === true, "Claude should report overall session success", validation);
assert(validation.checks?.start === true, "Claude should validate codex_task session start", validation);
assert(validation.checks?.follow === true, "Claude should validate codex_followup", validation);
assert(validation.checks?.asyncStart === true, "Claude should validate async codex_task", validation);
assert(validation.checks?.steer === true, "Claude should validate codex_followup steering", validation);
assert(validation.checks?.asyncWait === true, "Claude should validate codex_followup wait", validation);
assert(validation.details?.startCwd === root, "codex_task should run in project root", validation);
assert(validation.details?.followCwd === root, "codex_followup should preserve project root", validation);
assert(validation.details?.turns >= 2, "session should have at least two turns", validation);
assert(validation.details?.asyncTurns >= 1, "async session should have at least one app-server turn", validation);

console.log(
  `Claude real Codex session validation passed in ${envelope.duration_ms}ms, Claude cost $${envelope.total_cost_usd}`,
);
