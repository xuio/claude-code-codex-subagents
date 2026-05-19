import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-stress-project-"));
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-stress", version: "0.1.0" });
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

  const status = await callTool("codex_status", {});
  assert(status.structuredContent?.queue?.maxGlobal >= 1, "codex_status should include queue stats", status);

  const starts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      callTool("start_agent_run", {
        name: `stress-${index + 1}`,
        prompt: `stress async ${index + 1} DELAY_MS=120`,
        project_dir: projectDir,
      }),
    ),
  );
  const jobIds = starts.map((start) => start.structuredContent?.job?.id);
  assert(jobIds.every(Boolean), "every async stress run should return a job id", starts);

  const waits = await Promise.all(
    jobIds.map((jobId) =>
      callTool("wait_agent_run", {
        job_id: jobId,
        timeout_ms: 10_000,
      }),
    ),
  );
  assert(
    waits.every(
      (wait) => wait.structuredContent?.job?.status === "completed" && wait.structuredContent?.job?.result?.ok,
    ),
    "all queued stress jobs should complete",
    waits.map((wait) => wait.structuredContent?.job),
  );

  const noisy = await callTool("run_agent", {
    prompt: "stress noisy MALFORMED_JSONL BIG_STDOUT_CHARS=5000 BIG_STDERR_CHARS=5000",
    project_dir: projectDir,
    max_output_chars: 1000,
  });
  const noisyAgent = noisy.structuredContent?.agent;
  assert(noisyAgent?.ok, "noisy malformed output run should still succeed", noisy);
  assert(noisyAgent.truncated?.stdoutChars > 0, "noisy stdout should be truncated", noisyAgent);
  assert(noisyAgent.truncated?.stderrChars > 0, "noisy stderr should be truncated", noisyAgent);
  assert(
    noisyAgent.eventSummary?.errors?.some((error) => String(error).includes("Unparseable Codex JSONL")),
    "malformed JSONL should be reported in event errors",
    noisyAgent.eventSummary,
  );

  console.log("MCP stress test passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
}
