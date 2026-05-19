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

  console.log("MCP progress test passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
}
