import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

async function waitForExit(child, timeoutMs) {
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  return Promise.race([exited, delay(timeoutMs).then(() => undefined)]);
}

function initializeMessage(id = 1) {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-shutdown-test", version: "0.1.0" },
    },
  })}\n`;
}

async function runShutdownCase(name, action, extraEnv = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `codex-subagents-${name}-`));
  const child = spawn(path.join(root, "dist/index.js"), [], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(stateDir, "sessions.json"),
      CODEX_SUBAGENTS_LOG_LEVEL: "debug",
      ...extraEnv,
    },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  try {
    await delay(250);
    await action(child);

    const result = await waitForExit(child, 5_000);
    if (!result) {
      child.kill("SIGKILL");
      throw new Error(`MCP server did not exit for ${name}.\n${stderr}`);
    }
    assert(result.code === 0, `MCP server should exit cleanly for ${name}`, {
      result,
      stderr,
    });
    assert(
      !stderr.includes("uncaught_exception") && !stderr.includes("unhandled_rejection"),
      `broken stdio should not loop through uncaught exception logging for ${name}`,
      stderr,
    );
  } finally {
    child.kill("SIGKILL");
    await rm(stateDir, { recursive: true, force: true });
  }
}

await runShutdownCase("stdout-disconnect", async (child) => {
  child.stdout.destroy();
  child.stdin.write(initializeMessage());
});

await runShutdownCase("stdin-end", async (child) => {
  child.stdin.end();
});

await runShutdownCase("partial-json-disconnect", async (child) => {
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"');
  child.stdin.end();
});

await runShutdownCase("stderr-disconnect", async (child) => {
  child.stderr.destroy();
  child.stdin.write(initializeMessage());
});

await runShutdownCase(
  "forced-orphan",
  async () => {},
  {
    CODEX_SUBAGENTS_TEST_FORCE_ORPHAN: "1",
    CODEX_SUBAGENTS_ORPHAN_WATCHDOG_INTERVAL_MS: "25",
    CODEX_SUBAGENTS_ORPHAN_WATCHDOG_GRACE_MS: "25",
  },
);

console.log("Stdio shutdown test passed");
