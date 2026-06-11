import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStateStore, type DurableSessionState } from "../src/session-state.js";
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

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  delete process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL;
  delete process.env.CODEX_SUBAGENTS_MAX_SESSIONS;
  await Promise.all(tempDirs.splice(0).map(removeTempDir));
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

  it("starts app-server sessions as normal desktop-visible Codex threads with task names", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const started = await manager.start({
      prompt: "desktop visible session",
      name: "Review desktop visibility",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(started.result.ok).toBe(true);
    const calls = await recordedCalls(recordDir);
    const threadStart = calls.find((call) => call.method === "thread/start");
    expect(threadStart?.threadSource).toBeNull();
    expect(threadStart?.serviceName).toBe("claude-code-codex-subagents");
    expect(calls.some((call) => call.method === "thread/name/set" && call.name === "Review desktop visibility")).toBe(
      true,
    );
    manager.cancel(started.session.id);
  });

  it("archives completed app-server desktop threads when explicitly cancelled", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const started = await manager.start({
      prompt: "archive completed session",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(started.result.ok).toBe(true);
    const cancelled = manager.cancel(started.session.id, "done with session");
    expect(cancelled?.status).toBe("cancelled");

    const calls = await waitFor(async () => {
      const current = await recordedCalls(recordDir);
      return current.some((call) => call.method === "thread/archive" && call.threadId === started.session.codexThreadId) &&
        current.some((call) => call.method === "process/sigterm")
        ? current
        : undefined;
    }, 10_000);
    const archiveIndex = calls.findIndex((call) => call.method === "thread/archive");
    const sigtermIndex = calls.findIndex((call) => call.method === "process/sigterm");
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(sigtermIndex).toBeGreaterThan(archiveIndex);
  });

  it("archives app-server desktop threads when retention pruning removes them", async () => {
    process.env.CODEX_SUBAGENTS_MAX_SESSIONS = "1";
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const first = await manager.start({
      prompt: "archive pruned session one",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await manager.start({
      prompt: "archive pruned session two",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(manager.list().map((session) => session.id)).toEqual([second.session.id]);
    await waitFor(async () => {
      const calls = await recordedCalls(recordDir);
      return calls.some((call) => call.method === "thread/archive" && call.threadId === first.session.codexThreadId)
        ? true
        : undefined;
    });
    manager.cancel(second.session.id);
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
    expect(calls.map((call) => call.method).filter((method) => method === "turn/start" || method === "turn/steer")).toEqual([
      "turn/start",
      "turn/steer",
    ]);
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

  it("can dispose completed one-shot app-server sessions without retaining child processes", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const started = await manager.start({
      prompt: "one shot dispose",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(started.result.ok).toBe(true);
    expect(started.result.queue?.queuedMs).toEqual(expect.any(Number));
    const disposed = manager.dispose(started.session.id, "test_one_shot_completed");
    expect(disposed?.id).toBe(started.session.id);
    expect(manager.get(started.session.id)).toBeUndefined();

    const calls = await waitFor(async () => {
      const current = await recordedCalls(recordDir);
      return current.some((call) => call.method === "process/sigterm") ? current : undefined;
    });
    expect(calls.some((call) => call.method === "thread/archive" && call.threadId === started.session.codexThreadId)).toBe(true);
  });

  it("bounds retained full turn history for long-running sessions", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");

    const started = await manager.start({
      prompt: "history turn 0",
      projectDir,
      codexBin: fakeCodex,
    });
    const firstTurnId = started.session.recentTurns.at(-1)?.id;
    expect(firstTurnId).toBeTruthy();

    for (let index = 1; index <= 55; index += 1) {
      const followUp = await manager.send(started.session.id, `history turn ${index}`);
      expect(followUp.result?.ok).toBe(true);
    }

    const session = manager.get(started.session.id);
    expect(session?.turns).toBe(56);
    expect(session?.recentTurns.length).toBeLessThanOrEqual(20);
    const oldTurn = await manager.wait(started.session.id, 10, firstTurnId);
    expect(oldTurn.error).toContain("Unknown turn_id");
    manager.cancel(started.session.id);
  });

  it("rejects follow-up sandbox escalation above the session creation ceiling", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");

    const started = await manager.start({
      prompt: "read only session",
      projectDir,
      codexBin: fakeCodex,
    });

    const escalated = await manager.send(
      started.session.id,
      "try full access",
      { dangerouslyBypassApprovalsAndSandbox: true },
      { wait: false },
    );

    expect(escalated.error).toContain("cannot be escalated");
    expect(escalated.turn).toBeUndefined();
    expect(manager.get(started.session.id)?.queuedTurns).toHaveLength(0);
    manager.cancel(started.session.id);
  });

  it("cancels active sessions, preserves partial output, and drains queued turns", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");

    const { session } = manager.startAsync({
      prompt: "session cancel partial APP_PROGRESS_AFTER_MS=650 DELAY_MS=5000",
      projectDir,
      codexBin: fakeCodex,
    });
    await waitFor(() => manager.get(session.id)?.partial?.lastAgentMessage);

    const queued = await manager.send(session.id, "queued before cancel", {}, { wait: false });
    expect(queued.turn?.status).toBe("queued");
    expect(manager.stats().queuedTurns).toBe(1);

    const cancelled = manager.cancel(session.id, "test changed direction");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.partial?.lastAgentMessage).toContain("progress");
    expect(cancelled?.queuedTurns).toHaveLength(0);
    expect(manager.stats().queuedTurns).toBe(0);
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

  it("publishes milestones to subscribers, caps the ring buffer, and waits for any session", async () => {
    const updates: string[] = [];
    const manager = new CodexSessionManager({
      maxMilestonesPerSession: 3,
      resourceDebounceMs: 5,
      resourceMaxDelayMs: 20,
      onSessionChanged: (sessionId) => {
        updates.push(sessionId);
      },
    });
    const projectDir = await tempDir("codex-subagents-session-project-");

    const { session } = manager.startAsync({
      prompt: "session wait any RUN_COMMAND_EVENT DELAY_MS=30",
      projectDir,
      codexBin: fakeCodex,
    });
    const seen: string[] = [];
    const unsubscribe = manager.subscribeMilestones(session.id, (milestone) => seen.push(milestone.kind));

    const waited = await manager.waitAny([session.id], 2_000);
    unsubscribe();

    expect(waited.completed).toBe(true);
    expect(waited.session?.id).toBe(session.id);
    expect(waited.result?.finalMessage).toContain("session wait any");
    expect(waited.remainingSessionIds).toEqual([]);
    expect(seen).toContain("turn_completed");
    expect(manager.get(session.id)?.milestones.length).toBeLessThanOrEqual(3);
    await waitFor(() => (updates.includes(session.id) ? true : undefined));
    manager.cancel(session.id);
  });

  it("reports unknown ids from waitAny without registering waiters", async () => {
    const manager = new CodexSessionManager();
    const waited = await manager.waitAny(["session-missing"], 10);

    expect(waited.completed).toBe(false);
    expect(waited.error).toBe("Unknown session_id: session-missing");
    expect(manager.stats().waiters).toBe(0);
  });

  it("fails fast when waiting on a recovered idle session with no local result", async () => {
    const stateDir = await tempDir("codex-subagents-idle-wait-state-");
    const stateFile = path.join(stateDir, "sessions.json");
    const now = new Date().toISOString();
    const state: DurableSessionState = {
      id: "session-recovered-idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
      codexThreadId: "thread-recovered-idle",
      protocol: "app-server",
      turns: 0,
      baseOptions: { projectDir: stateDir },
    };
    new SessionStateStore(stateFile).save([state]);
    const manager = new CodexSessionManager({ persist: true, stateFile });

    const startedAt = Date.now();
    const waitedAny = await manager.waitAny([state.id], 1_000);
    const waitedOne = await manager.wait(state.id, 1_000);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(waitedAny.completed).toBe(false);
    expect(waitedAny.error).toContain("idle recovered context");
    expect(waitedOne.completed).toBe(false);
    expect(waitedOne.error).toContain("idle recovered context");
  });

  it("redacts milestone text and does not persist milestones", async () => {
    process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL = "exec";
    const stateFile = path.join(await tempDir("codex-subagents-session-state-"), "sessions.json");
    const manager = new CodexSessionManager({ persist: true, stateFile });
    const projectDir = await tempDir("codex-subagents-session-project-");

    const started = await manager.start({
      prompt: "LEAK_SECRET",
      projectDir,
      codexBin: fakeCodex,
    });
    const milestoneJson = JSON.stringify(started.session.milestones);
    const stateJson = await readFile(stateFile, "utf8");

    expect(milestoneJson).not.toContain("sk-test1234567890abcdefghijklmnop");
    expect(milestoneJson).not.toContain("abc123secret");
    expect(stateJson).not.toContain("milestones");
    expect(stateJson).not.toContain("sk-test1234567890abcdefghijklmnop");

    const recovered = new CodexSessionManager({ persist: true, stateFile });
    expect(recovered.get(started.session.id)?.milestones).toEqual([]);
    expect(recovered.get(started.session.id)?.lastMilestoneSeq).toBe(0);
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
