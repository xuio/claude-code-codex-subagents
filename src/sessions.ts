import { AppServerUnavailableError, CodexAppServerSession, type AppServerStatus } from "./app-server.js";
import { agentRunQueue, BackpressureError, projectKeyForRunOptions, runQueuedAgent } from "./jobs.js";
import { errorForLog, logger, summarizeRawTrafficForLog } from "./logging.js";
import { RunValidationError, type AgentRunOptions, type AgentRunPartial, type AgentRunResult } from "./runner.js";
import { recordDiagnosticEvent } from "./diagnostics.js";
import { redactSensitiveText } from "./redaction.js";
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
const maxRecentTurnsRetained = 50;
export type SessionMilestoneKind =
  | "turn_started"
  | "turn_completed"
  | "command_started"
  | "command_completed"
  | "agent_message"
  | "error"
  | "cancelled"
  | "queued_turn_added";

export interface SessionMilestone {
  seq: number;
  at: string;
  kind: SessionMilestoneKind;
  turn_id?: string;
  command?: string;
  text?: string;
  error?: string;
}

export type PendingSessionMilestone = Omit<SessionMilestone, "seq" | "at">;

export interface MilestoneDetectionState {
  commandCount: number;
  commandStatuses: Array<string | undefined>;
  completedItemCount: number;
  errorCount: number;
  lastAgentMessage?: string;
}

type MilestoneSubscriber = (milestone: SessionMilestone) => void;
type SessionChangedHandler = (sessionId: string) => void | Promise<void>;

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
  lastMilestoneSeq: number;
  milestones: SessionMilestone[];
  active: boolean;
  activeTurn?: CodexSessionTurnSnapshot;
  queuedTurns: CodexSessionTurnSnapshot[];
  recentTurns: CodexSessionTurnSnapshot[];
  partial?: AgentRunPartial;
  lastResult?: AgentRunResult;
  lastResultTurnId?: string;
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
  maxMilestonesPerSession: number;
  resourceDebounceMs: number;
  resourceMaxDelayMs: number;
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
  lastResultTurnId?: string;
  error?: string;
  baseOptions: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">;
  controller?: AbortController;
  activeTurn?: CodexSessionTurnRecord;
  queuedTurns: CodexSessionTurnRecord[];
  recentTurns: CodexSessionTurnRecord[];
  draining: boolean;
  cancelRequested: boolean;
  runtimeShutdownRecoverable: boolean;
  sandboxCeiling: "read-only" | "workspace-write" | "danger-full-access";
  allowSensitiveEnv: boolean;
  waiters: Set<() => void>;
  milestones: SessionMilestone[];
  milestoneSeq: number;
  milestoneSubscribers: Set<MilestoneSubscriber>;
  milestonesPrevState?: MilestoneDetectionState;
  firstUnsentMilestoneAt?: number;
  resourceNotifyTimer?: NodeJS.Timeout;
  resourceNotifyMaxTimer?: NodeJS.Timeout;
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

function sandboxCapability(
  options: Pick<AgentRunOptions, "sandbox" | "dangerouslyBypassApprovalsAndSandbox">,
): CodexSessionRecord["sandboxCeiling"] {
  if (options.dangerouslyBypassApprovalsAndSandbox || options.sandbox === "danger-full-access") return "danger-full-access";
  if (options.sandbox === "workspace-write") return "workspace-write";
  return "read-only";
}

function sandboxRank(sandbox: CodexSessionRecord["sandboxCeiling"]): number {
  if (sandbox === "danger-full-access") return 2;
  if (sandbox === "workspace-write") return 1;
  return 0;
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
    lastMilestoneSeq: session.milestoneSeq,
    milestones: session.milestones.map((milestone) => ({ ...milestone })),
    active: Boolean(session.controller),
    activeTurn: session.activeTurn ? turnSnapshot(session.activeTurn) : undefined,
    queuedTurns: session.queuedTurns.map(turnSnapshot),
    recentTurns: session.recentTurns.slice(-20).map(turnSnapshot),
    partial: session.partial,
    lastResult: session.lastResult,
    lastResultTurnId: session.lastResultTurnId,
    error: session.error,
  };
}

