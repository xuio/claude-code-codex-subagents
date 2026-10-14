import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const desktopCodex = "/Applications/Codex.app/Contents/Resources/codex";
const codex = process.env.CLAUDE_REAL_CODEX_BIN ?? process.env.CODEX_SUBAGENTS_CODEX_BIN ??
  (existsSync(desktopCodex) ? desktopCodex : "codex");

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${details}` : ""}`);
  }
}

function run(args, options = {}) {
  return execFileSync(codex, args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
}

const version = run(["--version"]).trim();
assert(version.includes("codex-cli"), "Codex binary should report a CLI version", version);

const execHelp = run(["exec", "--help"]);
for (const expected of [
  "--json",
  "--sandbox",
  "read-only",
  "--cd <DIR>",
  "--output-last-message",
  "--ephemeral",
]) {
  assert(execHelp.includes(expected), `codex exec --help should include ${expected}`, execHelp);
}

const features = run(["features", "list"]);
assert(features.includes("multi_agent"), "Codex runtime should expose multi_agent feature", features);

const models = JSON.parse(run(["debug", "models", "--bundled"], { maxBuffer: 64 * 1024 * 1024 }));
const preferredModels = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"];
const availableModels = (models.models ?? []).filter((model) => preferredModels.includes(model.slug));
assert(availableModels.length > 0, "Codex catalog should offer a supported current model", models);
const model = availableModels[0];
assert(model.supported_reasoning_levels?.some((level) => level.effort === "max"),
  "Current Codex models should support max reasoning", model);

run([
  "debug",
  "prompt-input",
  "-c",
  'approval_policy="never"',
  "-c",
  'sandbox_mode="read-only"',
  "-c",
  'agents.ui_sol.description="Fast focused UI iteration."',
  "-c",
  'agents.ui_sol.developer_instructions="Stay scoped and concise."',
  "-c",
  `agents.ui_sol.model="${model.slug}"`,
  "probe",
]);

console.log(`Codex runtime probe passed (${version})`);
