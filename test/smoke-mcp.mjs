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
    CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(projectDir, "sessions.json"),
  },
  stderr: "pipe",
});
transport.stderr?.resume();

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

async function callTool(name, args) {
  return client.callTool(
    {
      name,
      arguments: args,
    },
    CallToolResultSchema,
  );
}

try {
  await client.connect(transport);

  const toolList = await client.listTools();
  const toolNames = new Set(toolList.tools.map((tool) => tool.name));
  for (const name of [
    "codex_task",
    "codex_task_group",
    "codex_session_start",
    "codex_session_prompt",
    "codex_session_steer",
    "codex_session_status",
    "codex_session_wait",
    "codex_sessions",
    "codex_session_recover",
    "codex_session_cancel",
  ]) {
    assert(toolNames.has(name), `default tool surface should expose ${name}`, toolList.tools);
  }
  for (const name of [
    "ask_codex",
    "ask_codex_parallel",
    "run_agent",
    "run_agents",
    "start_agent_run",
    "start_codex_session",
    "start_codex_session_async",
    "continue_codex_session",
    "send_codex_session_prompt",
  ]) {
    assert(!toolNames.has(name), `legacy tool ${name} should be hidden by default`, toolList.tools);
  }

  const status = await callTool("codex_status", {});
  assert(status.structuredContent?.ok, "codex_status failed", status.structuredContent);

  const guide = await callTool("codex_usage_guide", {});
  assert(
    guide.structuredContent?.guide?.includes("Prefer codex_task for one delegated Codex task."),
    "codex_usage_guide should teach the native single-task tool",
    guide.structuredContent,
  );
  assert(
    guide.structuredContent?.preferredTools?.oneTask === "codex_task",
    "codex_usage_guide should advertise codex_task",
    guide.structuredContent,
  );
  assert(
    guide.structuredContent?.preferredTools?.parallelTasks === "codex_task_group",
    "codex_usage_guide should advertise codex_task_group",
    guide.structuredContent,
  );
  assert(
    guide.structuredContent?.preferredTools?.lowerLevelOneTask === undefined,
    "codex_usage_guide should not advertise legacy front doors",
    guide.structuredContent,
  );

  const choice = await callTool("codex_choose_tool", {
    request: "ask Codex for a quick second opinion",
  });
  assert(
    choice.structuredContent?.recommendedTool === "codex_task",
    "codex_choose_tool chose the wrong single-task tool",
    choice.structuredContent,
  );

  const parallelChoice = await callTool("codex_choose_tool", {
    request: "ask several Codex agents to review independent areas",
    wants_parallel: true,
    task_count: 3,
  });
  assert(
    parallelChoice.structuredContent?.recommendedTool === "codex_task_group",
    "codex_choose_tool chose the wrong parallel tool",
    parallelChoice.structuredContent,
  );

  const sessionChoice = await callTool("codex_choose_tool", {
    request: "start a long-running Codex agent that keeps context",
    wants_session: true,
  });
  assert(
    sessionChoice.structuredContent?.recommendedTool === "codex_session_start",
    "codex_choose_tool chose the wrong session tool",
    sessionChoice.structuredContent,
  );

  const single = await callTool("codex_task", {
    description: "Single smoke",
    prompt: "single smoke RUN_COMMAND_EVENT",
    project_dir: projectDir,
    model_preset: "spark",
  });
  const singleAgent = single.structuredContent?.agent;
  assert(single.structuredContent?.ok, "codex_task should return ok", single.structuredContent);
  assert(single.structuredContent?.result?.includes("single smoke"), "codex_task should return answer-first result", single.structuredContent);
  assert(
    singleAgent?.ok && singleAgent.cwd === projectDir && singleAgent.model === "gpt-5.3-codex-spark",
    "codex_task did not preserve project/model",
    single.structuredContent,
  );

  const group = await callTool("codex_task_group", {
    tasks: [
      { name: "alpha", description: "Alpha smoke", prompt: "alpha DELAY_MS=20", project_dir: projectDir },
      { name: "beta", description: "Beta smoke", prompt: "beta DELAY_MS=20", project_dir: projectDir },
    ],
    max_parallel: 2,
  });
  const agents = group.structuredContent?.agents;
  assert(group.structuredContent?.ok, "codex_task_group failed", group.structuredContent);
  assert(Array.isArray(agents) && agents.length === 2, "expected two group agent results", group.structuredContent);
  assert(
    agents.every((agent) => agent.cwd === projectDir && agent.sandbox === "read-only"),
    "codex_task_group should preserve project_dir/read-only defaults",
    agents,
  );

  const nested = await callTool("codex_task", {
    description: "Nested subagent smoke",
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
  });
  const nestedAgent = nested.structuredContent?.agent;
  assert(
    nestedAgent?.ok &&
      nestedAgent.model === "gpt-5.3-codex-spark" &&
      nestedAgent.codexSubagents?.customAgents?.[0] === "ui_spark",
    "nested subagent smoke failed",
    nested.structuredContent,
  );

  const sessionStart = await callTool("codex_session_start", {
    description: "Session smoke first",
    prompt: "session smoke first",
    project_dir: projectDir,
    wait_for_completion: true,
  });
  const sessionId = sessionStart.structuredContent?.session?.id;
  assert(sessionStart.structuredContent?.ok, "codex_session_start should complete when requested", sessionStart.structuredContent);
  assert(sessionId && sessionStart.structuredContent?.session?.projectDir === projectDir, "codex_session_start failed", sessionStart.structuredContent);
  assert(sessionStart.structuredContent?.agent?.cwd === projectDir, "codex_session_start should run in project_dir", sessionStart.structuredContent);

  const sessionNext = await callTool("codex_session_prompt", {
    session_id: sessionId,
    description: "Session smoke second",
    prompt: "session smoke second",
    wait_for_completion: true,
  });
  assert(sessionNext.structuredContent?.session?.turns === 2, "codex_session_prompt should add a turn", sessionNext.structuredContent);
  assert(sessionNext.structuredContent?.agent?.cwd === projectDir, "codex_session_prompt should preserve project_dir", sessionNext.structuredContent);

  const longSessionStart = await callTool("codex_session_start", {
    description: "Async session smoke",
    prompt: "session async smoke first DELAY_MS=120",
    project_dir: projectDir,
  });
  const longSessionId = longSessionStart.structuredContent?.session?.id;
  assert(longSessionStart.structuredContent?.ok, "codex_session_start async failed", longSessionStart.structuredContent);
  assert(longSessionId && longSessionStart.structuredContent?.turn?.id, "codex_session_start should return session and turn ids", longSessionStart.structuredContent);

  const sessionStatus = await callTool("codex_session_status", { session_id: longSessionId });
  assert(sessionStatus.structuredContent?.ok, "codex_session_status should inspect running session", sessionStatus.structuredContent);

  const queuedPrompt = await callTool("codex_session_prompt", {
    session_id: longSessionId,
    description: "Queued follow-up",
    prompt: "session async smoke queued follow-up",
  });
  assert(queuedPrompt.structuredContent?.queued, "codex_session_prompt should queue by default", queuedPrompt.structuredContent);
  assert(queuedPrompt.structuredContent?.turn?.kind === "prompt", "queued session turn should be a prompt", queuedPrompt.structuredContent);

  const queuedSteer = await callTool("codex_session_steer", {
    session_id: longSessionId,
    prompt: "session async smoke steer next",
  });
  assert(queuedSteer.structuredContent?.queued, "codex_session_steer should return without waiting by default", queuedSteer.structuredContent);
  assert(
    ["delivered_to_active_turn", "queued_after_current", "started_or_queued"].includes(queuedSteer.structuredContent?.delivery),
    "codex_session_steer should report how steering was delivered",
    queuedSteer.structuredContent,
  );

  const longSessionWait = await callTool("codex_session_wait", {
    session_id: longSessionId,
    timeout_ms: 5_000,
  });
  assert(longSessionWait.structuredContent?.completed === true, "codex_session_wait should complete", longSessionWait.structuredContent);
  assert(
    longSessionWait.structuredContent?.session?.turns >= 2,
    "codex_session_wait should drain queued turns",
    longSessionWait.structuredContent,
  );

  const sessions = await callTool("codex_sessions", {});
  assert(
    sessions.structuredContent?.sessions?.some((session) => session.id === sessionId),
    "codex_sessions should list existing sessions",
    sessions.structuredContent,
  );

  const cancelStart = await callTool("codex_session_start", {
    description: "Cancellation smoke",
    prompt: "cancel smoke DELAY_MS=5000",
    project_dir: projectDir,
  });
  const cancelSessionId = cancelStart.structuredContent?.session?.id;
  assert(cancelSessionId, "codex_session_start should return a cancellable session", cancelStart.structuredContent);
  const cancelled = await callTool("codex_session_cancel", { session_id: cancelSessionId });
  assert(cancelled.structuredContent?.ok, "codex_session_cancel should succeed", cancelled.structuredContent);

  console.log("MCP smoke test passed");
} finally {
  await transport.close();
  await rm(projectDir, { recursive: true, force: true });
}
