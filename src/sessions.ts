import { runQueuedAgent } from "./jobs.js";
import { errorForLog, logger, summarizeRawTrafficForLog } from "./logging.js";
import type { AgentRunOptions, AgentRunPartial, AgentRunResult } from "./runner.js";

type SessionStatus = "active" | "running" | "failed" | "cancelled";
type SessionTurnKind = "prompt" | "steer";
type SessionTurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  turns: number;
  active: boolean;
  activeTurn?: CodexSessionTurnSnapshot;
  queuedTurns: CodexSessionTurnSnapshot[];
  recentTurns: CodexSessionTurnSnapshot[];
  partial?: AgentRunPartial;
  lastResult?: AgentRunResult;
  error?: string;
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
  waiters: Set<() => void>;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
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

export class CodexSessionManager {
  private readonly sessions = new Map<string, CodexSessionRecord>();

  list(): CodexSessionSnapshot[] {
    return [...this.sessions.values()].map(snapshot);
  }

  get(id: string): CodexSessionSnapshot | undefined {
    const session = this.sessions.get(id);
    return session ? snapshot(session) : undefined;
  }

  async start(
    options: AgentRunOptions,
    metadata: { sessionName?: string } = {},
  ): Promise<{ session: CodexSessionSnapshot; result: AgentRunResult }> {
    const { session, turn } = this.createSession(options, metadata);
    this.ensureDrain(session);
    await this.waitForTurn(session, turn);
    if (!turn.result) {
      throw new Error(turn.error ?? `Codex session turn did not produce a result: ${turn.id}`);
    }
    return { session: snapshot(session), result: turn.result };
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
      turns: 0,
      baseOptions: {
        ...baseOptions,
        ephemeral: false,
      },
      queuedTurns: [],
      recentTurns: [],
      draining: false,
      cancelRequested: false,
      waiters: new Set(),
    };
    this.sessions.set(session.id, session);
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
        error: `Session has no Codex thread id yet; start_session must complete successfully before send_session_prompt.`,
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

    await this.waitForTurn(session, turn);
    return { session: snapshot(session), turn: turnSnapshot(turn), result: turn.result, error: turn.error };
  }

  async steer(
    id: string,
    prompt: string,
    overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot"> = {},
    options: { wait?: boolean; interruptCurrent?: boolean } = {},
  ): Promise<{
    session?: CodexSessionSnapshot;
    turn?: CodexSessionTurnSnapshot;
    result?: AgentRunResult;
    delivery?: "queued_after_current" | "interrupt_requested" | "started_or_queued";
    error?: string;
  }> {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.steer_unknown", { sessionId: id });
      return { error: `Unknown session_id: ${id}` };
    }
    const wasActive = Boolean(session.controller);
    const response = await this.send(id, prompt, overrides, {
      wait: options.wait,
      kind: "steer",
      priority: "front",
      interruptCurrent: options.interruptCurrent,
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
  ): Promise<{ session?: CodexSessionSnapshot; turn?: CodexSessionTurnSnapshot; completed?: boolean; error?: string }> {
    const session = this.sessions.get(id);
    if (!session) return { error: `Unknown session_id: ${id}` };

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
        const timeout = setTimeout(resolve, remaining);
        const waiter = () => {
          clearTimeout(timeout);
          resolve();
        };
        session.waiters.add(waiter);
      });
    }

    const turn = turnId ? this.findTurn(session, turnId) : undefined;
    return {
      session: snapshot(session),
      turn: turn ? turnSnapshot(turn) : undefined,
      completed: false,
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
      session.controller.abort();
    } else {
      session.status = "cancelled";
      session.updatedAt = new Date().toISOString();
    }
    this.notifySession(session);
    return snapshot(session);
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
      resumeSessionId: session.codexThreadId,
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
      const result = await runQueuedAgent(
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
      this.notifyTurn(turn);
      this.notifySession(session);
      return result;
    } catch (error) {
      session.status = controller.signal.aborted ? "cancelled" : "failed";
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
      this.notifyTurn(turn);
      this.notifySession(session);
      throw error;
    } finally {
      session.controller = undefined;
      session.activeTurn = undefined;
      this.notifySession(session);
    }
  }

  private findTurn(session: CodexSessionRecord, turnId: string): CodexSessionTurnRecord | undefined {
    if (session.activeTurn?.id === turnId) return session.activeTurn;
    return session.queuedTurns.find((turn) => turn.id === turnId) ??
      session.recentTurns.find((turn) => turn.id === turnId);
  }

  private async waitForTurn(session: CodexSessionRecord, turn: CodexSessionTurnRecord): Promise<void> {
    while (!terminal(turn.status)) {
      await new Promise<void>((resolve) => {
        turn.waiters.add(resolve);
        session.waiters.add(resolve);
      });
    }
  }

  private notifyTurn(turn: CodexSessionTurnRecord): void {
    for (const waiter of turn.waiters) waiter();
    turn.waiters.clear();
  }

  private notifySession(session: CodexSessionRecord): void {
    for (const waiter of session.waiters) waiter();
    session.waiters.clear();
  }
}

export const sessionManager = new CodexSessionManager();
