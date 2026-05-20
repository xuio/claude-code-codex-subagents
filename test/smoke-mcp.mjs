import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-smoke-project-"));
const recordDir = path.join(projectDir, "records");
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-smoke", version: "0.1.0" });
const resourceUpdates = [];
client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
  resourceUpdates.push(notification.params.uri);
});
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    CLAUDE_PROJECT_DIR: projectDir,
    CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(projectDir, "sessions.json"),
    FAKE_CODEX_RECORD_DIR: recordDir,
  },
  stderr: "pipe",
});
transport.stderr?.resume();

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

async function callToolOn(targetClient, name, args) {
  return targetClient.callTool(
    {
      name,
      arguments: args,
    },
    CallToolResultSchema,
  );
}

async function callTool(name, args) {
  return callToolOn(client, name, args);
}

async function readJsonResource(uri) {
  const resource = await client.readResource({ uri });
  return JSON.parse(resource.contents[0].text);
}

async function waitForCondition(read, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function recordedCalls() {
  try {
    return (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function listToolsWithEnv(env) {
  return withClientEnv(env, async (debugClient) => debugClient.listTools());
}

async function withClientEnv(env, run) {
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
    return await run(debugClient);
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
  assert(toolNames.has("codex_wait_any"), "default tool surface should expose codex_wait_any", toolList.tools);
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
  const resourceTemplates = await client.listResourceTemplates();
  assert(
    resourceTemplates.resourceTemplates.some((template) => template.uriTemplate === "codex://sessions/{session_id}"),
    "session resource template should be listed",
    resourceTemplates.resourceTemplates,
  );

  const status = await readJsonResource("codex://status");
  assert(status.ok, "codex://status failed", status);
  assert(status.defaultTools?.includes("codex_wait_any"), "codex://status should advertise wait-any as a native tool", status);
  assert(
    status.notifications?.resource_updates_enabled === true &&
      status.notifications?.max_milestones_per_session === 50,
    "codex://status should advertise notification settings",
    status,
  );
  assert(
    status.processes?.pluginProcesses?.some((process) => process.pid === status.processes.currentPid),
    "codex://status should include plugin process diagnostics",
    status.processes,
  );
  const doctor = await readJsonResource("codex://doctor");
  assert(doctor.ok, "codex://doctor failed", doctor);
  assert(
    doctor.checks?.some((check) => check.name === "stale_processes"),
    "codex://doctor should include stale process diagnostics",
    doctor,
  );
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
  const missingCancel = await callTool("codex_followup", {
    session_id: "session-does-not-exist-smoke",
    mode: "cancel",
  });
  assert(missingCancel.isError, "missing cancel session should return an MCP error", missingCancel);
  assert(
    missingCancel.content?.[0]?.text?.includes("Unknown session_id: session-does-not-exist-smoke"),
    "cancel error text should include the unknown session id",
    missingCancel,
  );

  await withClientEnv(
    {
      PATH: process.env.PATH ?? "",
      CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
      CLAUDE_PROJECT_DIR: projectDir,
      CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(projectDir, "capped-wait-sessions.json"),
      CODEX_SUBAGENTS_MAX_BLOCKING_WAIT_MS: "50",
      FAKE_CODEX_RECORD_DIR: recordDir,
    },
    async (cappedClient) => {
      const slow = await callToolOn(cappedClient, "codex_task", {
        description: "Capped wait smoke",
        prompt: "capped wait smoke DELAY_MS=500",
        project_dir: projectDir,
        background: true,
      });
      assert(slow.structuredContent?.session_id, "capped wait smoke should start a background session", slow);
      const cappedWait = await callToolOn(cappedClient, "codex_wait_any", {
        session_ids: [slow.structuredContent.session_id],
        wait_timeout_ms: 5_000,
      });
      assert(
        cappedWait.structuredContent?.completed === false &&
          cappedWait.structuredContent?.wait_timeout_capped === true &&
          cappedWait.structuredContent?.effective_wait_timeout_ms === 50 &&
          cappedWait.structuredContent?.requested_wait_timeout_ms === 5_000,
        "codex_wait_any should cap long blocking waits and return a running result",
        cappedWait.structuredContent,
      );
      assert(
        typeof cappedWait.structuredContent?.elapsed_ms === "number" &&
          cappedWait.structuredContent.elapsed_ms < 1_000,
        "capped wait should return before Claude Desktop's inactivity watchdog could fire",
        cappedWait.structuredContent,
      );
      const cancelled = await callToolOn(cappedClient, "codex_followup", {
        session_id: slow.structuredContent.session_id,
        mode: "cancel",
        reason: "capped wait smoke cleanup",
      });
      assert(cancelled.structuredContent?.status === "cancelled", "capped wait smoke cleanup should cancel the session", cancelled);
    },
  );

  const invalidReasoning = await callTool("codex_task", {
    description: "Invalid reasoning smoke",
    prompt: "should not start",
    project_dir: projectDir,
    advanced: { reasoning: "minimal" },
  });
  assert(invalidReasoning.isError, "invalid reasoning should return an MCP error", invalidReasoning);
  assert(
    invalidReasoning.content?.[0]?.text?.includes("reasoning_effort='minimal'"),
    "failed AgentRunResult text should include validation detail",
    invalidReasoning,
  );

  const timedOut = await callTool("codex_task", {
    description: "Timeout smoke",
    prompt: "timeout smoke DELAY_MS=500",
    project_dir: projectDir,
    advanced: { timeout_ms: 20, terminate_grace_ms: 20 },
  });
  assert(timedOut.isError, "timeout should return an MCP error", timedOut);
  assert(
    timedOut.content?.[0]?.text &&
      timedOut.content[0].text !== "Codex task timeout" &&
      timedOut.content[0].text.includes("Codex task timeout:"),
    "timeout AgentRunResult text should include failure detail",
    timedOut,
  );

  const emptyMcpServers = await callTool("codex_task", {
    description: "Empty MCP servers smoke",
    prompt: "empty mcp servers smoke",
    project_dir: projectDir,
    advanced: { codex_mcp_servers: {} },
  });
  assert(
    emptyMcpServers.structuredContent?.ok,
    "empty codex_mcp_servers should not infer mcp_config_policy=explicit",
    emptyMcpServers.structuredContent,
  );
  assert(
    !emptyMcpServers.structuredContent?.session_id &&
      !emptyMcpServers.structuredContent?.diagnostics &&
      !emptyMcpServers.structuredContent?.hint,
    "completed one-shot codex_task should default to a lean native-style payload",
    emptyMcpServers.structuredContent,
  );

  const single = await callTool("codex_task", {
    description: "Single smoke",
    prompt: "single smoke RUN_COMMAND_EVENT",
    project_dir: projectDir,
    keep_session: true,
    advanced: { model: "spark", include_diagnostics: true },
  });
  assert(single.structuredContent?.ok, "codex_task should return ok", single.structuredContent);
  assert(single.structuredContent?.result?.includes("single smoke"), "codex_task should return answer-first result", single.structuredContent);
  assert(single.structuredContent?.session_id, "codex_task should return session_id when keep_session is true", single.structuredContent);
  assert(
    !single.structuredContent?.commands &&
      single.structuredContent?.diagnostics?.commands?.[0]?.command === "rg example",
    "codex_task should keep command events in opt-in diagnostics",
    single.structuredContent,
  );
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
  assert(
    structured.content?.[0]?.text?.startsWith("fake structured review\n\n{"),
    "structured text content should lead with the summary before JSON",
    structured,
  );

  const persona = await callTool("codex_task", {
    description: "Review persona smoke",
    prompt: "persona smoke",
    project_dir: projectDir,
    subagent_type: "code-reviewer",
    advanced: { output_contract: "freeform" },
  });
  assert(persona.structuredContent?.ok, "code-reviewer persona task should complete", persona.structuredContent);

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
    advanced: { include_diagnostics: true },
  });
  assert(waitedFirstTurn.structuredContent?.completed === true, "turn-specific wait should complete", waitedFirstTurn.structuredContent);
  assert(
    waitedFirstTurn.structuredContent?.result?.includes("single smoke RUN_COMMAND_EVENT") &&
      !waitedFirstTurn.structuredContent?.result?.includes("single follow-up smoke"),
    "turn-specific wait should return the requested turn result, not session.lastResult",
    waitedFirstTurn.structuredContent,
  );
  assert(
    waitedFirstTurn.structuredContent?.diagnostics?.partial_result?.includes("single smoke RUN_COMMAND_EVENT") &&
      !waitedFirstTurn.structuredContent?.diagnostics?.partial_result?.includes("single follow-up smoke"),
    "turn-specific wait diagnostics should not expose the latest session result as partial_result",
    waitedFirstTurn.structuredContent,
  );
  const calls = await recordedCalls();
  const followupCall = calls.find((call) => call.method === "turn/start" && call.prompt?.includes("single follow-up smoke"));
  assert(followupCall, "expected recorded follow-up turn/start call", calls);
  assert(
    !followupCall.prompt.includes("Task description: Continue Codex session"),
    "codex_followup without an explicit description should not prepend boilerplate",
    followupCall,
  );
  const followupTimeoutSession = await callTool("codex_task", {
    description: "Follow-up timeout session",
    prompt: "follow-up timeout initial",
    project_dir: projectDir,
    keep_session: true,
  });
  const followupTimedOut = await callTool("codex_followup", {
    session_id: followupTimeoutSession.structuredContent.session_id,
    prompt: "follow-up timeout DELAY_MS=500",
    wait_timeout_ms: 20,
  });
  assert(
    followupTimedOut.structuredContent?.completed === false &&
      followupTimedOut.structuredContent?.timeoutReason === "wait_timeout" &&
      followupTimedOut.structuredContent?.effective_wait_timeout_ms === 20,
    "foreground codex_followup should honor wait_timeout_ms instead of waiting indefinitely",
    followupTimedOut.structuredContent,
  );
  await callTool("codex_followup", {
    session_id: followupTimeoutSession.structuredContent.session_id,
    mode: "cancel",
    reason: "follow-up timeout smoke cleanup",
  });
  const personaCall = calls.find((call) => call.method === "turn/start" && call.prompt?.includes("persona smoke"));
  assert(personaCall, "expected recorded persona turn/start call", calls);
  assert(
    personaCall.prompt.includes("You are a code-review subagent.") &&
      !personaCall.prompt.includes("Codex subagent type: code-reviewer"),
    "subagent_type should prepend a real persona instead of implementation jargon",
    personaCall,
  );

  const background = await callTool("codex_task", {
    description: "Background smoke",
    prompt: "background smoke DELAY_MS=1000",
    project_dir: projectDir,
    background: true,
  });
  assert(background.structuredContent?.status === "running", "background codex_task should return immediately", background.structuredContent);
  assert(background.structuredContent?.session_id, "background codex_task should return session_id", background.structuredContent);
  const backgroundResourceUri = `codex://sessions/${background.structuredContent.session_id}`;
  await client.subscribeResource({ uri: backgroundResourceUri });
  const backgroundResource = await readJsonResource(backgroundResourceUri);
  assert(
    backgroundResource.id === background.structuredContent.session_id &&
      backgroundResource.status === "running" &&
      Array.isArray(backgroundResource.milestones),
    "background session resource should expose running state and milestones",
    backgroundResource,
  );
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
    typeof waited.structuredContent?.last_milestone_seq === "number" &&
    !waited.structuredContent?.diagnostics && typeof waited.structuredContent?.elapsed_ms === "number",
    "codex_followup mode wait should default to a lean poll-shaped payload",
    waited.structuredContent,
  );
  await waitForCondition(() => resourceUpdates.includes(backgroundResourceUri));
  const completedBackgroundResource = await readJsonResource(backgroundResourceUri);
  assert(
    completedBackgroundResource.completed === true &&
      completedBackgroundResource.last_result?.status === "completed" &&
      completedBackgroundResource.last_milestone_seq >= backgroundResource.last_milestone_seq,
    "session resource should expose completion state after background task finishes",
    completedBackgroundResource,
  );
  await client.unsubscribeResource({ uri: backgroundResourceUri });
  const waitedWithDiagnostics = await callTool("codex_followup", {
    session_id: background.structuredContent.session_id,
    mode: "wait",
    wait_timeout_ms: 5_000,
    advanced: { include_diagnostics: true },
  });
  assert(
    waitedWithDiagnostics.structuredContent?.diagnostics?.session?.partial === undefined,
    "completed session diagnostics should not expose stale running partial state",
    waitedWithDiagnostics.structuredContent,
  );
  assert(
    waitedWithDiagnostics.structuredContent?.diagnostics?.session?.status === "idle",
    "completed session diagnostics should use idle status when no turn is running",
    waitedWithDiagnostics.structuredContent,
  );

  const waitAnySlow = await callTool("codex_task", {
    description: "Wait any slow",
    prompt: "wait-any-slow DELAY_MS=300",
    project_dir: projectDir,
    background: true,
  });
  const waitAnyFast = await callTool("codex_task", {
    description: "Wait any fast",
    prompt: "wait-any-fast DELAY_MS=30",
    project_dir: projectDir,
    background: true,
  });
  const waitAny = await callTool("codex_wait_any", {
    session_ids: [waitAnySlow.structuredContent.session_id, waitAnyFast.structuredContent.session_id],
    wait_timeout_ms: 5_000,
  });
  assert(waitAny.structuredContent?.completed === true, "codex_wait_any should complete when one session finishes", waitAny);
  assert(
    waitAny.structuredContent?.session_id === waitAnyFast.structuredContent.session_id &&
      waitAny.structuredContent?.remaining_session_ids?.includes(waitAnySlow.structuredContent.session_id) &&
      String(waitAny.structuredContent?.result ?? "").includes("wait-any-fast"),
    "codex_wait_any should return the first finished session and remaining ids",
    waitAny.structuredContent,
  );
  const waitAnyRemaining = await callTool("codex_wait_any", {
    session_ids: waitAny.structuredContent.remaining_session_ids,
    wait_timeout_ms: 5_000,
  });
  assert(
    waitAnyRemaining.structuredContent?.completed === true &&
      waitAnyRemaining.structuredContent?.session_id === waitAnySlow.structuredContent.session_id,
    "codex_wait_any should collect the remaining finisher on the next call",
    waitAnyRemaining.structuredContent,
  );

  const waitAnyUnknown = await callTool("codex_wait_any", {
    session_ids: ["session-does-not-exist-smoke"],
    wait_timeout_ms: 10,
  });
  assert(waitAnyUnknown.isError, "codex_wait_any should error for unknown session ids", waitAnyUnknown);
  assert(
    waitAnyUnknown.content?.[0]?.text?.includes("Unknown session_id: session-does-not-exist-smoke"),
    "codex_wait_any unknown-id error should be visible",
    waitAnyUnknown,
  );

  const alreadyCompletedCancel = await callTool("codex_followup", {
    session_id: single.structuredContent.session_id,
    mode: "cancel",
    reason: "smoke already complete",
  });
  assert(
    alreadyCompletedCancel.structuredContent?.status === "already_completed" &&
      alreadyCompletedCancel.structuredContent?.cancelled === false &&
      alreadyCompletedCancel.structuredContent?.was_active === false,
    "cancel on an already-completed session should be idempotent",
    alreadyCompletedCancel.structuredContent,
  );
  const singleThreadId = single.structuredContent?.diagnostics?.session?.codexThreadId;
  assert(singleThreadId, "single keep_session smoke should expose a diagnostic Codex thread id", single.structuredContent);
  await waitForCondition(async () =>
    (await recordedCalls()).some((call) => call.method === "thread/archive" && call.threadId === singleThreadId)
      ? true
      : undefined,
  );

  const cancellable = await callTool("codex_task", {
    description: "Cancellable smoke",
    prompt: "cancellable smoke APP_PROGRESS_AFTER_MS=10 DELAY_MS=5000",
    project_dir: projectDir,
    background: true,
  });
  assert(cancellable.structuredContent?.session_id, "cancellable background task should return session_id", cancellable.structuredContent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cancelled = await callTool("codex_followup", {
    session_id: cancellable.structuredContent.session_id,
    mode: "cancel",
    reason: "smoke test no longer needs it",
    advanced: { include_diagnostics: true },
  });
  assert(cancelled.structuredContent?.ok, "cancel should succeed", cancelled.structuredContent);
  assert(cancelled.structuredContent?.status === "cancelled", "cancel should report cancelled status", cancelled.structuredContent);
  assert(cancelled.structuredContent?.cancelled === true, "cancel response should set cancelled true", cancelled.structuredContent);
  assert(cancelled.structuredContent?.was_active === true, "cancel should report active work was interrupted", cancelled.structuredContent);
  assert(
    String(cancelled.structuredContent?.result ?? "").includes("progress") ||
      String(cancelled.structuredContent?.result ?? "").includes("no partial output"),
    "cancel should include partial output or an explicit no-partial message",
    cancelled.structuredContent,
  );

  const group = await callTool("codex_task_group", {
    tasks: [
      { name: "alpha", description: "Alpha smoke", prompt: "alpha DELAY_MS=20", project_dir: projectDir, keep_session: true },
      { name: "beta", description: "Beta smoke", prompt: "beta DELAY_MS=20", project_dir: projectDir, keep_session: true },
    ],
    max_parallel: 2,
    advanced: { include_diagnostics: true },
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
    "codex_task_group should preserve project_dir/read-only defaults and return session ids when requested",
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
      include_diagnostics: true,
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
