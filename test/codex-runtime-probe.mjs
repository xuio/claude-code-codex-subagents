import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";

const codex = "/Applications/Codex.app/Contents/Resources/codex";

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

await access(codex);

const version = run(["--version"]).trim();
assert(version.includes("codex-cli"), "Codex desktop binary should report a CLI version", version);

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

const models = JSON.parse(run(["debug", "models"], { maxBuffer: 64 * 1024 * 1024 }));
const slugs = new Set((models.models ?? []).map((model) => model.slug));
assert(slugs.has("gpt-5.3-codex"), "Codex model catalog should include gpt-5.3-codex");
assert(slugs.has("gpt-5.3-codex-spark"), "Codex model catalog should include gpt-5.3-codex-spark");

run([
  "debug",
  "prompt-input",
  "-c",
  'approval_policy="never"',
  "-c",
  'sandbox_mode="read-only"',
  "-c",
  'agents.ui_spark.description="Fast focused UI iteration."',
  "-c",
  'agents.ui_spark.developer_instructions="Stay scoped and concise."',
  "-c",
  'agents.ui_spark.model="gpt-5.3-codex-spark"',
  "probe",
]);

console.log(`Codex runtime probe passed (${version})`);
