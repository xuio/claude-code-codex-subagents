import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJsonResult } from "./json-result.mjs";

const root = process.cwd();
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const projectDir = root;
const recordDir = path.join(os.tmpdir(), `codex-subagents-autodiscovery-${process.pid}`);
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

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

await mkdir(recordDir, { recursive: true });

try {
  const prompt = `I want a quick read-only Codex Spark second opinion on this repository. Ask Codex to inspect whether the plugin metadata clearly tells Claude when to use Codex subagents.

Work in this exact project directory: ${projectDir}

Codex should stay read-only and include the token AUTODISCOVERY_OK in its reply. Use Codex Spark, but do not set an explicit service_tier.

After the Codex result comes back, return exactly one compact JSON object and no markdown. Shape: {"ok": boolean, "tokenSeen": boolean, "model": string, "cwd": string}. Set ok true when the Codex tool call completed successfully.`;

  const systemPrompt =
    "You are validating the codex-subagents plugin. You may use Skill only for codex-subagents guidance, then codex_choose_tool, codex_usage_guide, or codex_task. Do not use Bash, Read, shell commands, or filesystem inspection. The MCP server already resolves the Codex binary.";
  const resultSchema = JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      tokenSeen: { type: "boolean" },
      model: { type: "string" },
      cwd: { type: "string" },
    },
    required: ["ok", "tokenSeen", "model", "cwd"],
  });

  const { version, binary } = await resolveClaudeCodeBinary();
  console.log(`Using Claude Code for autodiscovery ${version}: ${binary}`);

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
        "mcp__plugin_codex-subagents_codex-subagents__codex_usage_guide",
        "mcp__plugin_codex-subagents_codex-subagents__codex_choose_tool",
        "mcp__plugin_codex-subagents_codex-subagents__codex_task",
        "Skill",
      ].join(","),
      "--append-system-prompt",
      systemPrompt,
      "--model",
      process.env.CLAUDE_ORCHESTRATION_MODEL ?? "sonnet",
      "--effort",
      process.env.CLAUDE_ORCHESTRATION_EFFORT ?? "low",
      "--max-budget-usd",
      process.env.CLAUDE_ORCHESTRATION_MAX_BUDGET_USD ?? "0.50",
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
        CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(recordDir, "sessions.json"),
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  if (result.status !== 0) {
    throw new Error(`Claude autodiscovery command failed (${result.status}):\n${output}`);
  }

  const envelope = JSON.parse(result.stdout);
  assert(envelope.subtype === "success", "Claude autodiscovery should complete successfully", envelope);
  assert(envelope.is_error === false, "Claude autodiscovery should not report an error", envelope);
  assert(
    Array.isArray(envelope.permission_denials) && envelope.permission_denials.length === 0,
    "Claude autodiscovery should not hit permission denials",
    envelope.permission_denials,
  );

  const validation = envelope.structured_output ??
    (String(envelope.result ?? "").trim() ? extractJsonResult(envelope.result) : undefined);
  assert(validation, "Claude autodiscovery returned no structured result", envelope);
  assert(
    validation.model === "gpt-5.3-codex-spark",
    "Claude should choose Codex Spark from the natural-language request",
    validation,
  );
  assert(validation.cwd === projectDir, "Claude should pass the requested project_dir", validation);

  const calls = (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(calls.length >= 1, "Fake Codex should have been invoked", calls);
  assert(calls[0].cwd === projectDir, "Fake Codex should run in the requested project", calls[0]);
  assert(
    calls[0].args.includes("--model") &&
      calls[0].args[calls[0].args.indexOf("--model") + 1] === "gpt-5.3-codex-spark",
    "Fake Codex should be launched with the Spark preset",
    calls[0],
  );
  assert(
    !calls[0].args.some((arg) => arg.includes("service_tier=")),
    "Fake Codex should not be launched with an explicit service tier by default",
    calls[0],
  );

  console.log(
    `Claude native autodiscovery passed in ${envelope.duration_ms}ms, cost $${envelope.total_cost_usd}`,
  );
} finally {
  await rm(recordDir, { recursive: true, force: true });
}
