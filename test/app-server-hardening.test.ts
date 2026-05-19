import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunQueue, BackpressureError, CodexJobManager } from "../src/jobs.js";
import { SessionStateStore, type DurableSessionState } from "../src/session-state.js";
import { CodexSessionManager } from "../src/sessions.js";

const fakeCodex = path.resolve("test/fixtures/fake-codex.mjs");
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function recordedCalls(recordDir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path.join(recordDir, "calls.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(await predicate());
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("app-server hardening", () => {
  it("survives protocol noise, server requests, duplicate completions, and large streams", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-chaos-project-");
    const recordDir = await tempDir("codex-subagents-app-chaos-record-");

    const { session, result } = await manager.start({
      prompt:
        "APP_MALFORMED_JSON APP_PARTIAL_LINES APP_DUPLICATE_COMPLETED APP_SERVER_REQUEST APP_SERVER_ERROR APP_LARGE_STREAM_CHARS=80000 APP_STDERR_CHARS=30000",
      projectDir,
      codexBin: fakeCodex,
      maxOutputChars: 20_000,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.truncated.stdoutChars).toBeGreaterThan(0);
    expect(result.truncated.stderrChars).toBeGreaterThan(0);
    expect(result.outputArtifacts?.stdoutPath).toBeTruthy();
    if (result.outputArtifacts?.stdoutPath) await access(result.outputArtifacts.stdoutPath);
    expect(result.eventSummary.errors.join("\n")).toContain("Unparseable Codex app-server line");
    expect(result.eventSummary.errors.join("\n")).toContain("fake app-server error");
    expect(session.appServer?.supports.turnStart).toBe(true);

    const calls = await recordedCalls(recordDir);
    expect(calls.some((call) => call.method === "turn/start")).toBe(true);
    expect(calls.some((call) => call.method === "client/response")).toBe(true);
    manager.cancel(session.id);
  });

  it("captures app-server notifications emitted with the turn/start response", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-inline-project-");

    const { result, session } = await manager.start({
      prompt: "APP_COMPLETE_INLINE",
      projectDir,
      codexBin: fakeCodex,
      timeoutMs: 500,
      terminateGraceMs: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.finalMessage).toContain("fake app-server result");
    expect(result.timeoutReason).toBeUndefined();
    manager.cancel(session.id);
  });

  it("resets app-server idle timeouts when output is still flowing", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-idle-project-");

    const { result, session } = await manager.start({
      prompt: "APP_PROGRESS_AFTER_MS=30 DELAY_MS=70",
      projectDir,
      codexBin: fakeCodex,
      idleTimeoutMs: 50,
      timeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    expect(result.timeoutReason).toBeUndefined();
    expect(result.finalMessage).toContain("fake app-server result");
    manager.cancel(session.id);
  });

  it("returns a specific timeout reason when interrupt never produces turn completion", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-timeout-project-");

    const { result, session } = await manager.start({
      prompt: "APP_NO_TURN_COMPLETED APP_IGNORE_INTERRUPT_COMPLETION DELAY_MS=5",
      projectDir,
      codexBin: fakeCodex,
      timeoutMs: 30,
      terminateGraceMs: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.timeoutReason).toBe("app_server_no_completion");
    expect(result.eventSummary.errors.join("\n")).toContain("did not report turn completion");
    manager.cancel(session.id);
  });

  it("resumes queued work on a fresh app-server after no-completion timeout", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-timeout-resume-project-");
    const recordDir = await tempDir("codex-subagents-app-timeout-resume-record-");

    const { session, turn } = manager.startAsync({
      prompt: "APP_NO_TURN_COMPLETED APP_IGNORE_INTERRUPT_COMPLETION DELAY_MS=10000",
      projectDir,
      codexBin: fakeCodex,
      timeoutMs: 30,
      terminateGraceMs: 30,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    const timedOut = await manager.wait(session.id, 2_000, turn.id);
    expect(timedOut.completed).toBe(true);
    expect(timedOut.turn?.resultStatus).toBe("timeout");

    const followUp = await manager.send(session.id, "after timeout follow-up");
    expect(followUp.result?.ok).toBe(true);
    expect(followUp.result?.finalMessage).toContain("after timeout follow-up");

    const calls = await recordedCalls(recordDir);
    expect(calls.some((call) => call.method === "turn/interrupt")).toBe(true);
    expect(calls.some((call) => call.method === "process/sigterm")).toBe(true);
    expect(calls.some((call) => call.method === "thread/resume")).toBe(true);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    manager.cancel(session.id);
  });

  it("preserves timeout status when a timed-out turn completes as interrupted", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-timeout-interrupted-project-");

    const { result, session } = await manager.start({
      prompt: "timeout interrupted probe DELAY_MS=500",
      projectDir,
      codexBin: fakeCodex,
      timeoutMs: 30,
      terminateGraceMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.timeoutReason).toBe("timeout");
    manager.cancel(session.id);
  });

  it("terminates the app-server child process when a session is cancelled", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-cancel-project-");
    const recordDir = await tempDir("codex-subagents-app-cancel-record-");

    const { session } = manager.startAsync({
      prompt: "long app-server turn DELAY_MS=10000",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    const becameActive = await waitFor(() => Boolean(manager.get(session.id)?.appServer?.activeTurnId));
    expect(becameActive).toBe(true);
    const cancelled = manager.cancel(session.id);
    expect(cancelled?.status).toBe("cancelled");

    const sawSigterm = await waitFor(async () => {
      const calls = await recordedCalls(recordDir);
      return calls.some((call) => call.method === "process/sigterm");
    });
    expect(sawSigterm).toBe(true);
  });

  it("keeps concurrent app-server sessions isolated", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-concurrent-project-");
    const recordDir = await tempDir("codex-subagents-app-concurrent-record-");

    const sessions = [0, 1, 2, 3].map((index) =>
      manager.startAsync({
        prompt: `concurrent-${index} DELAY_MS=${index === 1 ? 10000 : 500}`,
        projectDir,
        codexBin: fakeCodex,
        env: {
          FAKE_CODEX_RECORD_DIR: recordDir,
        },
      }).session,
    );

    const allActive = await waitFor(() =>
      sessions.every((session) => Boolean(manager.get(session.id)?.appServer?.activeTurnId)),
    );
    expect(allActive).toBe(true);

    const [session0, session1, session2, session3] = sessions;
    if (!session0 || !session1 || !session2 || !session3) throw new Error("expected four sessions");

    const steered = await manager.steer(session0.id, "only session zero steering", {}, { wait: false });
    expect(steered.delivery).toBe("delivered_to_active_turn");
    const queued = await manager.send(session2.id, "session two follow-up", {}, { wait: false });
    expect(queued.turn?.status).toBe("queued");
    manager.cancel(session1.id);

    const waited = await Promise.all([
      manager.wait(session0.id, 2_000),
      manager.wait(session1.id, 2_000),
      manager.wait(session2.id, 2_000),
      manager.wait(session3.id, 2_000),
    ]);

    const [wait0, wait1, wait2, wait3] = waited;
    if (!wait0 || !wait1 || !wait2 || !wait3) throw new Error("expected four wait results");
    expect(waited.every((item) => item.completed)).toBe(true);
    expect(wait0.session?.lastResult?.finalMessage).toContain("only session zero steering");
    expect(wait1.session?.status).toBe("cancelled");
    expect(wait2.session?.turns).toBe(2);
    expect(wait3.session?.turns).toBe(1);

    const calls = await recordedCalls(recordDir);
    const appTurnStarts = calls.filter((call) => call.protocol === "app-server" && call.method === "turn/start");
    expect(appTurnStarts.length).toBeGreaterThanOrEqual(5);
    for (const session of sessions) manager.cancel(session.id);
  });

  it("reports app-server fallback reason when startup fails", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-fallback-project-");

    const { session, result } = await manager.start({
      prompt: "fallback after thread start error",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_APP_SERVER_MODE: "THREAD_START_ERROR",
      },
    });

    expect(result.ok).toBe(true);
    expect(session.protocol).toBe("exec");
    expect(session.supportsRealSteering).toBe(false);
    expect(session.appServerFallbackReason).toContain("fake thread start error");
    manager.cancel(session.id);
  });

  it("does not fall back to exec after turn/start may have been accepted", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-turn-timeout-project-");
    const recordDir = await tempDir("codex-subagents-app-turn-timeout-record-");

    const { session, turn } = manager.startAsync({
      prompt: "TURN_START_NO_RESPONSE",
      projectDir,
      codexBin: fakeCodex,
      spawnTimeoutMs: 300,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    const waited = await manager.wait(session.id, 2_000, turn.id);
    expect(waited.completed).toBe(true);
    expect(waited.turn?.status).toBe("failed");
    expect(waited.session?.protocol).toBe("app-server");

    const calls = await recordedCalls(recordDir);
    expect(calls.some((call) => call.protocol === "app-server" && call.method === "turn/start")).toBe(true);
    expect(calls.some((call) => call.protocol === "exec")).toBe(false);
    expect(calls.some((call) => call.method === "process/sigterm")).toBe(true);
    manager.cancel(session.id);
  });

  it("recreates a closed idle app-server through thread/resume before a follow-up", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-closed-resume-project-");
    const recordDir = await tempDir("codex-subagents-app-closed-resume-record-");

    const started = await manager.start({
      prompt: "APP_EXIT_AFTER_TURN closed idle app-server",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    const closed = await waitFor(() => Boolean(manager.get(started.session.id)?.appServer?.closed));
    expect(closed).toBe(true);

    const followUp = await manager.send(started.session.id, "closed app-server follow-up");
    expect(followUp.result?.ok).toBe(true);
    expect(followUp.result?.finalMessage).toContain("closed app-server follow-up");

    const calls = await recordedCalls(recordDir);
    expect(calls.some((call) => call.method === "thread/resume" && call.threadId === started.session.codexThreadId)).toBe(true);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    manager.cancel(started.session.id);
  });

  it("merges durable session state instead of overwriting unknown sessions", async () => {
    const stateDir = await tempDir("codex-subagents-state-merge-");
    const store = new SessionStateStore(path.join(stateDir, "sessions.json"));
    const now = new Date().toISOString();
    const state = (id: string): DurableSessionState => ({
      id,
      status: "active",
      createdAt: now,
      updatedAt: now,
      codexThreadId: `thread-${id}`,
      protocol: "app-server",
      turns: 1,
      baseOptions: { projectDir: stateDir },
    });

    store.save([state("external")], { replaceIds: ["external"] });
    store.save([state("local")], { replaceIds: ["local"] });

    expect(store.load().map((session) => session.id).sort()).toEqual(["external", "local"]);
  });

  it("marks live steering unsupported when turn/steer fails", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-steer-fail-project-");

    const { session } = manager.startAsync({
      prompt: "steer failure probe DELAY_MS=500",
      projectDir,
      codexBin: fakeCodex,
    });

    const becameActive = await waitFor(() => Boolean(manager.get(session.id)?.appServer?.activeTurnId));
    expect(becameActive).toBe(true);
    const steered = await manager.steer(session.id, "APP_TURN_STEER_ERROR", {}, { wait: false });
    expect(steered.delivery).toBe("queued_after_current");
    expect(steered.session?.appServer?.supports.turnSteer).toBe(false);
    expect(steered.session?.appServer?.lastError).toContain("fake steer error");
    manager.cancel(session.id);
  });

  it("recovers a persisted app-server session through thread/resume", async () => {
    const stateDir = await tempDir("codex-subagents-state-");
    const stateFile = path.join(stateDir, "sessions.json");
    const projectDir = await tempDir("codex-subagents-recover-project-");
    const recordDir = await tempDir("codex-subagents-recover-record-");
    const firstManager = new CodexSessionManager({ persist: true, stateFile });
    const previousRecordDir = process.env.FAKE_CODEX_RECORD_DIR;

    try {
      process.env.FAKE_CODEX_RECORD_DIR = recordDir;
      const started = await firstManager.start({
        prompt: "recoverable first",
        projectDir,
        codexBin: fakeCodex,
      });

      const secondManager = new CodexSessionManager({ persist: true, stateFile });
      const loaded = secondManager.get(started.session.id);
      expect(loaded?.durable?.recovered).toBe(true);
      expect(loaded?.codexThreadId).toBe(started.session.codexThreadId);

      const recovered = await secondManager.recover(started.session.id);
      expect(recovered.recovered).toBe(true);
      expect(recovered.session?.appServer?.supports.threadResume).toBe(true);

      const followUp = await secondManager.send(started.session.id, "recoverable second");
      expect(followUp.result?.ok).toBe(true);
      expect(followUp.result?.finalMessage).toContain("recoverable second");

      const calls = await recordedCalls(recordDir);
      expect(calls.some((call) => call.method === "thread/resume" && call.threadId === started.session.codexThreadId)).toBe(true);
      expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
      await Promise.all([firstManager.shutdown("test_cleanup"), secondManager.shutdown("test_cleanup")]);
    } finally {
      if (previousRecordDir === undefined) delete process.env.FAKE_CODEX_RECORD_DIR;
      else process.env.FAKE_CODEX_RECORD_DIR = previousRecordDir;
    }
  });

  it("serializes concurrent app-server recovery attempts for one session", async () => {
    const stateDir = await tempDir("codex-subagents-recover-lock-state-");
    const stateFile = path.join(stateDir, "sessions.json");
    const projectDir = await tempDir("codex-subagents-recover-lock-project-");
    const recordDir = await tempDir("codex-subagents-recover-lock-record-");
    const firstManager = new CodexSessionManager({ persist: true, stateFile });
    const previousRecordDir = process.env.FAKE_CODEX_RECORD_DIR;
    const previousMode = process.env.FAKE_CODEX_APP_SERVER_MODE;

    try {
      process.env.FAKE_CODEX_RECORD_DIR = recordDir;
      const started = await firstManager.start({
        prompt: "recover lock first",
        projectDir,
        codexBin: fakeCodex,
      });

      process.env.FAKE_CODEX_APP_SERVER_MODE = "THREAD_RESUME_DELAY_MS=100";
      const secondManager = new CodexSessionManager({ persist: true, stateFile });
      const recovered = await Promise.all([
        secondManager.recover(started.session.id),
        secondManager.recover(started.session.id),
        secondManager.recover(started.session.id),
      ]);

      expect(recovered.every((result) => result.recovered)).toBe(true);
      const calls = await recordedCalls(recordDir);
      expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
      await Promise.all([firstManager.shutdown("test_cleanup"), secondManager.shutdown("test_cleanup")]);
    } finally {
      if (previousRecordDir === undefined) delete process.env.FAKE_CODEX_RECORD_DIR;
      else process.env.FAKE_CODEX_RECORD_DIR = previousRecordDir;
      if (previousMode === undefined) delete process.env.FAKE_CODEX_APP_SERVER_MODE;
      else process.env.FAKE_CODEX_APP_SERVER_MODE = previousMode;
    }
  });

  it("persists first async app-server thread before the first turn completes", async () => {
    const stateDir = await tempDir("codex-subagents-first-turn-state-");
    const stateFile = path.join(stateDir, "sessions.json");
    const projectDir = await tempDir("codex-subagents-first-turn-project-");
    const firstManager = new CodexSessionManager({ persist: true, stateFile });

    const { session } = firstManager.startAsync({
      prompt: "first async durable turn DELAY_MS=10000",
      projectDir,
      codexBin: fakeCodex,
    });

    const persisted = await waitFor(async () => {
      const states = new SessionStateStore(stateFile).load();
      return states.some((state) => state.id === session.id && state.codexThreadId && state.turns === 0);
    });
    expect(persisted).toBe(true);

    const secondManager = new CodexSessionManager({ persist: true, stateFile });
    const loaded = secondManager.get(session.id);
    expect(loaded?.durable?.canResume).toBe(true);
    expect(loaded?.turns).toBe(0);

    const recovered = await secondManager.recover(session.id);
    expect(recovered.recovered).toBe(true);
    expect(recovered.session?.codexThreadId).toBe(loaded?.codexThreadId);
    await Promise.all([firstManager.shutdown("test_cleanup"), secondManager.shutdown("test_cleanup")]);
  });

  it("returns a failed result if the app-server exits mid-turn", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-exit-project-");

    const { result, session } = await manager.start({
      prompt: "APP_EXIT_DURING_TURN",
      projectDir,
      codexBin: fakeCodex,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.eventSummary.errors.join("\n")).toContain("Codex app-server exited");
    manager.cancel(session.id);
  });

  it("applies explicit backpressure to queued session turns", async () => {
    const previous = process.env.CODEX_SUBAGENTS_MAX_SESSION_QUEUED_TURNS;
    process.env.CODEX_SUBAGENTS_MAX_SESSION_QUEUED_TURNS = "1";
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-backpressure-project-");
    try {
      const { session } = manager.startAsync({
        prompt: "session backpressure DELAY_MS=200",
        projectDir,
        codexBin: fakeCodex,
      });
      const queued = await manager.send(session.id, "queued once", {}, { wait: false });
      expect(queued.turn?.status).toBe("queued");
      await expect(manager.send(session.id, "queued twice", {}, { wait: false })).rejects.toBeInstanceOf(BackpressureError);
      manager.cancel(session.id);
    } finally {
      if (previous === undefined) delete process.env.CODEX_SUBAGENTS_MAX_SESSION_QUEUED_TURNS;
      else process.env.CODEX_SUBAGENTS_MAX_SESSION_QUEUED_TURNS = previous;
      await manager.shutdown("test_cleanup");
    }
  });

  it("applies explicit backpressure to pending queued agent runs", async () => {
    const queue = new AgentRunQueue(0, 1, 1);
    const controller = new AbortController();
    const first = queue.enqueue(() => Promise.resolve("first"), { projectKey: "p", signal: controller.signal });
    await expect(queue.enqueue(() => Promise.resolve("second"), { projectKey: "p" })).rejects.toBeInstanceOf(BackpressureError);
    controller.abort();
    await expect(first).rejects.toThrow(/cancelled/);
  });

  it("marks wait timeouts without cancelling the running session", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-app-wait-project-");

    const { session } = manager.startAsync({
      prompt: "wait timeout probe DELAY_MS=200",
      projectDir,
      codexBin: fakeCodex,
    });

    const waited = await manager.wait(session.id, 20);
    expect(waited.completed).toBe(false);
    expect(waited.timeoutReason).toBe("wait_timeout");
    expect(waited.session?.active).toBe(true);
    expect(manager.stats().waiters).toBe(0);
    manager.cancel(session.id);
  });

  it("cleans timed-out waiters for sessions and async jobs", async () => {
    const manager = new CodexSessionManager();
    const jobs = new CodexJobManager();
    const projectDir = await tempDir("codex-subagents-waiter-cleanup-project-");

    const { session } = manager.startAsync({
      prompt: "session waiter cleanup DELAY_MS=160",
      projectDir,
      codexBin: fakeCodex,
    });
    const job = jobs.startAgent({
      prompt: "job waiter cleanup DELAY_MS=160",
      projectDir,
      codexBin: fakeCodex,
    });

    await Promise.all([
      manager.wait(session.id, 5),
      manager.wait(session.id, 5),
      jobs.wait(job.id, 5),
      jobs.wait(job.id, 5),
    ]);

    expect(manager.stats().waiters).toBe(0);
    expect(jobs.stats().waiters).toBe(0);

    const [sessionDone, jobDone] = await Promise.all([
      manager.wait(session.id, 2_000),
      jobs.wait(job.id, 2_000),
    ]);
    expect(sessionDone.completed).toBe(true);
    expect(jobDone?.status).toBe("completed");
    await manager.shutdown("test_cleanup");
  });

  it("bounds retained idle sessions by max session count", async () => {
    const previousMax = process.env.CODEX_SUBAGENTS_MAX_SESSIONS;
    process.env.CODEX_SUBAGENTS_MAX_SESSIONS = "2";
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-retention-project-");
    try {
      const first = await manager.start({ prompt: "retention first", projectDir, codexBin: fakeCodex });
      const second = await manager.start({ prompt: "retention second", projectDir, codexBin: fakeCodex });
      const third = await manager.start({ prompt: "retention third", projectDir, codexBin: fakeCodex });

      const sessions = manager.list();
      expect(sessions).toHaveLength(2);
      expect(manager.get(first.session.id)).toBeUndefined();
      expect(manager.get(second.session.id)).toBeDefined();
      expect(manager.get(third.session.id)).toBeDefined();
    } finally {
      if (previousMax === undefined) delete process.env.CODEX_SUBAGENTS_MAX_SESSIONS;
      else process.env.CODEX_SUBAGENTS_MAX_SESSIONS = previousMax;
      await manager.shutdown("test_cleanup");
    }
  });
});
