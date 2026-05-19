import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-real-app-server-"));
const codexBin = process.env.CLAUDE_REAL_CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex";
const client = new Client({ name: "real-app-server-steering", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    CLAUDE_PROJECT_DIR: projectDir,
  },
  stderr: "pipe",
});
transport.stderr?.resume();

try {
  await client.connect(transport);
  const start = await client.callTool(
    {
      name: "start_codex_session_async",
      arguments: {
        task: "Real app-server steering probe. Stay read-only. Run the shell command `sleep 6`, then reply exactly REAL_APP_SERVER_START_OK unless a later steering instruction changes the exact final reply.",
        project_dir: projectDir,
        codex_bin: codexBin,
        model_preset: "spark",
        reasoning_effort: "low",
        timeout_ms: 180_000,
        isolated_codex_home: true,
      },
    },
    CallToolResultSchema,
    { timeout: 20_000, resetTimeoutOnProgress: true },
  );
  const sessionId = start.structuredContent?.session?.id;
  if (!sessionId) {
    throw new Error(`start_codex_session_async did not return a session id: ${JSON.stringify(start.structuredContent)}`);
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await client.callTool(
      { name: "get_codex_session", arguments: { session_id: sessionId } },
      CallToolResultSchema,
      { timeout: 10_000, resetTimeoutOnProgress: true },
    );
    if (current.structuredContent?.session?.supportsRealSteering && current.structuredContent?.session?.activeTurn) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const steer = await client.callTool(
    {
      name: "steer_codex_session",
      arguments: {
        session_id: sessionId,
        steering_prompt: "Steering update: change the exact final reply to REAL_APP_SERVER_STEER_OK.",
        codex_bin: codexBin,
        model_preset: "spark",
        reasoning_effort: "low",
        wait_for_completion: false,
        isolated_codex_home: true,
      },
    },
    CallToolResultSchema,
    { timeout: 30_000, resetTimeoutOnProgress: true },
  );
  if (steer.structuredContent?.delivery !== "delivered_to_active_turn") {
    throw new Error(`steer_codex_session was not delivered live: ${JSON.stringify(steer.structuredContent)}`);
  }

  const wait = await client.callTool(
    { name: "wait_codex_session", arguments: { session_id: sessionId, timeout_ms: 240_000 } },
    CallToolResultSchema,
    { timeout: 260_000, resetTimeoutOnProgress: true },
  );
  const finalMessage = wait.structuredContent?.session?.lastResult?.finalMessage ?? "";
  if (!wait.structuredContent?.completed || !finalMessage.includes("REAL_APP_SERVER_STEER_OK")) {
    throw new Error(`real app-server steering did not affect the final reply: ${JSON.stringify(wait.structuredContent)}`);
  }

  console.log("Real Codex app-server steering passed");
} finally {
  await transport.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
}
