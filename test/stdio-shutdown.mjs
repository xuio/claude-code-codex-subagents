import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-stdio-"));

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

async function waitForExit(child, timeoutMs) {
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  return Promise.race([exited, delay(timeoutMs).then(() => undefined)]);
}

try {
  const child = spawn(path.join(root, "dist/index.js"), [], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(stateDir, "sessions.json"),
      CODEX_SUBAGENTS_LOG_LEVEL: "debug",
    },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await delay(250);
  child.stdout.destroy();
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-shutdown-test", version: "0.1.0" },
    },
  })}\n`);

  const result = await waitForExit(child, 5_000);
  if (!result) {
    child.kill("SIGKILL");
    throw new Error(`MCP server did not exit after stdout disconnect.\n${stderr}`);
  }
  assert(result.code === 0, "MCP server should exit cleanly after stdout disconnect", {
    result,
    stderr,
  });
  assert(
    !stderr.includes("uncaught_exception") && !stderr.includes("unhandled_rejection"),
    "broken stdio should not loop through uncaught exception logging",
    stderr,
  );
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

console.log("Stdio shutdown test passed");
