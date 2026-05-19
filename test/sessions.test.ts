import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionManager } from "../src/sessions.js";

const fakeCodex = path.resolve("test/fixtures/fake-codex.mjs");
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function recordedCalls(recordDir: string): Promise<Array<{ args: string[]; cwd: string; prompt: string; [key: string]: unknown }>> {
  return (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CodexSessionManager", () => {
  it("uses app-server sessions by default and preserves the project directory", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const started = await manager.start({
      prompt: "session first",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(started.result.ok).toBe(true);
    expect(started.session.protocol).toBe("app-server");
    expect(started.session.supportsRealSteering).toBe(true);
    expect(started.session.projectDir).toBe(projectDir);
    expect(started.session.codexThreadId).toMatch(/^fake-thread-/);

    const followUp = await manager.send(started.session.id, "session second");

    expect(followUp.error).toBeUndefined();
    expect(followUp.result?.ok).toBe(true);
    expect(followUp.result?.cwd).toBe(projectDir);
    expect(followUp.session?.projectDir).toBe(projectDir);

    const calls = await recordedCalls(recordDir);
    expect(calls).toHaveLength(2);
    const [initialCall, followUpCall] = calls as [
      { args: string[]; cwd: string; prompt: string; protocol: string; method: string; threadId: string },
      { args: string[]; cwd: string; prompt: string; protocol: string; method: string; threadId: string },
    ];
    expect(initialCall.cwd).toBe(projectDir);
    expect(followUpCall.cwd).toBe(projectDir);
    expect(initialCall.protocol).toBe("app-server");
    expect(followUpCall.protocol).toBe("app-server");
    expect(followUpCall.method).toBe("turn/start");
    expect(followUpCall.threadId).toBe(started.session.codexThreadId);
    manager.cancel(started.session.id);
  });

  it("delivers steering to the active app-server turn", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const { session } = manager.startAsync({
      prompt: "session first DELAY_MS=150",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = manager.get(session.id);
      if (current?.supportsRealSteering && current.activeTurn) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const steered = await manager.steer(session.id, "steer this active turn", {}, { wait: false });
    expect(steered.delivery).toBe("delivered_to_active_turn");
    expect(steered.turn?.kind).toBe("steer");
    expect(steered.turn?.status).toBe("completed");

    const waited = await manager.wait(session.id, 2_000);
    expect(waited.completed).toBe(true);
    expect(waited.session?.turns).toBe(1);
    expect(waited.session?.lastResult?.finalMessage).toContain("steer this active turn");

    const calls = await recordedCalls(recordDir);
    expect(calls.map((call) => call.method)).toEqual(["turn/start", "turn/steer"]);
    manager.cancel(session.id);
  });
});
