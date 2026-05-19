import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-smoke-project-"));
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    CLAUDE_PROJECT_DIR: projectDir,
  },
  stderr: "pipe",
});
transport.stderr?.resume();

try {
  await client.connect(transport);
  const status = await client.callTool(
    {
      name: "codex_status",
      arguments: {},
    },
    CallToolResultSchema,
  );
  if (!status.structuredContent?.ok) {
    throw new Error(`codex_status failed: ${JSON.stringify(status.structuredContent)}`);
  }

  const guide = await client.callTool(
    {
      name: "codex_usage_guide",
      arguments: {},
    },
    CallToolResultSchema,
  );
  if (!guide.structuredContent?.guide?.includes("Prefer ask_codex for one delegated Codex task.")) {
    throw new Error(`codex_usage_guide failed: ${JSON.stringify(guide.structuredContent)}`);
  }
  if (guide.structuredContent?.preferredTools?.oneTask !== "ask_codex") {
    throw new Error(`codex_usage_guide did not advertise ask_codex: ${JSON.stringify(guide.structuredContent)}`);
  }

  const choice = await client.callTool(
    {
      name: "codex_choose_tool",
      arguments: {
        request: "ask Codex for a quick second opinion",
      },
    },
    CallToolResultSchema,
  );
  if (choice.structuredContent?.recommendedTool !== "ask_codex") {
    throw new Error(`codex_choose_tool chose the wrong single-agent tool: ${JSON.stringify(choice.structuredContent)}`);
  }

  const single = await client.callTool(
    {
      name: "ask_codex",
      arguments: {
        task: "single smoke RUN_COMMAND_EVENT",
        project_dir: projectDir,
        model_preset: "spark",
      },
    },
    CallToolResultSchema,
  );
  const singleAgent = single.structuredContent?.agent;
  if (!singleAgent?.ok || singleAgent.cwd !== projectDir || singleAgent.model !== "gpt-5.3-codex-spark") {
    throw new Error(`ask_codex failed: ${JSON.stringify(single.structuredContent)}`);
  }

  const result = await client.callTool(
    {
      name: "ask_codex_parallel",
      arguments: {
        tasks: [
          { name: "alpha", task: "alpha DELAY_MS=20", project_dir: projectDir },
          { name: "beta", task: "beta DELAY_MS=20", project_dir: projectDir },
        ],
        max_parallel: 2,
      },
    },
    CallToolResultSchema,
  );

  if (!result.structuredContent?.ok) {
    throw new Error(`ask_codex_parallel failed: ${JSON.stringify(result.structuredContent)}`);
  }

  const agents = result.structuredContent.agents;
  if (!Array.isArray(agents) || agents.length !== 2) {
    throw new Error(`expected two agent results: ${JSON.stringify(result.structuredContent)}`);
  }

  if (!agents.every((agent) => agent.cwd === projectDir && agent.sandbox === "read-only")) {
    throw new Error(`project_dir/read-only defaults not preserved: ${JSON.stringify(agents)}`);
  }

  const nested = await client.callTool(
    {
      name: "run_agent",
      arguments: {
        prompt: "coordinate nested fake work",
        project_dir: projectDir,
        model_preset: "spark",
        codex_subagents: [
          {
            name: "ui_spark",
            description: "Fast focused UI iteration.",
            developer_instructions: "Stay scoped and concise.",
            model_preset: "spark",
            reasoning_effort: "medium",
            sandbox: "read-only",
          },
        ],
        subagent_tasks: [{ agent: "ui_spark", prompt: "Inspect the toolbar." }],
        subagent_runtime: { max_threads: 4, max_depth: 2 },
      },
    },
    CallToolResultSchema,
  );

  const nestedAgent = nested.structuredContent?.agent;
  if (
    !nestedAgent?.ok ||
    nestedAgent.model !== "gpt-5.3-codex-spark" ||
    nestedAgent.codexSubagents?.customAgents?.[0] !== "ui_spark"
  ) {
    throw new Error(`nested subagent smoke failed: ${JSON.stringify(nested.structuredContent)}`);
  }

  const sessionStart = await client.callTool(
    {
      name: "start_codex_session",
      arguments: {
        task: "session smoke first",
        project_dir: projectDir,
      },
    },
    CallToolResultSchema,
  );
  const sessionId = sessionStart.structuredContent?.session?.id;
  if (!sessionId || sessionStart.structuredContent?.session?.projectDir !== projectDir) {
    throw new Error(`start_codex_session failed: ${JSON.stringify(sessionStart.structuredContent)}`);
  }
  const sessionNext = await client.callTool(
    {
      name: "continue_codex_session",
      arguments: {
        session_id: sessionId,
        task: "session smoke second",
      },
    },
    CallToolResultSchema,
  );
  if (
    sessionNext.structuredContent?.session?.turns !== 2 ||
    sessionNext.structuredContent?.agent?.cwd !== projectDir
  ) {
    throw new Error(`continue_codex_session failed: ${JSON.stringify(sessionNext.structuredContent)}`);
  }

  const longSessionStart = await client.callTool(
    {
      name: "start_codex_session_async",
      arguments: {
        task: "session async smoke first DELAY_MS=120",
        project_dir: projectDir,
      },
    },
    CallToolResultSchema,
  );
  const longSessionId = longSessionStart.structuredContent?.session?.id;
  if (!longSessionId || !longSessionStart.structuredContent?.turn?.id) {
    throw new Error(`start_codex_session_async failed: ${JSON.stringify(longSessionStart.structuredContent)}`);
  }
  const queuedPrompt = await client.callTool(
    {
      name: "send_codex_session_prompt",
      arguments: {
        session_id: longSessionId,
        task: "session async smoke queued follow-up",
      },
    },
    CallToolResultSchema,
  );
  if (!queuedPrompt.structuredContent?.queued || queuedPrompt.structuredContent?.turn?.kind !== "prompt") {
    throw new Error(`send_codex_session_prompt did not queue: ${JSON.stringify(queuedPrompt.structuredContent)}`);
  }
  const queuedSteer = await client.callTool(
    {
      name: "steer_codex_session",
      arguments: {
        session_id: longSessionId,
        steering_prompt: "session async smoke steer next",
      },
    },
    CallToolResultSchema,
  );
  if (
    !queuedSteer.structuredContent?.queued ||
    queuedSteer.structuredContent?.turn?.kind !== "steer" ||
    !["queued_after_current", "started_or_queued"].includes(queuedSteer.structuredContent?.delivery)
  ) {
    throw new Error(`steer_codex_session did not queue steering: ${JSON.stringify(queuedSteer.structuredContent)}`);
  }
  const longSessionWait = await client.callTool(
    {
      name: "wait_codex_session",
      arguments: {
        session_id: longSessionId,
        timeout_ms: 5_000,
      },
    },
    CallToolResultSchema,
  );
  if (
    longSessionWait.structuredContent?.completed !== true ||
    longSessionWait.structuredContent?.session?.turns !== 3 ||
    !longSessionWait.structuredContent?.session?.recentTurns?.some(
      (turn) => turn.kind === "steer" && turn.status === "completed",
    )
  ) {
    throw new Error(`wait_codex_session did not drain queued turns: ${JSON.stringify(longSessionWait.structuredContent)}`);
  }

  const asyncStart = await client.callTool(
    {
      name: "start_agent_run",
      arguments: {
        prompt: "async smoke DELAY_MS=20",
        project_dir: projectDir,
      },
    },
    CallToolResultSchema,
  );
  const asyncJobId = asyncStart.structuredContent?.job?.id;
  if (!asyncJobId) {
    throw new Error(`start_agent_run did not return a job id: ${JSON.stringify(asyncStart.structuredContent)}`);
  }

  const asyncWait = await client.callTool(
    {
      name: "wait_agent_run",
      arguments: {
        job_id: asyncJobId,
        timeout_ms: 5_000,
      },
    },
    CallToolResultSchema,
  );
  if (
    asyncWait.structuredContent?.job?.status !== "completed" ||
    asyncWait.structuredContent?.job?.result?.ok !== true
  ) {
    throw new Error(`wait_agent_run did not complete async job: ${JSON.stringify(asyncWait.structuredContent)}`);
  }

  const cancelStart = await client.callTool(
    {
      name: "start_agent_run",
      arguments: {
        prompt: "cancel smoke HANG_FOREVER IGNORE_SIGTERM",
        project_dir: projectDir,
        timeout_ms: 30_000,
      },
    },
    CallToolResultSchema,
  );
  const cancelJobId = cancelStart.structuredContent?.job?.id;
  if (!cancelJobId) {
    throw new Error(`cancel start did not return a job id: ${JSON.stringify(cancelStart.structuredContent)}`);
  }
  await client.callTool(
    {
      name: "cancel_agent_run",
      arguments: {
        job_id: cancelJobId,
      },
    },
    CallToolResultSchema,
  );
  const cancelWait = await client.callTool(
    {
      name: "wait_agent_run",
      arguments: {
        job_id: cancelJobId,
        timeout_ms: 10_000,
      },
    },
    CallToolResultSchema,
  );
  if (cancelWait.structuredContent?.job?.status !== "cancelled") {
    throw new Error(`cancel_agent_run did not cancel job: ${JSON.stringify(cancelWait.structuredContent)}`);
  }

  console.log("MCP smoke test passed");
} finally {
  await transport.close();
  await rm(projectDir, { recursive: true, force: true });
}
