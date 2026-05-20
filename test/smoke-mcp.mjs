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

async function readJsonResource(uri) {
  const resource = await client.readResource({ uri });
  return JSON.parse(resource.contents[0].text);
}

async function listToolsWithEnv(env) {
  const debugClient = new Client({ name: "codex-subagents-smoke-debug", version: "0.1.0" });
  const debugTransport = new StdioClientTransport({
    command: path.join(root, "dist/index.js"),
    cwd: root,
    env,
    stderr: "pipe",
  });
  debugTransport.stderr?.resume();
  try {
    await debugClient.connect(debugTransport);
    return await debugClient.listTools();
  } finally {
    await debugTransport.close().catch(() => {});
  }
}

try {
  await client.connect(transport);

  const toolList = await client.listTools();
  const toolNames = new Set(toolList.tools.map((tool) => tool.name));
  assert(toolNames.has("codex_task"), "default tool surface should expose codex_task", toolList.tools);
  assert(toolNames.has("codex_task_group"), "default tool surface should expose codex_task_group", toolList.tools);
  assert(toolNames.has("codex_followup"), "default tool surface should expose codex_followup", toolList.tools);
  for (const name of [
    "codex_session_start",
    "codex_session_prompt",
    "codex_session_steer",
    "codex_session_status",
    "codex_session_wait",
    "codex_sessions",
    "codex_session_recover",
    "codex_session_cancel",
    "codex_status",
    "codex_doctor",
    "codex_usage_guide",
    "codex_choose_tool",
    "codex_export_debug_bundle",
    "ask_codex",
    "ask_codex_parallel",
    "run_agent",
    "run_agents",
  ]) {
    assert(!toolNames.has(name), `non-native tool ${name} should be hidden by default`, toolList.tools);
  }
  const debugToolList = await listToolsWithEnv({
    PATH: process.env.PATH ?? "",
    CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS: "1",
    CLAUDE_PROJECT_DIR: projectDir,
    CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(projectDir, "debug-sessions.json"),
  });
  const debugToolNames = new Set(debugToolList.tools.map((tool) => tool.name));
  assert(debugToolNames.has("codex_status"), "debug tool surface should expose codex_status when enabled", debugToolList.tools);
  assert(debugToolNames.has("codex_doctor"), "debug tool surface should expose codex_doctor when enabled", debugToolList.tools);

  const resources = await client.listResources();
  const resourceUris = new Set(resources.resources.map((resource) => resource.uri));
  assert(resourceUris.has("codex://usage"), "usage resource should be listed", resources.resources);
  assert(resourceUris.has("codex://status"), "status resource should be listed", resources.resources);
  assert(resourceUris.has("codex://doctor"), "doctor resource should be listed", resources.resources);

  const status = await readJsonResource("codex://status");
  assert(status.ok, "codex://status failed", status);
  assert(status.defaultTools?.includes("codex_followup"), "codex://status should advertise native tools", status);
  const doctor = await readJsonResource("codex://doctor");
  assert(doctor.ok, "codex://doctor failed", doctor);
  const usage = await client.readResource({ uri: "codex://usage" });
  assert(
    usage.contents[0].text.includes("Use codex_followup when Claude already has a session_id"),
    "codex://usage should teach codex_followup",
    usage.contents[0].text,
  );

  const missingSession = await callTool("codex_followup", {
    session_id: "session-does-not-exist-smoke",
    mode: "wait",
    wait_timeout_ms: 10,
  });
  assert(missingSession.isError, "missing session should return an MCP error", missingSession);
  assert(
    missingSession.content?.[0]?.text?.includes("Unknown session_id: session-does-not-exist-smoke"),
    "native error text should include the underlying failure",
    missingSession,
  );

  const single = await callTool("codex_task", {
    description: "Single smoke",
    prompt: "single smoke RUN_COMMAND_EVENT",
    project_dir: projectDir,
    advanced: { model: "spark" },
  });
  assert(single.structuredContent?.ok, "codex_task should return ok", single.structuredContent);
  assert(single.structuredContent?.result?.includes("single smoke"), "codex_task should return answer-first result", single.structuredContent);
  assert(single.structuredContent?.session_id, "codex_task should return session_id", single.structuredContent);
  assert(
    single.structuredContent?.diagnostics?.cwd === projectDir &&
      single.structuredContent?.diagnostics?.model === "gpt-5.3-codex-spark" &&
      single.structuredContent?.diagnostics?.sandbox === "read-only",
    "codex_task did not preserve project/model/read-only defaults",
    single.structuredContent,
  );

  const structured = await callTool("codex_task", {
    description: "Structured smoke",
    prompt: "structured smoke JSON_FINAL=review_findings",
    project_dir: projectDir,
    advanced: { output_contract: "review_findings" },
  });
  assert(structured.structuredContent?.ok, "app-server output_contract should produce ok structured output", structured.structuredContent);
  assert(
    structured.structuredContent?.summary === "fake structured review",
    "structured output should summarize from the structured summary field",
    structured.structuredContent,
  );
  assert(
    structured.structuredContent?.structured?.findings?.[0]?.title === "Fake finding",
    "app-server output_contract should parse structured output",
    structured.structuredContent,
  );

  const followup = await callTool("codex_followup", {
    session_id: single.structuredContent.session_id,
    prompt: "single follow-up smoke",
  });
  assert(followup.structuredContent?.ok, "codex_followup should complete normal follow-ups", followup.structuredContent);
  assert(
    followup.structuredContent?.result?.includes("single follow-up smoke") &&
      followup.structuredContent?.session_id === single.structuredContent.session_id,
    "codex_followup should preserve session context",
    followup.structuredContent,
  );
  const waitedFirstTurn = await callTool("codex_followup", {
    session_id: single.structuredContent.session_id,
    mode: "wait",
    turn_id: single.structuredContent.turn?.id,
    wait_timeout_ms: 5_000,
  });
  assert(waitedFirstTurn.structuredContent?.completed === true, "turn-specific wait should complete", waitedFirstTurn.structuredContent);
  assert(
    waitedFirstTurn.structuredContent?.result?.includes("single smoke RUN_COMMAND_EVENT") &&
      !waitedFirstTurn.structuredContent?.result?.includes("single follow-up smoke"),
    "turn-specific wait should return the requested turn result, not session.lastResult",
    waitedFirstTurn.structuredContent,
  );

  const background = await callTool("codex_task", {
    description: "Background smoke",
    prompt: "background smoke DELAY_MS=1000",
    project_dir: projectDir,
    background: true,
  });
  assert(background.structuredContent?.status === "running", "background codex_task should return immediately", background.structuredContent);
  assert(background.structuredContent?.session_id, "background codex_task should return session_id", background.structuredContent);
  const steered = await callTool("codex_followup", {
    session_id: background.structuredContent.session_id,
    mode: "steer",
    prompt: "background steering smoke",
    background: true,
  });
  assert(steered.structuredContent?.ok, "codex_followup mode steer should return ok", steered.structuredContent);
  assert(
    steered.structuredContent?.delivery === "delivered_to_active_turn",
    "codex_followup mode steer should wait for app-server readiness and deliver live",
    steered.structuredContent,
  );
  const waited = await callTool("codex_followup", {
    session_id: background.structuredContent.session_id,
    mode: "wait",
    wait_timeout_ms: 5_000,
  });
  assert(waited.structuredContent?.completed === true, "codex_followup mode wait should collect completion", waited.structuredContent);
  assert(
    waited.structuredContent?.diagnostics?.session?.partial === undefined,
    "completed session diagnostics should not expose stale running partial state",
    waited.structuredContent,
  );
  assert(
    waited.structuredContent?.diagnostics?.session?.status === "idle",
    "completed session diagnostics should use idle status when no turn is running",
    waited.structuredContent,
  );

  const group = await callTool("codex_task_group", {
    tasks: [
      { name: "alpha", description: "Alpha smoke", prompt: "alpha DELAY_MS=20", project_dir: projectDir },
      { name: "beta", description: "Beta smoke", prompt: "beta DELAY_MS=20", project_dir: projectDir },
    ],
    max_parallel: 2,
  });
  const results = group.structuredContent?.results;
  assert(group.structuredContent?.ok, "codex_task_group failed", group.structuredContent);
  assert(Array.isArray(results) && results.length === 2, "expected two group results", group.structuredContent);
  assert(
    results.every(
      (result) =>
        result.session_id &&
        result.diagnostics?.cwd === projectDir &&
        result.diagnostics?.sandbox === "read-only",
    ),
    "codex_task_group should preserve project_dir/read-only defaults and return session ids",
    results,
  );

  const mixedGroup = await callTool("codex_task_group", {
    tasks: [
      { name: "ok", description: "Mixed ok", prompt: "mixed ok", project_dir: projectDir },
      {
        name: "bad",
        description: "Mixed bad",
        prompt: "mixed bad",
        project_dir: path.join(projectDir, "missing-project-dir"),
      },
    ],
    max_parallel: 2,
  });
  assert(mixedGroup.isError, "mixed codex_task_group should mark the call as an MCP error", mixedGroup);
  assert(
    mixedGroup.structuredContent?.ok === false &&
      mixedGroup.structuredContent?.results?.length === 2 &&
      mixedGroup.structuredContent.results.some((result) => result.ok) &&
      mixedGroup.structuredContent.results.some((result) => result.ok === false),
    "mixed codex_task_group should return successful and failed per-task results",
    mixedGroup.structuredContent,
  );

  const nested = await callTool("codex_task", {
    description: "Nested subagent smoke",
    prompt: "coordinate nested fake work",
    project_dir: projectDir,
    advanced: {
      model: "spark",
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
  });
  assert(
    nested.structuredContent?.ok &&
      nested.structuredContent?.diagnostics?.model === "gpt-5.3-codex-spark" &&
      nested.structuredContent?.diagnostics?.event_summary?.commands !== undefined,
    "nested native subagent smoke failed",
    nested.structuredContent,
  );

  console.log("MCP smoke test passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
}
