import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-advanced-project-"));
const recordDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-advanced-record-"));
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-advanced", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    ...process.env,
    CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS: "1",
    CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS: "1",
    CLAUDE_PROJECT_DIR: projectDir,
    CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(projectDir, "sessions.json"),
    FAKE_CODEX_RECORD_DIR: recordDir,
    CANARY_API_KEY: ["sk", "test1234567890abcdefghijklmnop"].join("-"),
  },
  stderr: "pipe",
});
let serverLogs = "";
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => {
  serverLogs += chunk;
});

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

async function readCalls() {
  try {
    return (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Boolean(await predicate());
}

try {
  await writeFile(
    path.join(projectDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        sample: {
          command: "node",
          args: ["server.js"],
        },
      },
    }),
    "utf8",
  );

  await client.connect(transport);

  const doctor = await callTool("codex_doctor", { project_dir: projectDir });
  assert(doctor.structuredContent?.ok, "codex_doctor should pass with fake Codex", doctor.structuredContent);

  const structured = await callTool("run_agent", {
    prompt: "JSON_FINAL=review_findings",
    project_dir: projectDir,
    output_contract: "review_findings",
  });
  const structuredAgent = structured.structuredContent?.agent;
  assert(structuredAgent?.ok, "structured run_agent should succeed", structured);
  assert(
    structuredAgent.structuredOutput?.findings?.[0]?.title === "Fake finding",
    "structuredOutput should parse the final JSON message",
    structuredAgent,
  );

  const leaked = await callTool("run_agent", {
    prompt: "LEAK_SECRET",
    project_dir: projectDir,
  });
  const leakedText = JSON.stringify(leaked.structuredContent);
  assert(!leakedText.includes("sk-test1234567890"), "tool output should redact API-key-like secrets", leaked.structuredContent);
  assert(!leakedText.includes("abc123secret"), "tool output should redact KEY=value canaries", leaked.structuredContent);

  const asyncStart = await callTool("start_agent_run", {
    prompt: "partial BIG_STDOUT_CHARS=1000 DELAY_MS=1000",
    project_dir: projectDir,
  });
  const jobId = asyncStart.structuredContent?.job?.id;
  assert(jobId, "start_agent_run should return a job id", asyncStart.structuredContent);
  assert(
    asyncStart.structuredContent?.durability?.survivesRestart === false,
    "start_agent_run should advertise that async jobs do not survive MCP restarts",
    asyncStart.structuredContent,
  );
  await new Promise((resolve) => setTimeout(resolve, 650));
  const partial = await callTool("get_agent_run", { job_id: jobId });
  assert(
    partial.structuredContent?.job?.partial?.stdoutTail?.length > 0,
    "get_agent_run should expose partial stdout snapshots",
    partial.structuredContent,
  );
  const waited = await callTool("wait_agent_run", { job_id: jobId, timeout_ms: 5_000 });
  assert(waited.structuredContent?.job?.status === "completed", "partial job should complete", waited.structuredContent);

  const sessionStart = await callTool("start_session", {
    prompt: "session start",
    session_name: "advanced",
    project_dir: projectDir,
  });
  const session = sessionStart.structuredContent?.session;
  assert(session?.id && session?.codexThreadId, "start_session should return session and Codex thread ids", sessionStart.structuredContent);
  const sessionNext = await callTool("send_session_prompt", {
    session_id: session.id,
    prompt: "session follow-up",
    project_dir: projectDir,
  });
  assert(sessionNext.structuredContent?.session?.turns === 2, "send_session_prompt should add a second turn", sessionNext.structuredContent);

  const aggregate = await callTool("run_agents_aggregate", {
    agents: [
      { name: "one", prompt: "JSON_FINAL=review_findings", project_dir: projectDir },
      { name: "two", prompt: "JSON_FINAL=review_findings", project_dir: projectDir },
    ],
    max_parallel: 2,
    output_contract: "review_findings",
  });
  assert(aggregate.structuredContent?.aggregation?.findings?.length === 2, "aggregation should collect structured findings", aggregate.structuredContent);

  const explicitMcp = await callTool("run_agent", {
    prompt: "explicit mcp",
    project_dir: projectDir,
    mcp_config_policy: "explicit",
    codex_mcp_servers: {
      explicit_server: {
        command: "node",
        args: ["explicit.js"],
      },
    },
  });
  assert(explicitMcp.structuredContent?.agent?.ok, "explicit MCP config run should succeed", explicitMcp.structuredContent);

  const fullAccess = await callTool("run_agent", {
    prompt: "full access path",
    project_dir: projectDir,
    dangerously_bypass_approvals_and_sandbox: true,
  });
  assert(fullAccess.structuredContent?.agent?.ok, "full-access run should succeed", fullAccess.structuredContent);
  assert(
    fullAccess.structuredContent?.agent?.dangerouslyBypassApprovalsAndSandbox === true,
    "full-access result should report the bypass flag",
    fullAccess.structuredContent,
  );

  const hugeOutput = await callTool("run_agent", {
    prompt: "huge output BIG_FINAL_CHARS=80000 BIG_STDOUT_CHARS=80000 BIG_STDERR_CHARS=80000",
    project_dir: projectDir,
  });
  const hugeAgent = hugeOutput.structuredContent?.agent;
  assert(hugeAgent?.ok, "huge output run should succeed", hugeOutput.structuredContent);
  assert(hugeAgent?.mcpResponse?.compacted === true, "huge output should be compacted for Claude", hugeAgent);
  assert(
    JSON.stringify(hugeOutput.structuredContent).length < 30_000,
    "huge output MCP response should stay comfortably below Claude overflow limits",
    { length: JSON.stringify(hugeOutput.structuredContent).length, compact: hugeAgent?.mcpResponse },
  );

  const hugeParallel = await callTool("run_agents", {
    agents: [
      { name: "huge-one", prompt: "huge parallel one BIG_FINAL_CHARS=80000", project_dir: projectDir },
      { name: "huge-two", prompt: "huge parallel two BIG_FINAL_CHARS=80000", project_dir: projectDir },
      { name: "huge-three", prompt: "huge parallel three BIG_FINAL_CHARS=80000", project_dir: projectDir },
    ],
    max_parallel: 3,
  });
  assert(hugeParallel.structuredContent?.ok, "huge parallel run should succeed", hugeParallel.structuredContent);
  assert(
    JSON.stringify(hugeParallel.structuredContent).length < 45_000,
    "huge parallel MCP response should stay below Claude overflow limits",
    { length: JSON.stringify(hugeParallel.structuredContent).length },
  );

  const hugeAsyncStart = await callTool("start_agent_run", {
    prompt: "huge async BIG_FINAL_CHARS=80000 BIG_STDOUT_CHARS=80000",
    project_dir: projectDir,
  });
  const hugeAsyncJobId = hugeAsyncStart.structuredContent?.job?.id;
  assert(hugeAsyncJobId, "huge async run should return a job id", hugeAsyncStart.structuredContent);
  const hugeAsyncWait = await callTool("wait_agent_run", { job_id: hugeAsyncJobId, timeout_ms: 5_000 });
  const hugeAsyncAgent = hugeAsyncWait.structuredContent?.job?.result;
  assert(hugeAsyncAgent?.ok, "huge async job should complete", hugeAsyncWait.structuredContent);
  assert(hugeAsyncAgent?.mcpResponse?.compacted === true, "huge async job result should be compacted", hugeAsyncAgent);
  assert(
    JSON.stringify(hugeAsyncWait.structuredContent).length < 30_000,
    "huge async MCP response should stay below Claude overflow limits",
    { length: JSON.stringify(hugeAsyncWait.structuredContent).length },
  );

  const abortController = new AbortController();
  const cancelledRun = client.callTool(
    {
      name: "run_agent",
      arguments: {
        prompt: "request cancellation propagation HANG_FOREVER",
        project_dir: projectDir,
        timeout_ms: 30_000,
      },
    },
    CallToolResultSchema,
    { signal: abortController.signal, timeout: 10_000 },
  );
  setTimeout(() => abortController.abort(), 100);
  await cancelledRun.then(
    () => {
      throw new Error("run_agent should reject when its MCP request is cancelled");
    },
    () => {},
  );
  const sawCancelledSigterm = await waitFor(async () =>
    (await readCalls()).some(
      (call) =>
        call.protocol === "exec" &&
        call.method === "process/sigterm" &&
        typeof call.prompt === "string" &&
        call.prompt.includes("request cancellation propagation"),
    ),
  );
  assert(sawCancelledSigterm, "request cancellation should terminate the Codex exec child");
  const missingJob = await callTool("get_agent_run", { job_id: "job-missing-for-diagnostics" });
  assert(missingJob.isError, "missing job lookup should return a structured error for diagnostics", missingJob.structuredContent);
  const afterCancelStatus = await callTool("codex_status", {});
  assert(afterCancelStatus.structuredContent?.ok, "server should remain usable after a cancelled MCP request", afterCancelStatus.structuredContent);
  assert(
    afterCancelStatus.structuredContent?.diagnostics?.retainedEvents >= 1,
    "codex_status should expose recent diagnostic events after failures",
    afterCancelStatus.structuredContent,
  );
  const debugBundle = await callTool("codex_export_debug_bundle", {});
  const diagnosticsPath = debugBundle.structuredContent?.diagnosticsPath;
  assert(typeof diagnosticsPath === "string", "codex_export_debug_bundle should return a diagnostics path", debugBundle.structuredContent);
  const debugPayload = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  assert(Array.isArray(debugPayload.recentDiagnostics), "debug bundle should include recent diagnostics", debugPayload);
  if (typeof debugBundle.structuredContent?.bundleDir === "string") {
    await rm(debugBundle.structuredContent.bundleDir, { recursive: true, force: true });
  }

  const calls = await readCalls();
  assert(calls.every((call) => call.hasCanaryApiKey === false), "secret env vars should not be forwarded by default", calls);
  assert(
    calls.some((call) => call.codexConfig?.includes("explicit_server")),
    "explicit MCP config should be materialized in a temp Codex home",
    calls,
  );
  assert(
    calls.some(
      (call) =>
        typeof call.prompt === "string" &&
        call.prompt.includes("JSON_FINAL=review_findings") &&
        call.args.includes("--output-schema"),
    ),
    "structured output contracts should pass --output-schema to Codex",
    calls,
  );
  assert(
    calls.some(
      (call) =>
        typeof call.prompt === "string" &&
        call.prompt.includes("full access path") &&
        call.args.includes("--dangerously-bypass-approvals-and-sandbox") &&
        !call.args.includes("--sandbox"),
    ),
    "full-access MCP calls should pass the Codex bypass flag without --sandbox",
    calls,
  );
  assert(
    calls.every((call) => !JSON.stringify(call.args).includes("CANARY_API_KEY")),
    "secret environment values should not be passed as command arguments",
    calls,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(serverLogs.includes('"event":"mcp.transport.inbound"'), "stderr logs should include raw MCP inbound frames", serverLogs);
  assert(serverLogs.includes('"event":"mcp.transport.outbound"'), "stderr logs should include raw MCP outbound frames", serverLogs);
  assert(serverLogs.includes('"method":"initialize"'), "raw MCP protocol logs should include initialize traffic", serverLogs);
  assert(serverLogs.includes('"event":"mcp.tool.call"'), "stderr logs should include MCP tool calls", serverLogs);
  assert(serverLogs.includes('"event":"mcp.tool.result"'), "stderr logs should include MCP tool results", serverLogs);
  assert(serverLogs.includes('"event":"codex.stdin"'), "stderr logs should include Codex stdin traffic", serverLogs);
  assert(serverLogs.includes('"event":"codex.stdout"'), "stderr logs should include Codex stdout traffic", serverLogs);
  assert(serverLogs.includes('"event":"mcp.progress"'), "stderr logs should include progress communication", serverLogs);
  assert(serverLogs.includes("LEAK_SECRET"), "raw MCP traffic logs should include unredacted prompts", serverLogs);

  console.log("Advanced MCP test passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
  await rm(recordDir, { recursive: true, force: true });
}
