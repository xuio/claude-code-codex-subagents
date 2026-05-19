import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const projectDir = root;
const recordDir = path.join(os.tmpdir(), `codex-subagents-session-steering-${process.pid}`);
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
  if (process.env.CLAUDE_ORCHESTRATION_BIN) {
    return { version: "override", binary: process.env.CLAUDE_ORCHESTRATION_BIN };
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

function extractJsonResult(rawResult) {
  const trimmed = rawResult.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

await mkdir(recordDir, { recursive: true });

try {
  const prompt = `Validate the codex-subagents plugin's long-running session flow from inside Claude Code. Use only the codex-subagents MCP tools. Use this exact fake Codex binary: ${fakeCodex}. Use this exact project_dir: ${projectDir}.

Start a Codex Spark session in the background with task "CLAUDE_STEERING_START DELAY_MS=2000". While it is running, add a normal follow-up prompt "CLAUDE_STEERING_FOLLOW" without waiting for that prompt to complete. Also steer the session with steering prompt "CLAUDE_STEERING_STEER" without waiting for steering to complete, so that steering runs before the normal follow-up. Then wait until the session is idle.

Return exactly one compact JSON object and no markdown. Shape: {"ok": boolean, "turns": number, "steerCompleted": boolean, "completed": boolean}.`;

  const systemPrompt =
    "You are validating the codex-subagents plugin. You may use Skill for guidance, then use only the allowed codex-subagents MCP tools. Do not use Bash, Read, shell commands, or filesystem inspection. Return only the requested JSON.";
  const resultSchema = JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      turns: { type: "number" },
      steerCompleted: { type: "boolean" },
      completed: { type: "boolean" },
    },
    required: ["ok", "turns", "steerCompleted", "completed"],
  });

  const { version, binary } = await resolveClaudeCodeBinary();
  console.log(`Using Claude Code for session steering ${version}: ${binary}`);

  const result = spawnSync(
    binary,
    [
      "--plugin-dir",
      ".",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "local",
      "--allowedTools",
      [
        "mcp__plugin_codex-subagents_codex-subagents__start_codex_session_async",
        "mcp__plugin_codex-subagents_codex-subagents__send_codex_session_prompt",
        "mcp__plugin_codex-subagents_codex-subagents__steer_codex_session",
        "mcp__plugin_codex-subagents_codex-subagents__wait_codex_session",
        "mcp__plugin_codex-subagents_codex-subagents__get_codex_session",
        "Skill",
      ].join(","),
      "--append-system-prompt",
      systemPrompt,
      "--model",
      process.env.CLAUDE_ORCHESTRATION_MODEL ?? "sonnet",
      "--effort",
      process.env.CLAUDE_ORCHESTRATION_EFFORT ?? "low",
      "--max-budget-usd",
      process.env.CLAUDE_ORCHESTRATION_MAX_BUDGET_USD ?? "0.75",
      "--json-schema",
      resultSchema,
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
      env: {
        ...process.env,
        CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  if (result.status !== 0) {
    throw new Error(`Claude session steering command failed (${result.status}):\n${output}`);
  }

  const envelope = JSON.parse(result.stdout);
  assert(envelope.subtype === "success", "Claude session steering should complete successfully", envelope);
  assert(envelope.is_error === false, "Claude session steering should not report an error", envelope);
  assert(
    Array.isArray(envelope.permission_denials) && envelope.permission_denials.length === 0,
    "Claude session steering should not hit permission denials",
    envelope.permission_denials,
  );

  const validation = envelope.structured_output ??
    (String(envelope.result ?? "").trim() ? extractJsonResult(envelope.result) : undefined);
  assert(validation, "Claude session steering returned no structured result", envelope);
  assert(validation.ok === true, "Claude should report session steering success", validation);
  assert(validation.turns >= 3, "Claude should observe three session turns", validation);
  assert(validation.steerCompleted === true, "Claude should observe completed steering", validation);
  assert(validation.completed === true, "Claude should wait until the session is idle", validation);

  const calls = (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const prompts = calls.map((call) => call.prompt);
  assert(prompts[0]?.includes("CLAUDE_STEERING_START"), "Fake Codex should receive the async start first", prompts);
  assert(prompts[1]?.includes("CLAUDE_STEERING_STEER"), "Steering should run before queued follow-up", prompts);
  assert(prompts[2]?.includes("CLAUDE_STEERING_FOLLOW"), "Queued follow-up should run after steering", prompts);

  console.log(
    `Claude session steering passed in ${envelope.duration_ms}ms, cost $${envelope.total_cost_usd}`,
  );
} finally {
  await rm(recordDir, { recursive: true, force: true });
}
