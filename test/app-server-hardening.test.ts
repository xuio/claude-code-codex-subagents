import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexJobManager } from "../src/jobs.js";
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