function terminal(status: SessionTurnStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function hasLocalSessionWork(session: CodexSessionRecord): boolean {
  return Boolean(
    session.controller ||
      session.activeTurn ||
      session.draining ||
      session.appServerStarting ||
      session.appServer ||
      session.queuedTurns.length > 0,
  );
}

function idleWithoutWaitableResult(session: CodexSessionRecord): boolean {
  return session.status === "active" && !hasLocalSessionWork(session) && !session.lastResult;
}

function idleWaitError(session: CodexSessionRecord): string {
  const recovered = session.recovered ? " recovered" : "";
  return `Codex session ${session.id} is an idle${recovered} context with no running turn or result in this MCP process; send a follow-up prompt to continue it instead of waiting.`;
}

function defaultSessionProtocol(env: NodeJS.ProcessEnv = process.env): SessionProtocol {
  return env.CODEX_SUBAGENTS_SESSION_PROTOCOL === "exec" ? "exec" : "app-server";
}

function shouldFallbackToExec(error: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK === "1") return false;
  if (error instanceof RunValidationError) return false;
  return error instanceof AppServerUnavailableError || error instanceof Error;
}

function readPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function readBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function maxSessionMilestones(env: NodeJS.ProcessEnv = process.env): number {
  return readBoundedInt(env.CODEX_SUBAGENTS_MAX_SESSION_MILESTONES, 50, 10, 500);
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function firstUsefulLine(text: string | undefined, fallback = ""): string {
  const line = text
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? fallback;
}

function sanitizeMilestone(milestone: PendingSessionMilestone): PendingSessionMilestone {
  return {
    ...milestone,
    command: milestone.command ? truncateText(redactSensitiveText(milestone.command), 200) : undefined,
    text: milestone.text ? truncateText(redactSensitiveText(firstUsefulLine(milestone.text)), 500) : undefined,
    error: milestone.error ? truncateText(redactSensitiveText(firstUsefulLine(milestone.error)), 500) : undefined,
  };
}

export function defaultMilestoneDetectionState(): MilestoneDetectionState {
  return {
    commandCount: 0,
    commandStatuses: [],
    completedItemCount: 0,
    errorCount: 0,
  };
}

export function detectMilestones(
  partial: AgentRunPartial,
  prevState: MilestoneDetectionState = defaultMilestoneDetectionState(),
  turnId?: string,
): { milestones: PendingSessionMilestone[]; nextState: MilestoneDetectionState } {
  const milestones: PendingSessionMilestone[] = [];
  const commands = partial.eventSummary.commands ?? [];

  for (let index = prevState.commandCount; index < commands.length; index += 1) {
    const command = commands[index]?.command;
    if (!command) continue;
    milestones.push({
      kind: "command_started",
      command,
      turn_id: turnId,
    });
  }

  for (let index = 0; index < Math.min(prevState.commandStatuses.length, commands.length); index += 1) {
    const before = prevState.commandStatuses[index];
    const now = commands[index]?.status;
    if (before !== now && (now === "completed" || now === "failed")) {
      milestones.push({
        kind: "command_completed",
        command: commands[index]?.command,
        turn_id: turnId,
      });
    }
  }

  const completedItemCount = partial.eventSummary.counts?.["item/completed"] ?? 0;
  const lastAgentMessage = partial.lastAgentMessage ?? partial.eventSummary.lastAgentMessage;
  if (
    completedItemCount > prevState.completedItemCount &&
    lastAgentMessage &&
    lastAgentMessage !== prevState.lastAgentMessage
  ) {
    milestones.push({
      kind: "agent_message",
      text: lastAgentMessage,
      turn_id: turnId,
    });
  }

  const errors = partial.eventSummary.errors ?? [];
  for (let index = prevState.errorCount; index < errors.length; index += 1) {
    const error = errors[index];
    if (!error) continue;
    milestones.push({
      kind: "error",
      error,
      turn_id: turnId,
    });
  }

  return {
    milestones,
    nextState: {
      commandCount: commands.length,
      commandStatuses: commands.map((command) => command.status),
      completedItemCount,
      errorCount: errors.length,
      lastAgentMessage,
    },
  };
}

export class CodexSessionManager {
  private readonly sessions = new Map<string, CodexSessionRecord>();
  private readonly stateStore: SessionStateStore | undefined;
  private readonly persistedSessionIds = new Set<string>();
  private onSessionChanged?: SessionChangedHandler;
  private readonly resourceDebounceMs: number;
  private readonly resourceMaxDelayMs: number;
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
  private readonly maxMilestonesPerSession: number;

  constructor(options: {
    persist?: boolean;
    stateFile?: string;
    onSessionChanged?: SessionChangedHandler;
    resourceDebounceMs?: number;
    resourceMaxDelayMs?: number;
    maxMilestonesPerSession?: number;
  } = {}) {
    this.onSessionChanged = options.onSessionChanged;
    this.resourceDebounceMs = options.resourceDebounceMs ?? 250;
    this.resourceMaxDelayMs = options.resourceMaxDelayMs ?? 2_000;
    this.maxMilestonesPerSession = options.maxMilestonesPerSession ?? maxSessionMilestones();
    if (options.persist) {
      this.stateStore = new SessionStateStore(options.stateFile);
      this.loadPersistedSessions();
    }
  }

  setSessionChangedHandler(handler: SessionChangedHandler | undefined): void {
    this.onSessionChanged = handler;
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

  getMilestonesSince(id: string, sinceSeq: number): SessionMilestone[] {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) return [];
    return session.milestones
      .filter((milestone) => milestone.seq > sinceSeq)
      .map((milestone) => ({ ...milestone }));
  }

  subscribeMilestones(id: string, callback: MilestoneSubscriber): () => void {
    const session = this.sessions.get(id);
    if (!session) return () => {};
    session.milestoneSubscribers.add(callback);
    return () => {
      session.milestoneSubscribers.delete(callback);
    };
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
      maxMilestonesPerSession: this.maxMilestonesPerSession,
      resourceDebounceMs: this.resourceDebounceMs,
      resourceMaxDelayMs: this.resourceMaxDelayMs,
      durableStateFile: this.stateStore?.file,
    };
  }

  async start(
    options: AgentRunOptions,
    metadata: { sessionName?: string; onMilestone?: MilestoneSubscriber } = {},
  ): Promise<{ session: CodexSessionSnapshot; result: AgentRunResult }> {
    const { session, turn } = this.createSession(options, metadata);
    const unsubscribeMilestones = metadata.onMilestone
      ? this.subscribeMilestones(session.id, metadata.onMilestone)
      : undefined;
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
      unsubscribeMilestones?.();
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
      sandboxCeiling: sandboxCapability(baseOptions),
      allowSensitiveEnv: Boolean(baseOptions.forwardSensitiveEnv),
      waiters: new Set(),
      milestones: [],
      milestoneSeq: 0,
      milestoneSubscribers: new Set(),
      milestonesPrevState: defaultMilestoneDetectionState(),
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
        error: `Session has no Codex thread id yet; codex_task must complete successfully before codex_followup can continue it.`,
      };
    }

    logger.rawDebug("session.send", {
      sessionId: id,
      prompt,
      overrides: summarizeRawTrafficForLog(overrides),
      options,
    });
    const cleanOverrides = {
      ...withoutUndefined(overrides),
      ephemeral: false,
    };
    const escalationError = this.validateTurnOverrides(session, cleanOverrides);
    if (escalationError) {
      logger.warn("session.send_rejected_escalation", { sessionId: id, error: escalationError });
      return { session: snapshot(session), error: escalationError };
    }
    const turn = this.enqueueTurn(session, {
      prompt,
      overrides: cleanOverrides,
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
    if (session.protocol === "app-server" && session.activeTurn && !options.interruptCurrent) {
      const appServer = await this.waitForAppServerReady(session, 5_000);
      const activeCodexTurnId = await this.waitForAppServerActiveTurn(session, 5_000);
      if (!appServer || !activeCodexTurnId) {
        logger.warn("session.steer_app_server_not_ready", {
          sessionId: id,
          activeTurnId: session.activeTurn.id,
        });
      } else {
        try {
          const delivered = await appServer.steer(prompt);
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
            this.trimRecentTurns(session);
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
    result?: AgentRunResult;
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
    if (!turnId && idleWithoutWaitableResult(session)) {
      return { session: snapshot(session), completed: false, error: idleWaitError(session) };
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
        const result = turn ? turn.result : session.lastResult;
        return {
          session: snapshot(session),
          turn: turn ? turnSnapshot(turn) : undefined,
          result,
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
      result: turn ? turn.result : session.lastResult,
      completed: false,
      timeoutReason: "wait_timeout",
    };
  }

  async waitAny(
    ids: string[],
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<{
    session?: CodexSessionSnapshot;
    result?: AgentRunResult;
    completed: boolean;
    timeoutReason?: SessionWaitTimeoutReason;
    remainingSessionIds?: string[];
    error?: string;
  }> {
    this.prune();
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) {
      if (!this.sessions.has(id)) return { completed: false, error: `Unknown session_id: ${id}` };
    }
    const idleSession = uniqueIds
      .map((id) => this.sessions.get(id))
      .find((session): session is CodexSessionRecord => Boolean(session && idleWithoutWaitableResult(session)));
    if (idleSession) return { completed: false, error: idleWaitError(idleSession) };

    const winner = (): CodexSessionRecord | undefined => {
      this.prune();
      for (const id of uniqueIds) {
        const session = this.sessions.get(id);
        if (!session) return undefined;
        const done =
          !session.controller &&
          session.queuedTurns.length === 0 &&
          (Boolean(session.lastResult) || session.status === "failed" || session.status === "cancelled");
        if (done) return session;
      }
      return undefined;
    };

    if (abortSignal?.aborted) {
      return { completed: false, timeoutReason: "wait_cancelled" };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const completed = winner();
      if (completed) {
        return {
          session: snapshot(completed),
          result: completed.lastResult,
          completed: true,
          remainingSessionIds: uniqueIds.filter((id) => id !== completed.id),
        };
      }

      await new Promise<void>((resolve) => {
        const remaining = Math.max(1, deadline - Date.now());
        let finished = false;
        const unsubscribers: Array<() => void> = [];
        let abortHandler: (() => void) | undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          for (const unsubscribe of unsubscribers) unsubscribe();
          if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
          resolve();
        };
        const timeout = setTimeout(finish, remaining);
        abortHandler = finish;
        for (const id of uniqueIds) {
          const unsubscribe = this.subscribeMilestones(id, finish);
          unsubscribers.push(unsubscribe);
        }
        abortSignal?.addEventListener("abort", abortHandler, { once: true });
        if (abortSignal?.aborted || winner()) finish();
      });

      if (abortSignal?.aborted) {
        return { completed: false, timeoutReason: "wait_cancelled" };
      }
    }

    return {
      completed: false,
      timeoutReason: "wait_timeout",
      remainingSessionIds: uniqueIds,
    };
  }

  cancel(id: string, reason?: string): CodexSessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.cancel_unknown", { sessionId: id });
      return undefined;
    }
    logger.warn("session.cancel", { sessionId: id, active: Boolean(session.controller), reason });
    session.cancelRequested = true;
    for (const turn of session.queuedTurns) {
      turn.status = "cancelled";
      turn.updatedAt = new Date().toISOString();
      turn.error = reason
        ? `Session cancelled: ${reason}`
        : "Session was cancelled before this turn started.";
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
      this.closeAppServer(session, "cancelled", "cancel");
    }
    this.appendMilestones(session, [
      {
        kind: "cancelled",
        turn_id: session.activeTurn?.id,
        text: reason,
      },
    ], { immediate: true });
    this.notifySession(session);
    this.persist();
    return snapshot(session);
  }

  dispose(id: string, reason = "disposed"): CodexSessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      logger.warn("session.dispose_unknown", { sessionId: id, reason });
      return undefined;
    }
    if (session.controller || session.draining || session.queuedTurns.length > 0) {
      logger.warn("session.dispose_active_rejected", {
        sessionId: id,
        reason,
        active: Boolean(session.controller),
        queuedTurns: session.queuedTurns.length,
      });
      return snapshot(session);
    }
    const disposed = snapshot(session);
    logger.info("session.dispose", { sessionId: id, reason, status: session.status });
    this.sessions.delete(id);
    if (session.resourceNotifyTimer) clearTimeout(session.resourceNotifyTimer);
    if (session.resourceNotifyMaxTimer) clearTimeout(session.resourceNotifyMaxTimer);
    this.closeAppServer(session, "cancelled", reason);
    this.notifySession(session);
    this.emitSessionChanged(id);
    this.persist();
    return disposed;
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
      if (!hasLocalSessionWork(session)) {
        snapshots.push(snapshot(session));
        continue;
      }
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
      if (!recoverable) {
        this.appendMilestones(session, [
          {
            kind: "cancelled",
            turn_id: session.activeTurn?.id,
            text: `Session was cancelled during ${reason}.`,
          },
        ], { immediate: true });
      }
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
    this.appendMilestones(session, [
      {
        kind: "queued_turn_added",
        turn_id: turn.id,
        text: turn.kind === "steer" ? "Steering prompt queued." : "Prompt queued.",
      },
    ]);
    this.notifySession(session);
    this.persist();
    return turn;
  }

  private validateTurnOverrides(
    session: CodexSessionRecord,
    overrides: Omit<AgentRunOptions, "prompt" | "abortSignal" | "onSnapshot">,
  ): string | undefined {
    const requestedSandbox = sandboxCapability({
      sandbox: overrides.sandbox ?? session.baseOptions.sandbox,
      dangerouslyBypassApprovalsAndSandbox: overrides.dangerouslyBypassApprovalsAndSandbox,
    });
    if (sandboxRank(requestedSandbox) > sandboxRank(session.sandboxCeiling)) {
      return `Session ${session.id} was created with ${session.sandboxCeiling} capability and cannot be escalated to ${requestedSandbox}; start a new codex_task with explicit full_access if higher privileges are required.`;
    }
    if (overrides.forwardSensitiveEnv && !session.allowSensitiveEnv) {
      return `Session ${session.id} was not created with sensitive env forwarding and cannot enable it in a follow-up; start a new codex_task if env-based secrets are required.`;
    }
    return undefined;
  }

  private trimRecentTurns(session: CodexSessionRecord): void {
    while (session.recentTurns.length > maxRecentTurnsRetained) {
      const removableIndex = session.recentTurns.findIndex(
        (candidate) =>
          candidate !== session.activeTurn &&
          !session.queuedTurns.includes(candidate) &&
          terminal(candidate.status),
      );
      if (removableIndex < 0) return;
      const [removed] = session.recentTurns.splice(removableIndex, 1);
      removed?.waiters.clear();
    }
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
      this.appendMilestones(session, [
        {
          kind: "error",
          turn_id: turn.id,
          error: turn.error,
        },
      ], { immediate: true });
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
    session.milestonesPrevState = defaultMilestoneDetectionState();
    this.appendMilestones(session, [
      {
        kind: "turn_started",
        turn_id: turn.id,
        text: turn.kind === "steer" ? "Steering turn started." : "Codex turn started.",
      },
    ]);
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
      this.appendMilestones(session, [
        {
          kind: controller.signal.aborted ? "cancelled" : "error",
          turn_id: turn.id,
          error: session.error,
        },
      ], { immediate: true });
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
      if (controller.signal.aborted && !session.runtimeShutdownRecoverable) {
        this.closeAppServer(session, "cancelled", "cancel");
      }
      throw error;
    } finally {
      session.controller = undefined;
      session.activeTurn = undefined;
      this.scheduleSessionChanged(session, true);
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
            this.recordPartialMilestones(session, partial);
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
      const { value, queuedMs } = await agentRunQueue.enqueue(
        async () => {
          const appServer = await this.ensureAppServer(session, options);
          appServerWasReady = true;
          return appServer.startTurn(
            options,
            controller.signal,
            (partial) => {
              session.partial = partial;
              session.updatedAt = new Date().toISOString();
              this.recordPartialMilestones(session, partial);
              logger.rawDebug("session.turn.partial", {
                sessionId: session.id,
                partial: summarizeRawTrafficForLog(partial),
              });
            },
            { sessionTurnId: session.activeTurn?.id },
          );
        },
        {
          signal: controller.signal,
          projectKey: projectKeyForRunOptions(options),
        },
      );
      return {
        ...value,
        queue: { queuedMs },
      };
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
    session.lastResultTurnId = turn.id;
    session.partial = undefined;
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
    this.trimRecentTurns(session);
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
    this.appendMilestones(session, [
      result.ok
        ? {
            kind: "turn_completed",
            turn_id: turn.id,
            text: result.finalMessage,
          }
        : {
            kind: result.status === "cancelled" ? "cancelled" : "error",
            turn_id: turn.id,
            error: result.finalMessage || `Codex turn ${result.status}`,
          },
    ], { immediate: true });
    logger.rawInfo("session.turn.finish", {
      session: summarizeRawTrafficForLog(snapshot(session)),
      turn: summarizeRawTrafficForLog(turnSnapshot(turn)),
      result: summarizeRawTrafficForLog(result),
    });
    if (session.cancelRequested && session.appServer) this.closeAppServer(session, "cancelled", "cancel");
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

  private async waitForAppServerReady(
    session: CodexSessionRecord,
    timeoutMs: number,
  ): Promise<CodexAppServerSession | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (session.controller && session.activeTurn && session.protocol === "app-server" && Date.now() < deadline) {
      if (session.appServer && !session.appServer.status().closed) return session.appServer;
      const starting = session.appServerStarting;
      if (starting) {
        const remainingMs = Math.max(1, deadline - Date.now());
        try {
          return await Promise.race([
            starting,
            new Promise<undefined>((resolve) => setTimeout(resolve, remainingMs)),
          ]);
        } catch (error) {
          logger.warn("session.steer_app_server_start_failed", {
            sessionId: session.id,
            error: errorForLog(error),
          });
          return session.appServer;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return session.appServer;
  }

  private recordPartialMilestones(session: CodexSessionRecord, partial: AgentRunPartial): void {
    const detected = detectMilestones(partial, session.milestonesPrevState, session.activeTurn?.id);
    session.milestonesPrevState = detected.nextState;
    if (detected.milestones.length > 0) this.appendMilestones(session, detected.milestones);
  }

  private appendMilestones(
    session: CodexSessionRecord,
    milestones: PendingSessionMilestone[],
    options: { immediate?: boolean } = {},
  ): void {
    if (milestones.length === 0) return;
    const appended: SessionMilestone[] = [];
    for (const pendingMilestone of milestones) {
      const sanitized = sanitizeMilestone(pendingMilestone);
      session.milestoneSeq += 1;
      const milestone: SessionMilestone = {
        seq: session.milestoneSeq,
        at: new Date().toISOString(),
        ...sanitized,
      };
      session.milestones.push(milestone);
      appended.push(milestone);
    }
    if (session.milestones.length > this.maxMilestonesPerSession) {
      session.milestones.splice(0, session.milestones.length - this.maxMilestonesPerSession);
    }
    for (const milestone of appended) {
      for (const subscriber of session.milestoneSubscribers) {
        try {
          subscriber({ ...milestone });
        } catch (error) {
          logger.error("session.milestone_subscriber_failed", {
            sessionId: session.id,
            error: errorForLog(error),
          });
        }
      }
    }
    this.scheduleSessionChanged(session, Boolean(options.immediate));
  }

  private scheduleSessionChanged(session: CodexSessionRecord, immediate = false): void {
    if (!this.onSessionChanged) return;
    if (immediate) {
      this.flushSessionChanged(session);
      return;
    }

    const now = Date.now();
    session.firstUnsentMilestoneAt ??= now;
    if (!session.resourceNotifyTimer) {
      session.resourceNotifyTimer = setTimeout(() => this.flushSessionChanged(session), this.resourceDebounceMs);
      session.resourceNotifyTimer.unref();
    }
    if (!session.resourceNotifyMaxTimer) {
      const maxDelay = Math.max(1, this.resourceMaxDelayMs - (now - session.firstUnsentMilestoneAt));
      session.resourceNotifyMaxTimer = setTimeout(() => this.flushSessionChanged(session), maxDelay);
      session.resourceNotifyMaxTimer.unref();
    }
  }

  private flushSessionChanged(session: CodexSessionRecord): void {
    if (session.resourceNotifyTimer) {
      clearTimeout(session.resourceNotifyTimer);
      session.resourceNotifyTimer = undefined;
    }
    if (session.resourceNotifyMaxTimer) {
      clearTimeout(session.resourceNotifyMaxTimer);
      session.resourceNotifyMaxTimer = undefined;
    }
    session.firstUnsentMilestoneAt = undefined;
    this.emitSessionChanged(session.id);
  }

  private emitSessionChanged(sessionId: string): void {
    if (!this.onSessionChanged) return;
    Promise.resolve(this.onSessionChanged(sessionId)).catch((error) => {
      logger.error("session.resource_update_failed", {
        sessionId,
        error: errorForLog(error),
      });
    });
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
    if (session.resourceNotifyTimer) clearTimeout(session.resourceNotifyTimer);
    if (session.resourceNotifyMaxTimer) clearTimeout(session.resourceNotifyMaxTimer);
    this.closeAppServer(session, "cancelled", `prune_${reason}`);
    this.notifySession(session);
    this.emitSessionChanged(id);
    this.persist();
  }

  private closeAppServer(
    session: CodexSessionRecord,
    status: "failed" | "cancelled",
    archiveReason?: string,
  ): void {
    const appServer = session.appServer;
    if (!appServer) return;
    const close = () => appServer.close(status).catch(() => {});
    if (appServer.status().closed) return;
    if (!archiveReason || session.protocol !== "app-server" || !session.codexThreadId) {
      void close();
      return;
    }
    logger.info("session.archive_app_server_thread", {
      sessionId: session.id,
      threadId: session.codexThreadId,
      reason: archiveReason,
    });
    void appServer.archiveThread().finally(close);
  }

  private loadPersistedSessions(): void {
    const store = this.stateStore;
    if (!store) return;
    for (const persisted of store.load({
      maxAgeMs: this.idleTtlSeconds * 1000,
      dropUnresumable: true,
    })) {
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
      sandboxCeiling: sandboxCapability(state.baseOptions),
      allowSensitiveEnv: Boolean(state.baseOptions.forwardSensitiveEnv),
      waiters: new Set(),
      milestones: [],
      milestoneSeq: 0,
      milestoneSubscribers: new Set(),
      milestonesPrevState: defaultMilestoneDetectionState(),
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
      store.save(states, {
        replaceIds: this.persistedSessionIds,
        maxAgeMs: this.idleTtlSeconds * 1000,
        dropUnresumable: true,
      });
    } catch (error) {
      logger.error("session.state.save_failed", { stateFile: store.file, error: errorForLog(error) });
    }
  }
}

export const sessionManager = new CodexSessionManager({ persist: true });
