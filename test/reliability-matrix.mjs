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
    FAKE_CODEX_RECORD_DIR: recordDir,
  },
  stderr: "pipe",
});

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
  const nestedCall = calls.find((call) => call.prompt.includes("matrix-nested"));
  assert(nestedCall, "fake Codex should record the nested call", calls);
  assert(
    nestedCall.prompt.includes("Spawn ui_spark as toolbar: Inspect the toolbar.") &&
      nestedCall.prompt.includes("Spawn explorer as repo: Map the repository."),
    "nested prompt should instruct parent Codex to spawn requested subagents",
    nestedCall.prompt,
  );
  assert(
    nestedCall.args.includes('agents.ui_spark.model="gpt-5.3-codex-spark"') &&
      nestedCall.args.includes('agents.ui_spark.mcp_servers.docs.command="node"') &&
      nestedCall.args.includes("agents.ui_spark.skills.config.playwright.enabled=true") &&
      nestedCall.args.includes("agents.max_threads=4") &&
      nestedCall.args.includes("agents.max_depth=2") &&
      nestedCall.args.includes("agents.job_max_runtime_seconds=900"),
    "nested Codex args should include Spark, custom agent, MCP, skills, and runtime overrides",
    nestedCall.args,
  );
  const agentToml = Object.values(nestedCall.agentFiles).join("\n");
  assert(agentToml.includes('model = "gpt-5.3-codex-spark"'), "nested temp agent TOML should include Spark");
  await access(nestedCall.codexHome)
    .then(() => {
      throw new Error(`temporary CODEX_HOME was not cleaned up: ${nestedCall.codexHome}`);
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });

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
  const isolatedCall = (await readCalls()).find((call) => call.prompt.includes("matrix-isolated-home"));
  assert(isolatedCall?.codexConfig?.includes("isolated codex-subagents run"), "isolated run should use minimal config", isolatedCall);

  console.log("Reliability matrix passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
  await rm(recordDir, { recursive: true, force: true });
}
