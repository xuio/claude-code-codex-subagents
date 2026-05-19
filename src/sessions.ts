import { runQueuedAgent } from "./jobs.js";
import { errorForLog, logger, summarizeRawTrafficForLog } from "./logging.js";
import type { AgentRunOptions, AgentRunPartial, AgentRunResult } from "./runner.js";

type SessionStatus = "active" | "running" | "failed" | "cancelled";

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
  partial?: AgentRunPartial;
  lastResult?: AgentRunResult;
  error?: string;
}

interface CodexSessionRecord extends CodexSessionSnapshot {
  baseOptions: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">;
  controller?: AbortController;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
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
    partial: session.partial,
    lastResult: session.lastResult,
    error: session.error,
  };
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
      active: true,
      baseOptions: {
        ...baseOptions,
        ephemeral: false,
      },
    };
    this.sessions.set(session.id, session);
    logger.rawDebug("session.start", {
      session: summarizeRawTrafficForLog(snapshot(session)),
      prompt: options.prompt,
    });
    const result = await this.runTurn(session, { ...options, ephemeral: false });
    return { session: snapshot(session), result };
  }

  async send(
    id: string,
    prompt: string,
    overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot"> = {},
  ): Promise<{ session?: CodexSessionSnapshot; result?: AgentRunResult; error?: string }> {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.send_unknown", { sessionId: id });
      return { error: `Unknown session_id: ${id}` };
    }
    if (session.controller) {
      logger.warn("session.send_already_running", { sessionId: id });
      return { session: snapshot(session), error: `Session is already running: ${id}` };
    }
    if (!session.codexThreadId) {
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
    });
    const result = await this.runTurn(session, {
      ...session.baseOptions,
      ...withoutUndefined(overrides),
      prompt,
      resumeSessionId: session.codexThreadId,
      ephemeral: false,
    });
    return { session: snapshot(session), result };
  }

  cancel(id: string): CodexSessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.cancel_unknown", { sessionId: id });
      return undefined;
    }
    logger.warn("session.cancel", { sessionId: id, active: Boolean(session.controller) });
    if (session.controller) {
      session.status = "cancelled";
      session.updatedAt = new Date().toISOString();
      session.controller.abort();
    } else {
      session.status = "cancelled";
      session.updatedAt = new Date().toISOString();
    }
    return snapshot(session);
  }

  private async runTurn(session: CodexSessionRecord, options: AgentRunOptions): Promise<AgentRunResult> {
    const controller = new AbortController();
    session.controller = controller;
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    session.error = undefined;
    session.partial = undefined;
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
      session.status = result.ok ? "active" : result.status === "cancelled" ? "cancelled" : "failed";
      session.updatedAt = new Date().toISOString();
      logger.rawInfo("session.turn.finish", {
        session: summarizeRawTrafficForLog(snapshot(session)),
        result: summarizeRawTrafficForLog(result),
      });
      return result;
    } catch (error) {
      session.status = controller.signal.aborted ? "cancelled" : "failed";
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = new Date().toISOString();
      logger.error("session.turn.failed", {
        sessionId: session.id,
        error: errorForLog(error),
      });
      throw error;
    } finally {
      session.controller = undefined;
    }
  }
}

export const sessionManager = new CodexSessionManager();
