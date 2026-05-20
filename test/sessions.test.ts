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
  delete process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL;
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
    const turnCalls = calls.filter((call) => call.method === "turn/start");
    expect(turnCalls).toHaveLength(2);
    expect(calls.some((call) => call.method === "thread/read")).toBe(true);
    const [initialCall, followUpCall] = turnCalls as [
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
    expect(calls.map((call) => call.method).filter((method) => method !== "thread/read")).toEqual(["turn/start", "turn/steer"]);
    manager.cancel(session.id);
  });

  it("returns the active turn result when waiting on live steering", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");

    const { session } = manager.startAsync({
      prompt: "session wait steering DELAY_MS=100",
      projectDir,
      codexBin: fakeCodex,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = manager.get(session.id);
      if (current?.supportsRealSteering && current.activeTurn) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const steered = await manager.steer(session.id, "waited steer prompt", {}, { wait: true });
    expect(steered.delivery).toBe("delivered_to_active_turn");
    expect(steered.result?.ok).toBe(true);
    expect(steered.result?.finalMessage).toContain("waited steer prompt");
    manager.cancel(session.id);
  });

  it("clears stale partial snapshots after turns complete", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");

    const started = await manager.start({
      prompt: "session partial cleanup DELAY_MS=20",
      projectDir,
      codexBin: fakeCodex,
    });

    expect(started.result.ok).toBe(true);
    expect(started.session.active).toBe(false);
    expect(started.session.partial).toBeUndefined();
    manager.cancel(started.session.id);
  });

  it("returns the requested turn result when waiting by turn id", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");

    const started = await manager.start({
      prompt: "session wait first A_DONE",
      projectDir,
      codexBin: fakeCodex,
    });
    const firstTurnId = started.session.recentTurns.at(-1)?.id;
    expect(firstTurnId).toBeTruthy();

    const followUp = await manager.send(started.session.id, "session wait second B_DONE");
    expect(followUp.result?.finalMessage).toContain("B_DONE");

    const waited = await manager.wait(started.session.id, 2_000, firstTurnId);
    expect(waited.completed).toBe(true);
    expect(waited.turn?.id).toBe(firstTurnId);
    expect(waited.result?.finalMessage).toContain("A_DONE");
    expect(waited.session?.lastResult?.finalMessage).toContain("B_DONE");
    manager.cancel(started.session.id);
  });

  it("does not fall back to exec for invalid app-server run configuration", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    await expect(
      manager.start({
        prompt: "invalid app-server configuration",
        projectDir,
        codexBin: fakeCodex,
        modelPreset: "spark",
        reasoningSummary: "concise",
        env: {
          FAKE_CODEX_RECORD_DIR: recordDir,
        },
      }),
    ).rejects.toThrow(/reasoning_summary='concise'/);

    await expect(readFile(path.join(recordDir, "calls.jsonl"), "utf8")).rejects.toThrow();
    await manager.shutdown("test_cleanup");
  });

  it("does not carry full-access bypass into later exec session prompts", async () => {
    process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL = "exec";
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const started = await manager.start({
      prompt: "session first full access",
      projectDir,
      codexBin: fakeCodex,
      dangerouslyBypassApprovalsAndSandbox: true,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(started.result.ok).toBe(true);
    expect(started.session.protocol).toBe("exec");
    expect(started.result.dangerouslyBypassApprovalsAndSandbox).toBe(true);

    const followUp = await manager.send(started.session.id, "session second safe");
    expect(followUp.result?.ok).toBe(true);
    expect(followUp.result?.dangerouslyBypassApprovalsAndSandbox).toBe(false);

    const calls = await recordedCalls(recordDir);
    expect(calls[0]?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls[1]?.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls[1]?.args).toContain('sandbox_mode="read-only"');
  });
});
