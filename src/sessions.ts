import { AppServerUnavailableError, CodexAppServerSession, type AppServerStatus } from "./app-server.js";
import { BackpressureError, runQueuedAgent } from "./jobs.js";
import { errorForLog, logger, summarizeRawTrafficForLog } from "./logging.js";
import type { AgentRunOptions, AgentRunPartial, AgentRunResult } from "./runner.js";
import { recordDiagnosticEvent } from "./diagnostics.js";
import {
  durableRunOptions,
  type DurableSessionState,
  SessionStateStore,
} from "./session-state.js";

type SessionStatus = "active" | "running" | "failed" | "cancelled";
type SessionTurnKind = "prompt" | "steer";
type SessionTurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type SessionProtocol = "app-server" | "exec";
type SessionWaitTimeoutReason = "wait_timeout" | "wait_cancelled";

export interface CodexSessionTurnSnapshot {
  id: string;
  kind: SessionTurnKind;
  status: SessionTurnStatus;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  resultOk?: boolean;
  resultStatus?: AgentRunResult["status"];
  error?: string;
}

export interface CodexSessionSnapshot {
  id: string;
  name?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  projectDir?: string;
  cwd?: string;
  codexThreadId?: string;
  protocol: SessionProtocol;
  supportsRealSteering: boolean;
  appServer?: AppServerStatus;
  appServerFallbackReason?: string;
  durable?: {
    persisted: boolean;
    recovered: boolean;
    canResume: boolean;
    stateFile?: string;
  };
  turns: number;
  active: boolean;
  activeTurn?: CodexSessionTurnSnapshot;
  queuedTurns: CodexSessionTurnSnapshot[];
  recentTurns: CodexSessionTurnSnapshot[];
  partial?: AgentRunPartial;
  lastResult?: AgentRunResult;
  error?: string;
}

export interface CodexSessionStats {
  sessions: number;
  active: number;
  queuedTurns: number;
  waiters: number;
  maxSessions: number;
  maxQueuedTurns: number;
  completedTtlSeconds: number;
  idleTtlSeconds: number;
  durableStateFile?: string;
}

interface CodexSessionTurnRecord extends CodexSessionTurnSnapshot {
  overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">;
  waiters: Set<() => void>;
  result?: AgentRunResult;
}

interface CodexSessionRecord {
  id: string;
  name?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  projectDir?: string;
  cwd?: string;
  codexThreadId?: string;
  protocol: SessionProtocol;
  appServer?: CodexAppServerSession;
  appServerStarting?: Promise<CodexAppServerSession>;
  appServerFallbackReason?: string;
  turns: number;
  partial?: AgentRunPartial;
  lastResult?: AgentRunResult;
  error?: string;
  baseOptions: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">;
  controller?: AbortController;
  activeTurn?: CodexSessionTurnRecord;
  queuedTurns: CodexSessionTurnRecord[];
  recentTurns: CodexSessionTurnRecord[];
  draining: boolean;
  cancelRequested: boolean;
  runtimeShutdownRecoverable: boolean;
  waiters: Set<() => void>;
  persisted: boolean;
  recovered: boolean;
  stateFile?: string;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
}

function sessionBaseOptions(
  options: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">,
): Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot"> {
  return {
    ...options,
    sandbox: options.dangerouslyBypassApprovalsAndSandbox ? "read-only" : options.sandbox,
    dangerouslyBypassApprovalsAndSandbox: false,
  };
}

function turnSnapshot(turn: CodexSessionTurnRecord): CodexSessionTurnSnapshot {
  return {
    id: turn.id,
    kind: turn.kind,
    status: turn.status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    prompt: turn.prompt,
    resultOk: turn.resultOk,
    resultStatus: turn.resultStatus,
    error: turn.error,
  };
}

function snapshot(session: CodexSessionRecord): CodexSessionSnapshot {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    projectDir: session.projectDir,
    cwd: session.cwd,
    codexThreadId: session.codexThreadId,
    protocol: session.protocol,
    supportsRealSteering:
      session.protocol === "app-server" &&
      Boolean(session.appServer && !session.appServer.status().closed && session.appServer.status().supports.turnSteer),
    appServer: session.appServer?.status(),
    appServerFallbackReason: session.appServerFallbackReason,
    durable: session.persisted
      ? {
          persisted: true,
          recovered: session.recovered,
          canResume: Boolean(session.codexThreadId),
          stateFile: session.stateFile,
        }
      : undefined,
    turns: session.turns,
    active: Boolean(session.controller),
    activeTurn: session.activeTurn ? turnSnapshot(session.activeTurn) : undefined,
    queuedTurns: session.queuedTurns.map(turnSnapshot),
    recentTurns: session.recentTurns.slice(-20).map(turnSnapshot),
    partial: session.partial,
    lastResult: session.lastResult,
    error: session.error,
  };
}

