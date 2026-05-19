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
    CLAUDE_PROJECT_DIR: projectDir,
    FAKE_CODEX_RECORD_DIR: recordDir,
    CANARY_API_KEY: ["sk", "test1234567890abcdefghijklmnop"].join("-"),
  },
  stderr: "pipe",
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

  const calls = (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(calls.every((call) => call.hasCanaryApiKey === false), "secret env vars should not be forwarded by default", calls);
  assert(
    calls.some((call) => call.codexConfig?.includes("explicit_server")),
    "explicit MCP config should be materialized in a temp Codex home",
    calls,
  );
  assert(
    calls.some((call) => call.prompt.includes("JSON_FINAL=review_findings") && call.args.includes("--output-schema")),
    "structured output contracts should pass --output-schema to Codex",
    calls,
  );
  assert(
    calls.some(
      (call) =>
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

  console.log("Advanced MCP test passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
  await rm(recordDir, { recursive: true, force: true });
}
