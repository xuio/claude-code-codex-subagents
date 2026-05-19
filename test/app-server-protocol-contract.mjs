import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const defaultCodexBin = "/Applications/Codex.app/Contents/Resources/codex";
const codexBin = process.env.CLAUDE_REAL_CODEX_BIN ?? process.env.CODEX_SUBAGENTS_CODEX_BIN ?? defaultCodexBin;

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

async function readSchema(root, name) {
  return JSON.parse(await readFile(path.join(root, name), "utf8"));
}

function required(schema) {
  return new Set(schema.required ?? []);
}

await access(codexBin);

const out = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-schema-"));
try {
  await execFileAsync(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", out], {
    maxBuffer: 64 * 1024 * 1024,
  });

  for (const name of [
    "JSONRPCRequest.json",
    "JSONRPCResponse.json",
    "v1/InitializeParams.json",
    "v2/ThreadStartParams.json",
    "v2/ThreadResumeParams.json",
    "v2/ThreadResumeResponse.json",
    "v2/TurnStartParams.json",
    "v2/TurnSteerParams.json",
    "v2/TurnInterruptParams.json",
    "v2/ThreadReadParams.json",
    "v2/TurnCompletedNotification.json",
    "v2/AgentMessageDeltaNotification.json",
    "v2/ItemCompletedNotification.json",
  ]) {
    await access(path.join(out, name));
  }

  const threadStart = await readSchema(out, "v2/ThreadStartParams.json");
  assert(threadStart.properties?.cwd, "thread/start must keep cwd in the app-server contract");
  assert(threadStart.properties?.model, "thread/start must keep model in the app-server contract");
  assert(threadStart.properties?.sandbox, "thread/start must keep sandbox in the app-server contract");
  assert(threadStart.properties?.approvalPolicy, "thread/start must keep approvalPolicy in the app-server contract");

  const turnStart = await readSchema(out, "v2/TurnStartParams.json");
  assert(required(turnStart).has("threadId"), "turn/start must require threadId", turnStart.required);
  assert(required(turnStart).has("input"), "turn/start must require input", turnStart.required);
  assert(turnStart.properties?.sandboxPolicy, "turn/start must keep sandboxPolicy override support");
  assert(turnStart.properties?.effort, "turn/start must keep effort override support");

  const threadResume = await readSchema(out, "v2/ThreadResumeParams.json");
  assert(required(threadResume).has("threadId"), "thread/resume must require threadId", threadResume.required);
  assert(threadResume.properties?.cwd, "thread/resume must keep cwd override support");
  assert(threadResume.properties?.model, "thread/resume must keep model override support");
  assert(threadResume.properties?.sandbox, "thread/resume must keep sandbox override support");

  const turnSteer = await readSchema(out, "v2/TurnSteerParams.json");
  assert(required(turnSteer).has("threadId"), "turn/steer must require threadId", turnSteer.required);
  assert(required(turnSteer).has("expectedTurnId"), "turn/steer must require expectedTurnId", turnSteer.required);
  assert(required(turnSteer).has("input"), "turn/steer must require input", turnSteer.required);

  const turnInterrupt = await readSchema(out, "v2/TurnInterruptParams.json");
  assert(required(turnInterrupt).has("threadId"), "turn/interrupt must require threadId", turnInterrupt.required);
  assert(required(turnInterrupt).has("turnId"), "turn/interrupt must require turnId", turnInterrupt.required);

  const turnCompleted = await readSchema(out, "v2/TurnCompletedNotification.json");
  assert(required(turnCompleted).has("threadId"), "turn/completed must include threadId", turnCompleted.required);
  assert(required(turnCompleted).has("turn"), "turn/completed must include turn", turnCompleted.required);

  const delta = await readSchema(out, "v2/AgentMessageDeltaNotification.json");
  assert(required(delta).has("delta"), "agent message delta must include delta text", delta.required);
  assert(required(delta).has("turnId"), "agent message delta must include turnId", delta.required);

  console.log(`Codex app-server protocol contract passed for ${codexBin}`);
} finally {
  await rm(out, { recursive: true, force: true });
}
