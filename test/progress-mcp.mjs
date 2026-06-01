import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-progress-project-"));
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-progress", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    ...process.env,
    CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS: "1",
    CODEX_SUBAGENTS_ENABLE_PROGRESS_NOTIFICATIONS: "1",
    CODEX_SUBAGENTS_PROGRESS_HEARTBEAT_MS: "50",
    CODEX_SUBAGENTS_PROGRESS_MIN_INTERVAL_MS: "0",
    CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(projectDir, "sessions.json"),
    CLAUDE_PROJECT_DIR: projectDir,
  },
  stderr: "pipe",
});
transport.stderr?.resume();

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

function assertIncreasing(progressEvents, label) {
  assert(progressEvents.length >= 2, `${label} should emit multiple progress events`, progressEvents);
  for (let index = 1; index < progressEvents.length; index += 1) {
    assert(
      progressEvents[index].progress > progressEvents[index - 1].progress,
      `${label} progress should increase monotonically`,
      progressEvents,
    );
  }
}

async function callTool(name, args, progressEvents) {
  return client.callTool(
    {
      name,
      arguments: args,
    },
    CallToolResultSchema,
    {
      resetTimeoutOnProgress: true,
      onprogress: (progress) => progressEvents.push(progress),
    },
  );
}

try {
  await client.connect(transport);

  const singleProgress = [];
  const single = await callTool(
    "run_agent",
    {
      prompt: "progress single DELAY_MS=40",
      project_dir: projectDir,
    },
    singleProgress,
  );
  assert(single.structuredContent?.agent?.ok, "run_agent should succeed", single.structuredContent);
  assertIncreasing(singleProgress, "run_agent");
  assert(
    singleProgress.some((event) => event.message?.includes("Queued Codex run")) &&
      singleProgress.some((event) => event.message?.includes("Started Codex run")) &&
      singleProgress.some((event) => event.message?.includes("completed")),
    "run_agent should emit queued, started, and completed messages",
    singleProgress,
  );

  const heartbeatProgress = [];
  const heartbeat = await callTool(
    "run_agent",
    {
      prompt: "progress heartbeat DELAY_MS=180",
      project_dir: projectDir,
    },
    heartbeatProgress,
  );
  assert(heartbeat.structuredContent?.agent?.ok, "run_agent heartbeat case should succeed", heartbeat.structuredContent);
  assert(
    heartbeatProgress.some((event) => event.message?.includes("Still running Codex run")),
    "run_agent should emit heartbeat progress while a blocking run is still active",
    heartbeatProgress,
  );

  const frontDoorProgress = [];
  const frontDoor = await callTool(
    "ask_codex",
    {
      task: "progress front door DELAY_MS=180",
      project_dir: projectDir,
    },
    frontDoorProgress,
  );
  assert(frontDoor.structuredContent?.agent?.ok, "ask_codex should succeed", frontDoor.structuredContent);
  assert(
    frontDoorProgress.some((event) => event.message?.includes("Still running Codex run")),
    "ask_codex should emit heartbeat progress while a blocking run is still active",
    frontDoorProgress,
  );

  const parallelProgress = [];
  const parallel = await callTool(
    "run_agents",
    {
      agents: [
        { name: "one", prompt: "progress parallel one DELAY_MS=40", project_dir: projectDir },
        { name: "two", prompt: "progress parallel two DELAY_MS=40", project_dir: projectDir },
      ],
      max_parallel: 2,
    },
    parallelProgress,
  );
  assert(parallel.structuredContent?.ok, "run_agents should succeed", parallel.structuredContent);
  assertIncreasing(parallelProgress, "run_agents");
  assert(
    parallelProgress.some((event) => event.total === 5) &&
      parallelProgress.some((event) => event.message?.includes("Queued 2 Codex agents")) &&
      parallelProgress.some((event) => event.message?.includes("Parallel Codex run completed")),
    "run_agents should emit progress with total and completion",
    parallelProgress,
  );

  const frontDoorParallelProgress = [];
  const frontDoorParallel = await callTool(
    "ask_codex_parallel",
    {
      tasks: [
        { name: "one", task: "progress front parallel one DELAY_MS=40", project_dir: projectDir },
        { name: "two", task: "progress front parallel two DELAY_MS=40", project_dir: projectDir },
      ],
      max_parallel: 2,
    },
    frontDoorParallelProgress,
  );
  assert(frontDoorParallel.structuredContent?.ok, "ask_codex_parallel should succeed", frontDoorParallel.structuredContent);
  assert(
    frontDoorParallelProgress.some((event) => event.message?.includes("Queued 2 Codex agents")) &&
      frontDoorParallelProgress.some((event) => event.message?.includes("Parallel Codex run completed")),
    "ask_codex_parallel should emit progress with total and completion",
    frontDoorParallelProgress,
  );

  const startProgress = [];
  const started = await callTool(
    "start_agent_run",
    {
      prompt: "progress async DELAY_MS=80",
      project_dir: projectDir,
    },
    startProgress,
  );
  const jobId = started.structuredContent?.job?.id;
  assert(jobId, "start_agent_run should return a job id", started.structuredContent);
  assertIncreasing(startProgress, "start_agent_run");

  const waitProgress = [];
  const waited = await callTool(
    "wait_agent_run",
    {
      job_id: jobId,
      timeout_ms: 5_000,
    },
    waitProgress,
  );
  assert(waited.structuredContent?.job?.status === "completed", "wait_agent_run should complete", waited);
  assertIncreasing(waitProgress, "wait_agent_run");
  assert(
    waitProgress.some((event) => event.message?.includes("Waiting for Codex job")) &&
      waitProgress.some((event) => event.message?.includes("completed")),
    "wait_agent_run should emit wait and completion progress",
    waitProgress,
  );

  const sessionStartProgress = [];
  const sessionStart = await callTool(
    "start_session",
    {
      prompt: "progress session start DELAY_MS=180",
      project_dir: projectDir,
    },
    sessionStartProgress,
  );
  const sessionId = sessionStart.structuredContent?.session?.id;
  assert(sessionStart.structuredContent?.agent?.ok, "start_session should succeed", sessionStart.structuredContent);
  assert(sessionId, "start_session should return a session id", sessionStart.structuredContent);
  assert(
    sessionStartProgress.some((event) => event.message?.includes("Still starting persistent Codex session")),
    "start_session should emit heartbeat progress while the initial turn is active",
    sessionStartProgress,
  );

  const sessionSendProgress = [];
  const sessionSend = await callTool(
    "send_session_prompt",
    {
      session_id: sessionId,
      prompt: "progress session follow-up DELAY_MS=180",
    },
    sessionSendProgress,
  );
  assert(sessionSend.structuredContent?.agent?.ok, "send_session_prompt should succeed", sessionSend.structuredContent);
  assert(
    sessionSend.structuredContent?.agent?.cwd === projectDir,
    "send_session_prompt should preserve the session project_dir when omitted",
    sessionSend.structuredContent,
  );
  assert(
    sessionSendProgress.some((event) => event.message?.includes("Still running Codex session")),
    "send_session_prompt should emit heartbeat progress while the resumed turn is active",
    sessionSendProgress,
  );

  const frontSessionStartProgress = [];
  const frontSessionStart = await callTool(
    "start_codex_session",
    {
      task: "progress front session start DELAY_MS=180",
      project_dir: projectDir,
    },
    frontSessionStartProgress,
  );
  const frontSessionId = frontSessionStart.structuredContent?.session?.id;
  assert(frontSessionStart.structuredContent?.agent?.ok, "start_codex_session should succeed", frontSessionStart.structuredContent);
  assert(frontSessionId, "start_codex_session should return a session id", frontSessionStart.structuredContent);
  assert(
    frontSessionStartProgress.some((event) => event.message?.includes("Still starting persistent Codex session")),
    "start_codex_session should emit heartbeat progress while the initial turn is active",
    frontSessionStartProgress,
  );

  const frontSessionSendProgress = [];
  const frontSessionSend = await callTool(
    "continue_codex_session",
    {
      session_id: frontSessionId,
      task: "progress front session follow-up DELAY_MS=180",
    },
    frontSessionSendProgress,
  );
  assert(frontSessionSend.structuredContent?.agent?.ok, "continue_codex_session should succeed", frontSessionSend.structuredContent);
  assert(
    frontSessionSend.structuredContent?.agent?.cwd === projectDir,
    "continue_codex_session should preserve the session project_dir when omitted",
    frontSessionSend.structuredContent,
  );
  assert(
    frontSessionSendProgress.some((event) => event.message?.includes("Still running Codex session")),
    "continue_codex_session should emit heartbeat progress while the resumed turn is active",
    frontSessionSendProgress,
  );

  const asyncSessionProgress = [];
  const asyncSession = await callTool(
    "start_codex_session_async",
    {
      task: "progress async session start DELAY_MS=180",
      project_dir: projectDir,
    },
    asyncSessionProgress,
  );
  const asyncSessionId = asyncSession.structuredContent?.session?.id;
  assert(asyncSessionId, "start_codex_session_async should return a session id", asyncSession.structuredContent);
  assert(
    asyncSessionProgress.some((event) => event.message?.includes("Starting long-running Codex session")),
    "start_codex_session_async should emit startup progress",
    asyncSessionProgress,
  );

  const steerProgress = [];
  const steer = await callTool(
    "steer_codex_session",
    {
      session_id: asyncSessionId,
      steering_prompt: "progress async session steer",
    },
    steerProgress,
  );
  assert(steer.structuredContent?.turn?.kind === "steer", "steer_codex_session should queue a steer turn", steer.structuredContent);
  assert(
    steerProgress.some((event) => event.message?.includes("Steering Codex session")),
    "steer_codex_session should emit steering progress",
    steerProgress,
  );

  const waitSessionProgress = [];
  const waitSession = await callTool(
    "wait_codex_session",
    {
      session_id: asyncSessionId,
      timeout_ms: 5_000,
    },
    waitSessionProgress,
  );
  assert(waitSession.structuredContent?.completed === true, "wait_codex_session should complete", waitSession);
  assertIncreasing(waitSessionProgress, "wait_codex_session");
  assert(
    waitSessionProgress.some((event) => event.message?.includes("Waiting for Codex session")) &&
      waitSessionProgress.some((event) => event.message?.includes("Still waiting for Codex session")) &&
      waitSessionProgress.some((event) => event.message?.includes("is ready")),
    "wait_codex_session should emit wait, heartbeat, and completion progress",
    waitSessionProgress,
  );

  console.log("MCP progress test passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
}
