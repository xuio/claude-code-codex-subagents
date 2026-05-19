import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-matrix-project-"));
const recordDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-matrix-record-"));
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-matrix", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    ...process.env,
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

async function readCalls() {
  try {
    const text = await readFile(path.join(recordDir, "calls.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  await writeFile(path.join(projectDir, "not-a-directory.txt"), "file");
  await client.connect(transport);

  const status = await callTool("codex_status", {});
  assert(status.structuredContent?.ok, "codex_status should succeed", status.structuredContent);
  assert(
    status.structuredContent.binary?.source === "plugin-config",
    "codex_status should use the configured fake Codex binary",
    status.structuredContent,
  );
  assert(status.structuredContent.defaultSandbox === "read-only", "default sandbox should be read-only");

  const defaultProject = await callTool("run_agent", {
    prompt: "matrix-default-project RUN_COMMAND_EVENT",
  });
  const defaultAgent = defaultProject.structuredContent?.agent;
  assert(defaultAgent?.ok, "run_agent should succeed with CLAUDE_PROJECT_DIR", defaultProject);
  assert(defaultAgent.cwd === projectDir, "run_agent should default to CLAUDE_PROJECT_DIR", defaultAgent);
  assert(defaultAgent.sandbox === "read-only", "run_agent should default to read-only", defaultAgent);
  assert(defaultAgent.serviceTier === undefined, "run_agent should not default service_tier", defaultAgent);
  assert(
    !defaultAgent.commandPreview.some((arg) => arg.includes("service_tier=")),
    "run_agent should omit service_tier unless explicitly requested",
    defaultAgent.commandPreview,
  );
  assert(
    defaultAgent.eventSummary?.commands?.[0]?.command === "rg example",
    "run_agent should parse command events",
    defaultAgent.eventSummary,
  );

  const frontDoorSingle = await callTool("ask_codex", {
    task: "matrix-front-door-single RUN_COMMAND_EVENT",
    project_dir: projectDir,
    model_preset: "spark",
  });
  const frontDoorAgent = frontDoorSingle.structuredContent?.agent;
  assert(frontDoorAgent?.ok, "ask_codex should succeed", frontDoorSingle);
  assert(frontDoorAgent.cwd === projectDir, "ask_codex should pass project_dir", frontDoorAgent);
  assert(frontDoorAgent.model === "gpt-5.3-codex-spark", "ask_codex should use Spark preset", frontDoorAgent);
  assert(
    frontDoorAgent.eventSummary?.commands?.[0]?.command === "rg example",
    "ask_codex should share run_agent event parsing",
    frontDoorAgent.eventSummary,
  );

  const explicitProject = await callTool("run_agent", {
    prompt: "matrix-explicit-project",
    project_dir: projectDir,
    reasoning_effort: "high",
    model: "gpt-5.3-codex",
    service_tier: "fast",
    model_verbosity: "low",
    reasoning_summary: "concise",
  });
  const explicitAgent = explicitProject.structuredContent?.agent;
  assert(explicitAgent?.ok, "run_agent should succeed with explicit settings", explicitProject);
  assert(explicitAgent.model === "gpt-5.3-codex", "explicit model should be reported", explicitAgent);
  assert(explicitAgent.reasoningEffort === "high", "explicit reasoning should be reported", explicitAgent);
  assert(
    explicitAgent.commandPreview.includes('model_verbosity="low"') &&
      explicitAgent.commandPreview.includes('model_reasoning_summary="concise"'),
    "model verbosity and reasoning summary should reach Codex args",
    explicitAgent.commandPreview,
  );

  const failed = await callTool("run_agent", {
    prompt: "matrix-failure EXIT_7",
    project_dir: projectDir,
  });
  assert(failed.isError, "failed run_agent should set MCP isError", failed);
  assert(failed.structuredContent?.agent?.status === "failed", "failed run should report failed status", failed);
  assert(failed.structuredContent?.agent?.exitCode === 7, "failed run should preserve exit code", failed);

  const timedOut = await callTool("run_agent", {
    prompt: "matrix-timeout DELAY_MS=250",
    project_dir: projectDir,
    timeout_ms: 50,
  });
  assert(timedOut.isError, "timed out run_agent should set MCP isError", timedOut);
  assert(
    timedOut.structuredContent?.agent?.status === "timeout",
    "timed out run should report timeout status",
    timedOut,
  );

  const invalidProject = await callTool("run_agent", {
    prompt: "matrix-invalid-project",
    project_dir: path.join(projectDir, "not-a-directory.txt"),
  });
  assert(invalidProject.isError, "invalid project_dir should set MCP isError", invalidProject);
  assert(
    String(invalidProject.structuredContent?.error ?? "").includes("not a directory"),
    "invalid project_dir should explain the directory problem",
    invalidProject.structuredContent,
  );

  const callsBeforeValidation = (await readCalls()).length;
  const invalidSparkSummary = await callTool("run_agent", {
    prompt: "matrix-invalid-spark-summary",
    project_dir: projectDir,
    model_preset: "spark",
    reasoning_summary: "concise",
  });
  assert(invalidSparkSummary.isError, "Spark reasoning_summary should fail at plugin layer");
  assert(
    invalidSparkSummary.structuredContent?.agent?.validationError?.includes("model_preset='spark'"),
    "Spark reasoning_summary failure should explain the unsupported pair",
    invalidSparkSummary.structuredContent,
  );
  assert(
    (await readCalls()).length === callsBeforeValidation,
    "Spark reasoning_summary validation should not spawn Codex",
  );

  const minimalReasoning = await callTool("run_agent", {
    prompt: "matrix-minimal-reasoning",
    project_dir: projectDir,
    reasoning_effort: "minimal",
  });
  assert(minimalReasoning.isError, "minimal reasoning should fail at plugin layer");
  assert(
    minimalReasoning.structuredContent?.agent?.validationError?.includes("web_search"),
    "minimal reasoning failure should explain the web_search incompatibility",
    minimalReasoning.structuredContent,
  );
  assert(
    (await readCalls()).length === callsBeforeValidation,
    "minimal reasoning validation should not spawn Codex",
  );

  const parallelStarted = Date.now();
  const parallel = await callTool("run_agents", {
    agents: Array.from({ length: 5 }, (_, index) => ({
      name: `parallel-${index + 1}`,
      prompt: `matrix-parallel-${index + 1} DELAY_MS=120`,
      project_dir: projectDir,
    })),
    max_parallel: 3,
  });
  const parallelDuration = Date.now() - parallelStarted;
  assert(parallel.structuredContent?.ok, "run_agents should succeed for parallel matrix", parallel);
  assert(
    parallel.structuredContent.agents?.length === 5,
    "run_agents should return every parallel agent result",
    parallel.structuredContent,
  );
  assert(
    parallel.structuredContent.agents.every((agent) => agent.cwd === projectDir),
    "parallel agents should all use project_dir",
    parallel.structuredContent.agents,
  );
  assert(parallelDuration < 650, "parallel agents should complete substantially faster than sequential", {
    parallelDuration,
  });

  const frontDoorParallel = await callTool("ask_codex_parallel", {
    tasks: [
      { name: "front-a", task: "matrix-front-parallel-a DELAY_MS=40", project_dir: projectDir },
      { name: "front-b", task: "matrix-front-parallel-b DELAY_MS=40", project_dir: projectDir },
    ],
    max_parallel: 2,
    model_preset: "spark",
  });
  assert(frontDoorParallel.structuredContent?.ok, "ask_codex_parallel should succeed", frontDoorParallel);
  assert(
    frontDoorParallel.structuredContent?.agents?.length === 2 &&
      frontDoorParallel.structuredContent.agents.every(
        (agent) => agent.cwd === projectDir && agent.model === "gpt-5.3-codex-spark",
      ),
    "ask_codex_parallel should pass shared project_dir and Spark preset",
    frontDoorParallel.structuredContent,
  );

  const mixed = await callTool("run_agents", {
    agents: [
      { name: "ok", prompt: "matrix-mixed-ok", project_dir: projectDir },
      { name: "bad", prompt: "matrix-mixed-bad EXIT_7", project_dir: projectDir },
    ],
    max_parallel: 2,
  });
  assert(mixed.isError, "mixed run_agents should set MCP isError", mixed);
  assert(mixed.structuredContent?.ok === false, "mixed run_agents should report ok=false", mixed);
  assert(
    mixed.structuredContent.agents?.some((agent) => agent.status === "failed"),
    "mixed run_agents should include the failed agent result",
    mixed.structuredContent,
  );

  const mixedValidation = await callTool("run_agents", {
    agents: [
      { name: "valid-a", prompt: "matrix-validation-valid-a", project_dir: projectDir },
      {
        name: "invalid-spark",
        prompt: "matrix-validation-invalid",
        project_dir: projectDir,
        model_preset: "spark",
        reasoning_summary: "concise",
      },
      { name: "valid-b", prompt: "matrix-validation-valid-b", project_dir: projectDir },
      { name: "valid-c", prompt: "matrix-validation-valid-c", project_dir: projectDir },
    ],
    max_parallel: 4,
  });
  assert(mixedValidation.isError, "run_agents should report error when one agent is invalid");
  assert(
    mixedValidation.structuredContent?.agents?.length === 4,
    "run_agents should return every validation-mixed result",
    mixedValidation.structuredContent,
  );
  assert(
    mixedValidation.structuredContent.agents.filter((agent) => agent.ok).length === 3 &&
      mixedValidation.structuredContent.agents.some((agent) =>
        agent.validationError?.includes("model_preset='spark'"),
      ),
    "run_agents should validate one bad agent without aborting siblings",
    mixedValidation.structuredContent,
  );

  const asyncParallelStart = await callTool("start_agents_run", {
    agents: [
      { name: "async-a", prompt: "matrix-async-a DELAY_MS=40", project_dir: projectDir },
      { name: "async-b", prompt: "matrix-async-b DELAY_MS=40", project_dir: projectDir },
    ],
    max_parallel: 2,
  });
  const asyncParallelJobId = asyncParallelStart.structuredContent?.job?.id;
  assert(asyncParallelJobId, "start_agents_run should return a job id", asyncParallelStart.structuredContent);
  assert(
    asyncParallelStart.structuredContent?.durability?.survivesRestart === false,
    "start_agents_run should advertise that async jobs do not survive MCP restarts",
    asyncParallelStart.structuredContent,
  );
  const asyncParallelDone = await callTool("wait_agent_run", {
    job_id: asyncParallelJobId,
    timeout_ms: 5_000,
  });
  assert(
    asyncParallelDone.structuredContent?.job?.status === "completed" &&
      asyncParallelDone.structuredContent?.job?.result?.agents?.length === 2,
    "wait_agent_run should return completed start_agents_run results",
    asyncParallelDone.structuredContent,
  );

  const nested = await callTool("run_agent", {
    prompt: "matrix-nested coordinate nested work",
    project_dir: projectDir,
    model_preset: "spark",
    codex_subagents: [
      {
        name: "ui_spark",
        description: "Fast focused UI iteration.",
        developer_instructions: "Stay scoped and concise.",
        nickname_candidates: ["Spark One", "Spark Two"],
        model_preset: "spark",
        reasoning_effort: "medium",
        sandbox: "read-only",
        mcp_servers: {
          docs: {
            command: "node",
            args: ["server.mjs"],
          },
        },
        skills_config: {
          playwright: {
            enabled: true,
          },
        },
        extra_config: {
          model_verbosity: "low",
        },
      },
    ],
    subagent_tasks: [
      { agent: "ui_spark", name: "toolbar", prompt: "Inspect the toolbar." },
      { agent: "explorer", name: "repo", prompt: "Map the repository." },
    ],
    subagent_runtime: {
      max_threads: 4,
      max_depth: 2,
      job_max_runtime_seconds: 900,
    },
  });
  const nestedAgent = nested.structuredContent?.agent;
  assert(nestedAgent?.ok, "nested Spark run should succeed", nested);
  assert(nestedAgent.model === "gpt-5.3-codex-spark", "spark preset should map to Spark model", nestedAgent);
  assert(nestedAgent.codexSubagents?.requestedTasks === 2, "nested tasks should be counted", nestedAgent);
  assert(
    nestedAgent.codexSubagents?.customAgents?.[0] === "ui_spark" &&
      nestedAgent.codexSubagents?.tempCodexHomeUsed,
    "nested run should materialize custom agents in a temp Codex home",
    nestedAgent.codexSubagents,
  );

  const calls = await readCalls();
  const nestedCall = calls.find(
    (call) => typeof call.prompt === "string" && call.prompt.includes("matrix-nested"),
  );
  assert(nestedCall, "fake Codex should record the nested call", calls);
  assert(
    nestedCall.prompt.includes("Spawn ui_spark as toolbar: Inspect the toolbar.") &&
      nestedCall.prompt.includes("Spawn explorer as repo: Map the repository."),
    "nested prompt should instruct parent Codex to spawn requested subagents",
    nestedCall.prompt,
  );
  assert(
    nestedCall.args.includes('agents.ui_spark.model="gpt-5.3-codex-spark"') &&
      !nestedCall.args.some((arg) => arg.includes("mcp_servers") || arg.includes("skills.config") || arg.includes("model_verbosity")) &&
      nestedCall.args.includes("agents.max_threads=4") &&
      nestedCall.args.includes("agents.max_depth=2") &&
      nestedCall.args.includes("agents.job_max_runtime_seconds=900"),
    "nested Codex args should include safe Spark/runtime overrides without nested MCP, skills, or extra config",
    nestedCall.args,
  );
  const agentToml = Object.values(nestedCall.agentFiles).join("\n");
  assert(agentToml.includes('model = "gpt-5.3-codex-spark"'), "nested temp agent TOML should include Spark");
  assert(agentToml.includes("[mcp_servers.docs]"), "nested temp agent TOML should include MCP config");
  assert(agentToml.includes("[skills.config.playwright]"), "nested temp agent TOML should include skills config");
  assert(agentToml.includes('model_verbosity = "low"'), "nested temp agent TOML should include extra config");
  await access(nestedCall.codexHome)
    .then(() => {
      throw new Error(`temporary CODEX_HOME was not cleaned up: ${nestedCall.codexHome}`);
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });

  const choice = await callTool("codex_choose_tool", {
    request: "run three independent Codex reviewers",
    task_count: 3,
    wants_parallel: true,
  });
  assert(
    choice.structuredContent?.recommendedTool === "ask_codex_parallel",
    "codex_choose_tool should recommend ask_codex_parallel for parallel work",
    choice.structuredContent,
  );

  const frontSessionStart = await callTool("start_codex_session", {
    task: "matrix-front-session first",
    project_dir: projectDir,
  });
  const frontSessionId = frontSessionStart.structuredContent?.session?.id;
  assert(frontSessionId, "start_codex_session should return a session id", frontSessionStart.structuredContent);
  const frontSessionNext = await callTool("continue_codex_session", {
    session_id: frontSessionId,
    task: "matrix-front-session second",
  });
  assert(
    frontSessionNext.structuredContent?.session?.turns === 2 &&
      frontSessionNext.structuredContent?.agent?.cwd === projectDir,
    "continue_codex_session should preserve the session project_dir",
    frontSessionNext.structuredContent,
  );

  const queuedCallsBefore = (await readCalls()).length;
  const queuedSessionStart = await callTool("start_codex_session_async", {
    task: "matrix-queued-session-start DELAY_MS=120",
    project_dir: projectDir,
  });
  const queuedSessionId = queuedSessionStart.structuredContent?.session?.id;
  assert(queuedSessionId, "start_codex_session_async should return a session id", queuedSessionStart.structuredContent);
  const queuedTurnId = queuedSessionStart.structuredContent?.turn?.id;
  assert(queuedTurnId, "start_codex_session_async should return the initial turn id", queuedSessionStart.structuredContent);
  const queuedFollow = await callTool("send_codex_session_prompt", {
    session_id: queuedSessionId,
    task: "matrix-queued-session-follow",
  });
  assert(
    queuedFollow.structuredContent?.queued === true &&
      queuedFollow.structuredContent?.turn?.kind === "prompt",
    "send_codex_session_prompt should queue without blocking by default",
    queuedFollow.structuredContent,
  );
  const queuedSteer = await callTool("steer_codex_session", {
    session_id: queuedSessionId,
    steering_prompt: "matrix-queued-session-steer",
  });
  assert(
    queuedSteer.structuredContent?.queued === true &&
      queuedSteer.structuredContent?.turn?.kind === "steer",
    "steer_codex_session should queue a steer turn by default",
    queuedSteer.structuredContent,
  );
  const queuedWait = await callTool("wait_codex_session", {
    session_id: queuedSessionId,
    timeout_ms: 5_000,
  });
  assert(
    queuedWait.structuredContent?.completed === true &&
      queuedWait.structuredContent?.session?.turns === 3 &&
      queuedWait.structuredContent?.session?.recentTurns?.some(
        (turn) => turn.kind === "steer" && turn.status === "completed",
      ),
    "wait_codex_session should wait for queued prompt and steering turns",
    queuedWait.structuredContent,
  );
  const queuedCalls = (await readCalls())
    .slice(queuedCallsBefore)
    .filter((call) => call.method === "turn/start")
    .map((call) => call.prompt);
  assert(
    queuedCalls[0]?.includes("matrix-queued-session-start") &&
      queuedCalls[1]?.includes("matrix-queued-session-steer") &&
      queuedCalls[2]?.includes("matrix-queued-session-follow"),
    "steering should run before older queued follow-up prompts",
    queuedCalls,
  );

  const interruptStart = await callTool("start_codex_session", {
    task: "matrix-interrupt-session-start",
    project_dir: projectDir,
  });
  const interruptSessionId = interruptStart.structuredContent?.session?.id;
  assert(interruptSessionId, "interrupt session should start", interruptStart.structuredContent);
  const interruptRunning = await callTool("send_codex_session_prompt", {
    session_id: interruptSessionId,
    task: "matrix-interrupt-active DELAY_MS=500",
  });
  assert(interruptRunning.structuredContent?.turn?.id, "interrupt active prompt should queue", interruptRunning.structuredContent);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await callTool("get_codex_session", { session_id: interruptSessionId });
    if (current.structuredContent?.session?.activeTurn?.prompt?.includes("matrix-interrupt-active")) break;
    await sleep(25);
  }
  const interruptSteer = await callTool("steer_codex_session", {
    session_id: interruptSessionId,
    steering_prompt: "matrix-interrupt-steer",
    interrupt_current: true,
  });
  assert(
    interruptSteer.structuredContent?.delivery === "interrupt_requested" &&
      interruptSteer.structuredContent?.turn?.kind === "steer",
    "interrupt steering should report interrupt delivery",
    interruptSteer.structuredContent,
  );
  const interruptWait = await callTool("wait_codex_session", {
    session_id: interruptSessionId,
    timeout_ms: 5_000,
  });
  const interruptTurns = interruptWait.structuredContent?.session?.recentTurns ?? [];
  assert(
    interruptWait.structuredContent?.completed === true &&
      interruptTurns.some(
        (turn) => turn.prompt.includes("matrix-interrupt-active") && turn.status === "cancelled",
      ) &&
      interruptTurns.some(
        (turn) => turn.prompt.includes("matrix-interrupt-steer") && turn.status === "completed",
      ),
    "interrupt steering should cancel the active turn and run the steer turn next",
    interruptWait.structuredContent,
  );

  const isolated = await callTool("run_agent", {
    prompt: "matrix-isolated-home",
    project_dir: projectDir,
    isolated_codex_home: true,
  });
  const isolatedAgent = isolated.structuredContent?.agent;
  assert(isolatedAgent?.ok, "isolated Codex home run should succeed", isolated);
  assert(
    isolatedAgent.codexSubagents?.tempCodexHomeUsed,
    "isolated Codex home should use a temporary CODEX_HOME",
    isolatedAgent,
  );
  const isolatedCall = (await readCalls()).find(
    (call) => typeof call.prompt === "string" && call.prompt.includes("matrix-isolated-home"),
  );
  assert(isolatedCall?.codexConfig?.includes("isolated codex-subagents run"), "isolated run should use minimal config", isolatedCall);

  console.log("Reliability matrix passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
  await rm(recordDir, { recursive: true, force: true });
}