function terminal(status: SessionTurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function defaultSessionProtocol(env: NodeJS.ProcessEnv = process.env): SessionProtocol {
  return env.CODEX_SUBAGENTS_SESSION_PROTOCOL === "exec" ? "exec" : "app-server";
}

function shouldFallbackToExec(error: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK === "1") return false;
  return error instanceof AppServerUnavailableError || error instanceof Error;
}

function readPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export class CodexSessionManager {
  private readonly sessions = new Map<string, CodexSessionRecord>();
  private readonly stateStore: SessionStateStore | undefined;
  private readonly persistedSessionIds = new Set<string>();
  private readonly completedTtlSeconds = readPositiveInt(
    process.env.CODEX_SUBAGENTS_SESSION_COMPLETED_TTL_SECONDS,
    3600,
    86_400,
  );
  private readonly idleTtlSeconds = readPositiveInt(
    process.env.CODEX_SUBAGENTS_SESSION_IDLE_TTL_SECONDS,
    86_400,
    604_800,
  );
  private readonly maxSessions = readPositiveInt(process.env.CODEX_SUBAGENTS_MAX_SESSIONS, 100, 1_000);
  private readonly maxQueuedTurns = readPositiveInt(process.env.CODEX_SUBAGENTS_MAX_SESSION_QUEUED_TURNS, 32, 1_000);

  constructor(options: { persist?: boolean; stateFile?: string } = {}) {
    if (options.persist) {
      this.stateStore = new SessionStateStore(options.stateFile);
      this.loadPersistedSessions();
    }
  }

  list(): CodexSessionSnapshot[] {
    this.prune();
    return [...this.sessions.values()].map(snapshot);
  }

  get(id: string): CodexSessionSnapshot | undefined {
    this.prune();
    const session = this.sessions.get(id);
    return session ? snapshot(session) : undefined;
  }

  stats(): CodexSessionStats {
    this.prune();
    return {
      sessions: this.sessions.size,
      active: [...this.sessions.values()].filter((session) => Boolean(session.controller)).length,
      queuedTurns: [...this.sessions.values()].reduce(
        (count, session) => count + session.queuedTurns.length,
        0,
      ),
      waiters: [...this.sessions.values()].reduce(
        (count, session) =>
          count +
          session.waiters.size +
          session.queuedTurns.reduce((turnCount, turn) => turnCount + turn.waiters.size, 0) +
          (session.activeTurn?.waiters.size ?? 0),
        0,
      ),
      maxSessions: this.maxSessions,
      maxQueuedTurns: this.maxQueuedTurns,
      completedTtlSeconds: this.completedTtlSeconds,
      idleTtlSeconds: this.idleTtlSeconds,
      durableStateFile: this.stateStore?.file,
    };
  }

  async start(
    options: AgentRunOptions,
    metadata: { sessionName?: string } = {},
  ): Promise<{ session: CodexSessionSnapshot; result: AgentRunResult }> {
    const { session, turn } = this.createSession(options, metadata);
    const abortHandler = () => {
      logger.warn("session.start_request_cancelled", { sessionId: session.id, turnId: turn.id });
      this.cancel(session.id);
    };
    options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    try {
      if (options.abortSignal?.aborted) this.cancel(session.id);
      this.ensureDrain(session);
      await this.waitForTurn(session, turn);
      if (!turn.result) {
        throw new Error(turn.error ?? `Codex session turn did not produce a result: ${turn.id}`);
      }
      return { session: snapshot(session), result: turn.result };
    } finally {
      options.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }

  startAsync(
    options: AgentRunOptions,
    metadata: { sessionName?: string } = {},
  ): { session: CodexSessionSnapshot; turn: CodexSessionTurnSnapshot } {
    const { session, turn } = this.createSession(options, metadata);
    this.ensureDrain(session);
    return { session: snapshot(session), turn: turnSnapshot(turn) };
  }

  private createSession(
    options: AgentRunOptions,
    metadata: { sessionName?: string } = {},
  ): { session: CodexSessionRecord; turn: CodexSessionTurnRecord } {
    this.prune();
    if (this.sessions.size >= this.maxSessions && ![...this.sessions.values()].some((session) => this.isPrunable(session))) {
      throw new BackpressureError(
        `Codex session table is full (${this.sessions.size}/${this.maxSessions}). Cancel old sessions or lower session retention before starting another session.`,
      );
    }
    const now = new Date().toISOString();
    const { prompt: _prompt, abortSignal: _abortSignal, onSnapshot: _onSnapshot, ...baseOptions } = options;
    const session: CodexSessionRecord = {
      id: `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name: metadata.sessionName ?? options.name,
      status: "running",
      createdAt: now,
      updatedAt: now,
      projectDir: options.projectDir,
      cwd: options.cwd,
      protocol: defaultSessionProtocol(),
      turns: 0,
      baseOptions: {
        ...sessionBaseOptions(baseOptions),
        ephemeral: false,
      },
      queuedTurns: [],
      recentTurns: [],
      draining: false,
      cancelRequested: false,
      runtimeShutdownRecoverable: false,
      waiters: new Set(),
      persisted: Boolean(this.stateStore),
      recovered: false,
      stateFile: this.stateStore?.file,
    };
    this.sessions.set(session.id, session);
    if (this.stateStore) this.persistedSessionIds.add(session.id);
    const turn = this.enqueueTurn(session, {
      prompt: options.prompt,
      overrides: {
        ...baseOptions,
        ephemeral: false,
      },
      kind: "prompt",
    });
    logger.rawDebug("session.start", {
      session: summarizeRawTrafficForLog(snapshot(session)),
      prompt: options.prompt,
    });
    this.persist();
    return { session, turn };
  }

  async send(
    id: string,
    prompt: string,
    overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot"> = {},
    options: {
      wait?: boolean;
      kind?: SessionTurnKind;
      priority?: "normal" | "front";
      interruptCurrent?: boolean;
      waitSignal?: AbortSignal;
    } = {},
  ): Promise<{ session?: CodexSessionSnapshot; turn?: CodexSessionTurnSnapshot; result?: AgentRunResult; error?: string }> {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.send_unknown", { sessionId: id });
      return { error: `Unknown session_id: ${id}` };
    }
    if (session.cancelRequested || session.status === "cancelled") {
      logger.warn("session.send_cancelled", { sessionId: id });
      return { session: snapshot(session), error: `Session is cancelled: ${id}` };
    }
    if (!session.controller && session.turns > 0 && !session.codexThreadId) {
      logger.warn("session.send_missing_thread", { sessionId: id });
      return {
        session: snapshot(session),
        error: `Session has no Codex thread id yet; codex_session_start must complete successfully before codex_session_prompt.`,
      };
    }

    logger.rawDebug("session.send", {
      sessionId: id,
      prompt,
      overrides: summarizeRawTrafficForLog(overrides),
      options,
    });
    const turn = this.enqueueTurn(session, {
      prompt,
      overrides: {
        ...withoutUndefined(overrides),
        ephemeral: false,
      },
      kind: options.kind ?? "prompt",
      priority: options.priority,
    });

    if (options.interruptCurrent && session.controller) {
      logger.warn("session.interrupt_current", { sessionId: id, turnId: turn.id });
      session.controller.abort();
    }

    const wait = options.wait ?? true;
    this.ensureDrain(session);
    if (!wait) return { session: snapshot(session), turn: turnSnapshot(turn) };

    const completed = await this.waitForTurn(session, turn, options.waitSignal);
    if (!completed) {
      return {
        session: snapshot(session),
        turn: turnSnapshot(turn),
        error: "Wait request was cancelled; the Codex session is still managed by this MCP server.",
      };
    }
    return { session: snapshot(session), turn: turnSnapshot(turn), result: turn.result, error: turn.error };
  }

  async steer(
    id: string,
    prompt: string,
    overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot"> = {},
    options: { wait?: boolean; interruptCurrent?: boolean; waitSignal?: AbortSignal } = {},
  ): Promise<{
    session?: CodexSessionSnapshot;
    turn?: CodexSessionTurnSnapshot;
    result?: AgentRunResult;
    delivery?: "delivered_to_active_turn" | "queued_after_current" | "interrupt_requested" | "started_or_queued";
    error?: string;
  }> {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.steer_unknown", { sessionId: id });
      return { error: `Unknown session_id: ${id}` };
    }
    const wasActive = Boolean(session.controller);
    if (session.protocol === "app-server" && session.appServer && session.activeTurn && !options.interruptCurrent) {
      const activeCodexTurnId = await this.waitForAppServerActiveTurn(session, 5_000);
      if (!activeCodexTurnId) {
        logger.warn("session.steer_app_server_not_ready", {
          sessionId: id,
          activeTurnId: session.activeTurn.id,
        });
      } else {
        try {
          const delivered = await session.appServer.steer(prompt);
          if (!delivered.delivered) {
            logger.warn("session.steer_app_server_rejected", {
              sessionId: id,
              activeTurnId: session.activeTurn.id,
              activeCodexTurnId,
            });
          } else {
            const turn = this.recordSteerDelivery(session, prompt);
            turn.status = "completed";
            turn.resultOk = true;
            turn.resultStatus = "completed";
            turn.updatedAt = new Date().toISOString();
            this.notifyTurn(turn);
            this.notifySession(session);
            const activeTurn = session.activeTurn;
            if (options.wait && activeTurn) {
              const completed = await this.waitForTurn(session, activeTurn, options.waitSignal);
              if (!completed) {
                return {
                  session: snapshot(session),
                  turn: turnSnapshot(turn),
                  delivery: "delivered_to_active_turn",
                  error: "Wait request was cancelled; the Codex session is still managed by this MCP server.",
                };
              }
            }
            return {
              session: snapshot(session),
              turn: turnSnapshot(turn),
              result: activeTurn?.result,
              delivery: "delivered_to_active_turn",
            };
          }
        } catch (error) {
          logger.error("session.steer_app_server_failed", {
            sessionId: id,
            error: errorForLog(error),
          });
        }
      }
    }
    const response = await this.send(id, prompt, overrides, {
      wait: options.wait,
      kind: "steer",
      priority: "front",
      interruptCurrent: options.interruptCurrent,
      waitSignal: options.waitSignal,
    });
    return {
      ...response,
      delivery: options.interruptCurrent && wasActive
        ? "interrupt_requested"
        : wasActive
          ? "queued_after_current"
          : "started_or_queued",
    };
  }

  async wait(
    id: string,
    timeoutMs: number,
    turnId?: string,
    abortSignal?: AbortSignal,
  ): Promise<{
    session?: CodexSessionSnapshot;
    turn?: CodexSessionTurnSnapshot;
    completed?: boolean;
    timeoutReason?: SessionWaitTimeoutReason;
    error?: string;
  }> {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) return { error: `Unknown session_id: ${id}` };
    if (turnId && !this.findTurn(session, turnId)) {
      return { session: snapshot(session), completed: false, error: `Unknown turn_id: ${turnId}` };
    }
    if (abortSignal?.aborted) {
      const turn = turnId ? this.findTurn(session, turnId) : undefined;
      return {
        session: snapshot(session),
        turn: turn ? turnSnapshot(turn) : undefined,
        completed: false,
        timeoutReason: "wait_cancelled",
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const turn = turnId ? this.findTurn(session, turnId) : undefined;
      const completed = turn ? terminal(turn.status) : !session.controller && session.queuedTurns.length === 0;
      if (completed) {
        return {
          session: snapshot(session),
          turn: turn ? turnSnapshot(turn) : undefined,
          completed: true,
        };
      }

      await new Promise<void>((resolve) => {
        const remaining = Math.max(1, deadline - Date.now());
        let finished = false;
        let waiter: (() => void) | undefined;
        let abortHandler: (() => void) | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (waiter) session.waiters.delete(waiter);
          if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
          resolve();
        };
        const timeout = setTimeout(finish, remaining);
        waiter = finish;
        abortHandler = finish;
        session.waiters.add(waiter);
        abortSignal?.addEventListener("abort", abortHandler, { once: true });
        if (abortSignal?.aborted) finish();
      });
      if (abortSignal?.aborted) {
        const turn = turnId ? this.findTurn(session, turnId) : undefined;
        return {
          session: snapshot(session),
          turn: turn ? turnSnapshot(turn) : undefined,
          completed: false,
          timeoutReason: "wait_cancelled",
        };
      }
    }

    const turn = turnId ? this.findTurn(session, turnId) : undefined;
    return {
      session: snapshot(session),
      turn: turn ? turnSnapshot(turn) : undefined,
      completed: false,
      timeoutReason: "wait_timeout",
    };
  }

  cancel(id: string): CodexSessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.cancel_unknown", { sessionId: id });
      return undefined;
    }
    logger.warn("session.cancel", { sessionId: id, active: Boolean(session.controller) });
    session.cancelRequested = true;
    for (const turn of session.queuedTurns) {
      turn.status = "cancelled";
      turn.updatedAt = new Date().toISOString();
      turn.error = "Session was cancelled before this turn started.";
      this.notifyTurn(turn);
    }
    session.queuedTurns = [];
    if (session.controller) {
      session.status = "cancelled";
      session.updatedAt = new Date().toISOString();
      void session.appServer?.close("cancelled");
      session.controller.abort();
    } else {
      session.status = "cancelled";
      session.updatedAt = new Date().toISOString();
      void session.appServer?.close("cancelled");
    }
    this.notifySession(session);
    this.persist();
    return snapshot(session);
  }

  async recover(id: string): Promise<{ session?: CodexSessionSnapshot; recovered?: boolean; error?: string }> {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) return { error: `Unknown session_id: ${id}` };
    if (!session.codexThreadId) {
      return {
        session: snapshot(session),
        recovered: false,
        error: `Session ${id} does not have a persisted Codex thread id to recover.`,
      };
    }
    if (session.protocol === "exec") {
      session.recovered = true;
      this.persist();
      return { session: snapshot(session), recovered: true };
    }
    try {
      if (!session.appServer || session.appServer.status().closed) {
        await this.ensureAppServer(session, {
          ...session.baseOptions,
          prompt: "",
          projectDir: session.projectDir ?? session.baseOptions.projectDir,
          cwd: session.cwd ?? session.baseOptions.cwd,
          ephemeral: false,
        });
      } else {
        try {
          await session.appServer.readThread(false);
        } catch (error) {
          logger.warn("session.recover_thread_read_unavailable", {
            sessionId: session.id,
            error: errorForLog(error),
          });
          recordDiagnosticEvent({
            severity: "warn",
            source: "session.recover",
            message: error instanceof Error ? error.message : String(error),
            sessionId: session.id,
            detail: { protocol: session.protocol, codexThreadId: session.codexThreadId },
          });
        }
      }
      session.status = session.status === "failed" ? "active" : session.status;
      session.recovered = true;
      session.updatedAt = new Date().toISOString();
      this.persist();
      return { session: snapshot(session), recovered: true };
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = new Date().toISOString();
      recordDiagnosticEvent({
        severity: "error",
        source: "session.recover",
        message: session.error,
        sessionId: session.id,
        detail: { protocol: session.protocol, codexThreadId: session.codexThreadId },
      });
      this.persist();
      return { session: snapshot(session), recovered: false, error: session.error };
    }
  }

  async shutdown(reason = "shutdown"): Promise<CodexSessionSnapshot[]> {
    logger.warn("session.shutdown", { reason, sessions: this.sessions.size });
    const closePromises: Array<Promise<void>> = [];
    const snapshots: CodexSessionSnapshot[] = [];
    const now = new Date().toISOString();

    for (const session of this.sessions.values()) {
      const recoverable = Boolean(session.codexThreadId) && !session.cancelRequested && session.status !== "cancelled";
      session.runtimeShutdownRecoverable = recoverable;
      session.cancelRequested = !recoverable;
      for (const turn of session.queuedTurns) {
        turn.status = "cancelled";
        turn.updatedAt = now;
        turn.error = `Session was cancelled during ${reason}.`;
        this.notifyTurn(turn);
      }
      session.queuedTurns = [];
      if (session.activeTurn && !terminal(session.activeTurn.status)) {
        session.activeTurn.status = "cancelled";
        session.activeTurn.updatedAt = now;
        session.activeTurn.error = `Session was cancelled during ${reason}.`;
        this.notifyTurn(session.activeTurn);
      }
      session.status = recoverable ? "active" : "cancelled";
      session.updatedAt = now;
      if (session.controller) session.controller.abort();
      if (session.appServer) closePromises.push(session.appServer.close("cancelled").catch(() => {}));
      this.notifySession(session);
      snapshots.push(snapshot(session));
    }

    await Promise.allSettled(closePromises);
    for (const session of this.sessions.values()) {
      if (!session.runtimeShutdownRecoverable || !session.codexThreadId) continue;
      session.cancelRequested = false;
      session.status = "active";
      session.updatedAt = new Date().toISOString();
    }
    this.persist();
    return snapshots;
  }

  private enqueueTurn(
    session: CodexSessionRecord,
    input: {
      prompt: string;
      overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">;
      kind: SessionTurnKind;
      priority?: "normal" | "front";
    },
  ): CodexSessionTurnRecord {
    if (session.queuedTurns.length >= this.maxQueuedTurns) {
      throw new BackpressureError(
        `Codex session ${session.id} has too many queued turns (${session.queuedTurns.length}/${this.maxQueuedTurns}). Wait for existing turns or start a separate session.`,
      );
    }
    const now = new Date().toISOString();
    const turn: CodexSessionTurnRecord = {
      id: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      kind: input.kind,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      prompt: input.prompt,
      overrides: input.overrides,
      waiters: new Set(),
    };
    if (input.priority === "front") session.queuedTurns.unshift(turn);
    else session.queuedTurns.push(turn);
    session.recentTurns.push(turn);
    session.updatedAt = now;
    logger.rawDebug("session.turn.queued", {
      sessionId: session.id,
      turn: summarizeRawTrafficForLog(turnSnapshot(turn)),
      queuedTurns: session.queuedTurns.length,
    });
    this.notifySession(session);
    this.persist();
    return turn;
  }

  private recordSteerDelivery(session: CodexSessionRecord, prompt: string): CodexSessionTurnRecord {
    const turn = this.enqueueTurn(session, {
      prompt,
      overrides: {},
      kind: "steer",
      priority: "front",
    });
    const index = session.queuedTurns.indexOf(turn);
    if (index >= 0) session.queuedTurns.splice(index, 1);
    turn.status = "running";
    turn.updatedAt = new Date().toISOString();
    this.notifySession(session);
    return turn;
  }

  private ensureDrain(session: CodexSessionRecord): void {
    if (session.draining) return;
    session.draining = true;
    void this.drain(session);
  }

  private async drain(session: CodexSessionRecord): Promise<void> {
    try {
      while (!session.cancelRequested && session.queuedTurns.length > 0) {
        const turn = session.queuedTurns.shift();
        if (!turn) continue;
        try {
          await this.runTurn(session, turn);
        } catch (error) {
          logger.error("session.drain_turn_failed", {
            sessionId: session.id,
            turnId: turn.id,
            error: errorForLog(error),
          });
        }
      }
    } finally {
      session.draining = false;
      this.notifySession(session);
      if (!session.cancelRequested && !session.controller && session.queuedTurns.length > 0) {
        this.ensureDrain(session);
      }
    }
  }

  private async runTurn(session: CodexSessionRecord, turn: CodexSessionTurnRecord): Promise<AgentRunResult | undefined> {
    if (!session.codexThreadId && session.turns > 0) {
      turn.status = "failed";
      turn.error = "Session has no Codex thread id, so this queued turn cannot resume context.";
      turn.updatedAt = new Date().toISOString();
      session.status = "failed";
      session.error = turn.error;
      session.updatedAt = turn.updatedAt;
      this.notifyTurn(turn);
      this.notifySession(session);
      return undefined;
    }

    const options: AgentRunOptions = {
      ...session.baseOptions,
      ...withoutUndefined(turn.overrides),
      prompt: turn.prompt,
      resumeSessionId: session.protocol === "exec" ? session.codexThreadId : undefined,
      ephemeral: false,
    };
    const controller = new AbortController();
    session.controller = controller;
    session.activeTurn = turn;
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    session.error = undefined;
    session.partial = undefined;
    turn.status = "running";
    turn.updatedAt = session.updatedAt;
    logger.rawDebug("session.turn.start", {
      session: summarizeRawTrafficForLog(snapshot(session)),
      prompt: options.prompt,
      resumeSessionId: options.resumeSessionId,
      resumeLast: options.resumeLast,
    });

    try {
      const result = session.protocol === "app-server"
        ? await this.runAppServerTurn(session, options, controller)
        : await this.runExecTurn(session, options, controller);
      this.completeTurn(session, turn, result);
      return result;
    } catch (error) {
      session.status =
        controller.signal.aborted && session.runtimeShutdownRecoverable && session.codexThreadId
          ? "active"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = new Date().toISOString();
      turn.status = controller.signal.aborted ? "cancelled" : "failed";
      turn.error = session.error;
      turn.updatedAt = session.updatedAt;
      logger.error("session.turn.failed", {
        sessionId: session.id,
        turnId: turn.id,
        error: errorForLog(error),
      });
      recordDiagnosticEvent({
        severity: session.status === "cancelled" ? "warn" : "error",
        source: "session",
        message: session.error,
        sessionId: session.id,
        codexBinary: session.lastResult?.codexBinary.path,
        detail: { turnId: turn.id, protocol: session.protocol },
      });
      this.notifyTurn(turn);
      this.notifySession(session);
      this.persist();
      throw error;
    } finally {
      session.controller = undefined;
      session.activeTurn = undefined;
      this.notifySession(session);
    }
  }

  private async runExecTurn(
    session: CodexSessionRecord,
    options: AgentRunOptions,
    controller: AbortController,
  ): Promise<AgentRunResult> {
    return runQueuedAgent(
        {
          ...options,
          abortSignal: controller.signal,
        },
        {
          onSnapshot: (partial) => {
            session.partial = partial;
            session.updatedAt = new Date().toISOString();
            logger.rawDebug("session.turn.partial", {
              sessionId: session.id,
              partial: summarizeRawTrafficForLog(partial),
            });
          },
        },
      );
  }

  private async runAppServerTurn(
    session: CodexSessionRecord,
    options: AgentRunOptions,
    controller: AbortController,
  ): Promise<AgentRunResult> {
    let appServerWasReady = false;
    try {
      const appServer = await this.ensureAppServer(session, options);
      appServerWasReady = true;
      return await appServer.startTurn(
        options,
        controller.signal,
        (partial) => {
          session.partial = partial;
          session.updatedAt = new Date().toISOString();
          logger.rawDebug("session.turn.partial", {
            sessionId: session.id,
            partial: summarizeRawTrafficForLog(partial),
          });
        },
        { sessionTurnId: session.activeTurn?.id },
      );
    } catch (error) {
      if (session.appServer?.status().closed) session.appServer = undefined;
      if (session.turns === 0 && !appServerWasReady && !session.appServer && shouldFallbackToExec(error)) {
        session.appServerFallbackReason = error instanceof Error ? error.message : String(error);
        logger.warn("session.app_server_fallback_to_exec", {
          sessionId: session.id,
          appServerFallbackReason: session.appServerFallbackReason,
          error: errorForLog(error),
        });
        session.appServer = undefined;
        session.protocol = "exec";
        return this.runExecTurn(session, {
          ...options,
          resumeSessionId: undefined,
        }, controller);
      }
      throw error;
    }
  }

  private async ensureAppServer(
    session: CodexSessionRecord,
    options: AgentRunOptions,
  ): Promise<CodexAppServerSession> {
    if (session.appServer?.status().closed) {
      logger.warn("session.app_server_discard_closed", {
        sessionId: session.id,
        appServer: session.appServer.status(),
      });
      session.appServer = undefined;
    }
    if (session.appServer) return session.appServer;

    if (!session.appServerStarting) {
      session.appServerStarting = CodexAppServerSession.create(
        options,
        { sessionId: session.id },
        session.codexThreadId ? session.codexThreadId : undefined,
      )
        .then((appServer) => {
          session.appServer = appServer;
          session.codexThreadId = appServer.threadId;
          session.appServerFallbackReason = undefined;
          session.updatedAt = new Date().toISOString();
          this.persist();
          return appServer;
        })
        .finally(() => {
          session.appServerStarting = undefined;
        });
    }
    return session.appServerStarting;
  }

  private completeTurn(
    session: CodexSessionRecord,
    turn: CodexSessionTurnRecord,
    result: AgentRunResult,
  ): void {
    session.turns += 1;
    session.lastResult = result;
    session.codexThreadId = result.eventSummary.threadId ?? session.codexThreadId;
    session.projectDir = result.cwd;
    session.cwd = result.cwd;
    session.baseOptions = {
      ...session.baseOptions,
      projectDir: result.cwd,
      cwd: undefined,
    };
    turn.result = result;
    turn.resultOk = result.ok;
    turn.resultStatus = result.status;
    turn.status = result.ok ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
    turn.updatedAt = new Date().toISOString();
    session.status = result.ok
      ? "active"
      : result.status === "cancelled" && session.runtimeShutdownRecoverable && session.codexThreadId
        ? "active"
      : result.status === "cancelled" && session.queuedTurns.length > 0 && !session.cancelRequested
        ? "running"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed";
    session.updatedAt = new Date().toISOString();
    logger.rawInfo("session.turn.finish", {
      session: summarizeRawTrafficForLog(snapshot(session)),
      turn: summarizeRawTrafficForLog(turnSnapshot(turn)),
      result: summarizeRawTrafficForLog(result),
    });
    if (session.cancelRequested && session.appServer) void session.appServer.close("cancelled");
    this.notifyTurn(turn);
    this.notifySession(session);
    this.persist();
  }

  private findTurn(session: CodexSessionRecord, turnId: string): CodexSessionTurnRecord | undefined {
    if (session.activeTurn?.id === turnId) return session.activeTurn;
    return session.queuedTurns.find((turn) => turn.id === turnId) ??
      session.recentTurns.find((turn) => turn.id === turnId);
  }

  private async waitForTurn(
    session: CodexSessionRecord,
    turn: CodexSessionTurnRecord,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    while (!terminal(turn.status)) {
      if (abortSignal?.aborted) return false;
      await new Promise<void>((resolve) => {
        let finished = false;
        let waiter: (() => void) | undefined;
        let abortHandler: (() => void) | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (waiter) {
            turn.waiters.delete(waiter);
            session.waiters.delete(waiter);
          }
          if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
          resolve();
        };
        waiter = finish;
        abortHandler = finish;
        turn.waiters.add(waiter);
        session.waiters.add(waiter);
        abortSignal?.addEventListener("abort", abortHandler, { once: true });
        if (abortSignal?.aborted) finish();
      });
    }
    return true;
  }

  private async waitForAppServerActiveTurn(
    session: CodexSessionRecord,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (session.controller && session.activeTurn && session.appServer && Date.now() < deadline) {
      const activeTurnId = session.appServer.activeTurnId;
      if (activeTurnId) return activeTurnId;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return session.appServer?.activeTurnId;
  }

  private notifyTurn(turn: CodexSessionTurnRecord): void {
    for (const waiter of turn.waiters) waiter();
    turn.waiters.clear();
  }

  private notifySession(session: CodexSessionRecord): void {
    for (const waiter of session.waiters) waiter();
    session.waiters.clear();
  }

  private prune(): void {
    const now = Date.now();
    const completedTtlMs = this.completedTtlSeconds * 1000;
    const idleTtlMs = this.idleTtlSeconds * 1000;
    for (const [id, session] of this.sessions) {
      if (!this.isPrunable(session)) continue;
      const ageMs = now - Date.parse(session.updatedAt);
      const ttlMs = session.status === "active" ? idleTtlMs : completedTtlMs;
      if (ageMs > ttlMs) this.pruneSession(id, session, "ttl");
    }

    if (this.sessions.size <= this.maxSessions) return;
    const candidates = [...this.sessions.entries()]
      .filter(([, session]) => this.isPrunable(session))
      .sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    for (const [id, session] of candidates) {
      if (this.sessions.size <= this.maxSessions) break;
      this.pruneSession(id, session, "max_sessions");
    }
  }

  private isPrunable(session: CodexSessionRecord): boolean {
    return (
      !session.controller &&
      !session.draining &&
      session.queuedTurns.length === 0 &&
      (session.status === "active" || session.status === "failed" || session.status === "cancelled")
    );
  }

  private pruneSession(id: string, session: CodexSessionRecord, reason: "ttl" | "max_sessions"): void {
    logger.warn("session.pruned", { sessionId: id, reason, status: session.status });
    this.sessions.delete(id);
    void session.appServer?.close("cancelled").catch(() => {});
    this.notifySession(session);
    this.persist();
  }

  private loadPersistedSessions(): void {
    const store = this.stateStore;
    if (!store) return;
    for (const persisted of store.load()) {
      const record = this.recordFromState(persisted);
      if (!record) continue;
      this.sessions.set(record.id, record);
      this.persistedSessionIds.add(record.id);
    }
    logger.info("session.state.loaded", { stateFile: store.file, sessions: this.sessions.size });
  }

  private recordFromState(state: DurableSessionState): CodexSessionRecord | undefined {
    const hasThread = Boolean(state.codexThreadId);
    if (!hasThread && state.status === "active") return undefined;
    return {
      id: state.id,
      name: state.name,
      status: hasThread ? state.status : "failed",
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      projectDir: state.projectDir,
      cwd: state.cwd,
      codexThreadId: state.codexThreadId,
      protocol: state.protocol,
      appServerFallbackReason: undefined,
      appServerStarting: undefined,
      turns: state.turns,
      partial: undefined,
      error: state.error,
      baseOptions: sessionBaseOptions({
        ...(state.baseOptions as Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">),
        projectDir: state.projectDir ?? state.baseOptions.projectDir,
        cwd: state.cwd ?? state.baseOptions.cwd,
        ephemeral: false,
      }),
      queuedTurns: [],
      recentTurns: [],
      draining: false,
      cancelRequested: state.status === "cancelled",
      runtimeShutdownRecoverable: false,
      waiters: new Set(),
      persisted: true,
      recovered: true,
      stateFile: this.stateStore?.file,
    };
  }

  private persist(): void {
    const store = this.stateStore;
    if (!store) return;
    const states: DurableSessionState[] = [...this.sessions.values()]
      .filter((session) => session.codexThreadId)
      .map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status === "running" ? "active" : session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        projectDir: session.projectDir,
        cwd: session.cwd,
        codexThreadId: session.codexThreadId,
        protocol: session.protocol,
        turns: session.turns,
        baseOptions: durableRunOptions({
          ...session.baseOptions,
          prompt: "",
          projectDir: session.projectDir ?? session.baseOptions.projectDir,
          cwd: session.cwd ?? session.baseOptions.cwd,
        }),
        error: session.error,
      }));
    try {
      store.save(states, { replaceIds: this.persistedSessionIds });
    } catch (error) {
      logger.error("session.state.save_failed", { stateFile: store.file, error: errorForLog(error) });
    }
  }
}

export const sessionManager = new CodexSessionManager({ persist: true });
