import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolveCodexBinary, type ResolvedCodexBinary } from "./binary.js";
import {
  defaultReasoningEffort,
  resolveRequestedModel,
  resolveWorkingDirectory,
  validateRunConfiguration,
  type AgentRunOptions,
  type AgentRunPartial,
  type AgentRunResult,
  type CodexEventSummary,
  type ReasoningEffort,
  type SandboxMode,
} from "./runner.js";
import { errorForLog, logger, makeLogId, summarizeRawTrafficForLog } from "./logging.js";
import { redactJsonValue, redactSensitiveText, sanitizeChildEnv } from "./redaction.js";
import {
  type PreparedSubagents,
  prepareSubagents,
} from "./subagents.js";

type JsonObject = Record<string, unknown>;
type AppServerRequestMethod =
  | "initialize"
  | "thread/start"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "thread/read";

export class AppServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerUnavailableError";
  }
}

class LimitedText {
  private value = "";
  private truncatedCount = 0;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    const remaining = this.maxChars - this.value.length;
    if (remaining > 0) this.value += chunk.slice(0, remaining);
    if (chunk.length > remaining) this.truncatedCount += chunk.length - Math.max(0, remaining);
  }

  text(): string {
    return this.value;
  }

  truncated(): number {
    return this.truncatedCount;
  }
}

interface PendingRequest {
  method: AppServerRequestMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveTurnState {
  turnId: string;
  started: number;
  options: AgentRunOptions;
  stdout: LimitedText;
  stderr: LimitedText;
  summary: CodexEventSummary;
  finalMessage: string;
  completed?: boolean;
  status?: AgentRunResult["status"];
  error?: string;
  resolve: (result: AgentRunResult) => void;
  publishSnapshot: (force?: boolean) => void;
  lastSnapshotAt: number;
}

function userText(text: string): JsonObject {
  return { type: "text", text, text_elements: [] };
}

function sandboxPolicy(options: AgentRunOptions): JsonObject {
  if (options.dangerouslyBypassApprovalsAndSandbox) return { type: "dangerFullAccess" };
  switch (options.sandbox ?? "read-only") {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    default:
      return { type: "readOnly", networkAccess: false };
  }
}

function sandboxMode(options: AgentRunOptions): SandboxMode {
  if (options.dangerouslyBypassApprovalsAndSandbox) return "danger-full-access";
  return options.sandbox ?? "read-only";
}

function appServerConfig(options: AgentRunOptions, reasoningEffort: ReasoningEffort): JsonObject {
  const config: JsonObject = {
    model_reasoning_effort: reasoningEffort,
  };
  if (options.modelVerbosity) config.model_verbosity = options.modelVerbosity;
  if (options.reasoningSummary) config.model_reasoning_summary = options.reasoningSummary;
  if (options.serviceTier) config.service_tier = options.serviceTier;
  if (options.subagentRuntime?.maxThreads !== undefined) {
    config.agents = {
      ...(typeof config.agents === "object" && config.agents ? config.agents as JsonObject : {}),
      max_threads: options.subagentRuntime.maxThreads,
    };
  }
  if (options.subagentRuntime?.maxDepth !== undefined) {
    config.agents = {
      ...(typeof config.agents === "object" && config.agents ? config.agents as JsonObject : {}),
      max_depth: options.subagentRuntime.maxDepth,
    };
  }
  if (options.subagentRuntime?.jobMaxRuntimeSeconds !== undefined) {
    config.agents = {
      ...(typeof config.agents === "object" && config.agents ? config.agents as JsonObject : {}),
      job_max_runtime_seconds: options.subagentRuntime.jobMaxRuntimeSeconds,
    };
  }
  return config;
}

function hasTurnErrorStatus(status: unknown): boolean {
  return status === "failed" || status === "interrupted";
}

function resultStatusFromTurn(status: unknown): AgentRunResult["status"] {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "cancelled";
  return "failed";
}

function makeSummary(includeEvents: boolean | undefined, threadId: string): CodexEventSummary {
  return {
    counts: {},
    threadId,
    commands: [],
    errors: [],
    events: includeEvents ? [] : undefined,
  };
}

function cloneSummary(summary: CodexEventSummary): CodexEventSummary {
  return redactJsonValue({
    counts: { ...summary.counts },
    threadId: summary.threadId,
    usage: summary.usage,
    commands: summary.commands.map((command) => ({ ...command })),
    errors: [...summary.errors],
    lastAgentMessage: summary.lastAgentMessage,
    events: summary.events ? [...summary.events] : undefined,
  });
}

function truncate(text: string, maxChars: number): { text: string; truncatedChars: number } {
  if (text.length <= maxChars) return { text, truncatedChars: 0 };
  return { text: text.slice(0, maxChars), truncatedChars: text.length - maxChars };
}

export class CodexAppServerSession {
  private readonly id = makeLogId("appserver");
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: JsonObject) => void>();
  private lineBuffer = "";
  private requestCounter = 0;
  private activeTurn?: ActiveTurnState;
  private closed = false;
  private spawnError?: Error;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly codexBinary: ResolvedCodexBinary,
    readonly cwd: string,
    public threadId: string,
    readonly preparedSubagents: PreparedSubagents,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    this.child.once("error", (error) => {
      this.spawnError = error;
      this.rejectAll(new AppServerUnavailableError(`Codex app-server failed: ${error.message}`));
    });
    this.child.once("close", (code, signal) => {
      this.closed = true;
      logger.warn("codex.app_server.closed", { appServerId: this.id, exitCode: code, signal });
      this.rejectAll(new AppServerUnavailableError(`Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}.`));
    });
  }

  static async create(options: AgentRunOptions): Promise<CodexAppServerSession> {
    const mergedEnv = { ...process.env, ...options.env };
    const cwd = await resolveWorkingDirectory(options.projectDir ?? options.cwd, mergedEnv);
    const codexBinary = resolveCodexBinary({
      explicitPath: options.codexBin,
      env: mergedEnv,
    });
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error(`Codex working directory is not a directory: ${cwd}`);
    const preparedSubagents = await prepareSubagents({
      definitions: options.codexSubagents,
      tasks: options.subagentTasks,
      env: options.env,
      isolatedCodexHome: options.isolatedCodexHome,
      mcpConfigPolicy: options.mcpConfigPolicy,
      codexMcpServers: options.codexMcpServers,
      projectDir: cwd,
    });
    const childEnv = sanitizeChildEnv({ ...mergedEnv, ...preparedSubagents.env }, options.forwardSensitiveEnv);
    const child = spawn(codexBinary.path, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const session = new CodexAppServerSession(child, codexBinary, cwd, "", preparedSubagents, childEnv);
    logger.rawDebug("codex.app_server.spawn", {
      appServerId: session.id,
      binary: codexBinary,
      cwd,
      args: ["app-server", "--listen", "stdio://"],
    });

    try {
      await session.initialize(options.spawnTimeoutMs ?? 10_000);
      const { model, reasoningEffort } = validateRunConfiguration(options, childEnv);
      const thread = await session.request("thread/start", {
        cwd,
        model,
        serviceTier: options.serviceTier ?? null,
        approvalPolicy: "never",
        sandbox: sandboxMode(options),
        config: appServerConfig(options, reasoningEffort),
        serviceName: "claude-code-codex-subagents",
        ephemeral: options.ephemeral ?? false,
        threadSource: "subagent",
      }, options.spawnTimeoutMs ?? 30_000) as { thread?: { id?: string }; cwd?: string };
      const threadId = thread.thread?.id;
      if (!threadId) throw new AppServerUnavailableError("Codex app-server did not return a thread id.");
      session.threadId = threadId;
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private async initialize(timeoutMs: number): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "claude-code-codex-subagents", version: "0.1.1" },
      capabilities: null,
    }, timeoutMs);
  }

  get activeTurnId(): string | undefined {
    return this.activeTurn?.turnId;
  }

  async startTurn(
    options: AgentRunOptions,
    abortSignal?: AbortSignal,
    onSnapshot?: (snapshot: AgentRunPartial) => void,
  ): Promise<AgentRunResult> {
    if (this.activeTurn) throw new Error(`Codex app-server already has an active turn: ${this.activeTurn.turnId}`);
    const started = Date.now();
    const maxOutputChars = options.maxOutputChars ?? 60_000;
    const { model, reasoningEffort, reasoningSummary } = validateRunConfiguration(options, this.env);
    const summary = makeSummary(options.includeEvents, this.threadId);
    const stdout = new LimitedText(maxOutputChars);
    const stderr = new LimitedText(Math.min(maxOutputChars, 20_000));
    let timeout: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let timedOut = false;
    let timeoutReason: AgentRunResult["timeoutReason"];

    const prompt = `${this.preparedSubagents.promptPrefix}${options.prompt}`;
    const turnResponse = await this.request("turn/start", {
      threadId: this.threadId,
      input: [userText(prompt)],
      cwd: this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: sandboxPolicy(options),
      model,
      serviceTier: options.serviceTier ?? null,
      effort: reasoningEffort,
      summary: reasoningSummary ?? null,
    }, options.spawnTimeoutMs ?? 30_000) as { turn?: { id?: string } };
    const turnId = turnResponse.turn?.id;
    if (!turnId) throw new AppServerUnavailableError("Codex app-server did not return a turn id.");

    logger.rawDebug("codex.app_server.turn.start", {
      appServerId: this.id,
      threadId: this.threadId,
      turnId,
      prompt: summarizeRawTrafficForLog(prompt),
    });

    const finish = (status: AgentRunResult["status"], error?: string): AgentRunResult => {
      const final = truncate(redactSensitiveText(summary.lastAgentMessage ?? ""), maxOutputChars);
      const result: AgentRunResult = {
        name: options.name,
        ok: status === "completed",
        status,
        durationMs: Date.now() - started,
        codexBinary: this.codexBinary,
        cwd: this.cwd,
        model: resolveRequestedModel(options, this.env),
        modelPreset: options.modelPreset,
        reasoningEffort: options.reasoningEffort ?? defaultReasoningEffort(this.env),
        sandbox: options.sandbox ?? "read-only",
        dangerouslyBypassApprovalsAndSandbox: Boolean(options.dangerouslyBypassApprovalsAndSandbox),
        serviceTier: options.serviceTier,
        exitCode: status === "completed" ? 0 : null,
        signal: null,
        finalMessage: final.text,
        stderr: redactSensitiveText(stderr.text() || error || ""),
        stdoutTail: redactSensitiveText(stdout.text()),
        truncated: {
          stdoutChars: stdout.truncated(),
          stderrChars: stderr.truncated(),
          finalMessageChars: final.truncatedChars,
        },
        eventSummary: cloneSummary(summary),
        commandPreview: [this.codexBinary.path, "app-server", "--listen", "stdio://", "turn/start"],
        timeoutReason,
        codexSubagents: {
          customAgents: this.preparedSubagents.names,
          requestedTasks: options.subagentTasks?.length ?? 0,
          tempCodexHomeUsed: Boolean(this.preparedSubagents.tempCodexHome),
        },
      };
      logger[result.ok ? "rawInfo" : "rawError"]("codex.app_server.turn.finish", {
        appServerId: this.id,
        threadId: this.threadId,
        turnId,
        status,
        finalMessage: summarizeRawTrafficForLog(result.finalMessage),
        eventSummary: summarizeRawTrafficForLog(summary),
      });
      return result;
    };

    const result = await new Promise<AgentRunResult>((resolve) => {
      const publishSnapshot = (force = false) => {
        if (!onSnapshot) return;
        const active = this.activeTurn;
        if (!active) return;
        const now = Date.now();
        if (!force && now - active.lastSnapshotAt < 500) return;
        active.lastSnapshotAt = now;
        onSnapshot({
          name: options.name,
          status: timedOut ? "timeout" : "running",
          durationMs: Date.now() - started,
          cwd: this.cwd,
          stdoutTail: redactSensitiveText(stdout.text()),
          stderrTail: redactSensitiveText(stderr.text()),
          lastAgentMessage: summary.lastAgentMessage ? redactSensitiveText(summary.lastAgentMessage) : undefined,
          eventSummary: cloneSummary(summary),
        });
      };

      this.activeTurn = {
        turnId,
        started,
        options,
        stdout,
        stderr,
        summary,
        finalMessage: "",
        resolve,
        publishSnapshot,
        lastSnapshotAt: 0,
      };
      publishSnapshot(true);

      const interrupt = (reason: "timeout" | "idle_timeout" | "cancelled") => {
        if (reason === "timeout" || reason === "idle_timeout") {
          timedOut = true;
          timeoutReason = reason;
        }
        void this.interrupt(turnId).catch((error) => {
          summary.errors.push(`Codex app-server interrupt failed: ${error.message}`);
          resolve(finish(reason === "cancelled" ? "cancelled" : "timeout", error.message));
        });
        publishSnapshot(true);
      };
      abortHandler = () => interrupt("cancelled");
      abortSignal?.addEventListener("abort", abortHandler, { once: true });
      if (abortSignal?.aborted) interrupt("cancelled");

      const resetIdleTimeout = () => {
        if (!options.idleTimeoutMs) return;
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => interrupt("idle_timeout"), options.idleTimeoutMs);
        idleTimeout.unref();
      };
      resetIdleTimeout();
      timeout = setTimeout(() => interrupt("timeout"), options.timeoutMs ?? 600_000);
      timeout.unref();
    });

    if (timeout) clearTimeout(timeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
    this.activeTurn = undefined;
    return result;
  }

  async steer(prompt: string): Promise<{ delivered: boolean; turnId?: string }> {
    const turnId = this.activeTurn?.turnId;
    if (!turnId) return { delivered: false };
    const response = await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: turnId,
      input: [userText(prompt)],
    }, 10_000) as { turnId?: string };
    return { delivered: true, turnId: response.turnId ?? turnId };
  }

  async interrupt(turnId = this.activeTurn?.turnId): Promise<void> {
    if (!turnId) return;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    }, 10_000);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new AppServerUnavailableError("Codex app-server session was closed."));
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Ignore shutdown races.
    }
    await this.preparedSubagents.cleanup().catch(() => {});
  }

  private request(method: AppServerRequestMethod, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || this.spawnError) {
      return Promise.reject(
        new AppServerUnavailableError(this.spawnError?.message ?? "Codex app-server is closed."),
      );
    }
    const id = `${Date.now().toString(36)}-${++this.requestCounter}`;
    const payload = { id, method, params };
    logger.rawDebug("codex.app_server.request", {
      appServerId: this.id,
      payload: summarizeRawTrafficForLog(payload),
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerUnavailableError(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { method, resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new AppServerUnavailableError(`Codex app-server stdin write failed: ${error.message}`));
      });
    });
  }

  private handleStdout(chunk: string): void {
    logger.rawDebug("codex.app_server.stdout", {
      appServerId: this.id,
      chunk: summarizeRawTrafficForLog(chunk),
    });
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  private handleStderr(chunk: string): void {
    logger.rawDebug("codex.app_server.stderr", {
      appServerId: this.id,
      chunk: summarizeRawTrafficForLog(chunk),
    });
    this.activeTurn?.stderr.append(chunk);
    this.activeTurn?.publishSnapshot(true);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.activeTurn?.summary.errors.push(`Unparseable Codex app-server line: ${line.slice(0, 500)}`);
      return;
    }

    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new AppServerUnavailableError(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && id) {
      this.respondToServerRequest(id, message.method);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message);
    }
  }

  private respondToServerRequest(id: string, method: string): void {
    const result =
      method.includes("requestApproval")
        ? { decision: "decline" }
        : method.includes("requestUserInput")
          ? { answers: {} }
          : method.includes("elicitation/request")
            ? { action: "decline", content: null }
            : method.includes("tool/call")
              ? { contentItems: [], success: false }
              : {};
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private handleNotification(message: JsonObject): void {
    for (const handler of this.notificationHandlers) handler(message);
    const method = message.method as string;
    const params = message.params as JsonObject | undefined;
    const active = this.activeTurn;
    if (!active) return;
    active.stdout.append(`${JSON.stringify(message)}\n`);
    active.summary.counts[method] = (active.summary.counts[method] ?? 0) + 1;
    if (active.summary.events) active.summary.events.push(message);

    const turnId = typeof params?.turnId === "string"
      ? params.turnId
      : typeof (params?.turn as JsonObject | undefined)?.id === "string"
        ? (params?.turn as JsonObject).id as string
        : undefined;
    if (turnId && turnId !== active.turnId) return;

    if (method === "thread/tokenUsage/updated") {
      active.summary.usage = (params?.tokenUsage as unknown) ?? params;
    }

    if (method === "item/agentMessage/delta" && typeof params?.delta === "string") {
      active.finalMessage += params.delta;
      active.summary.lastAgentMessage = active.finalMessage;
    }

    if (method === "item/completed") {
      const item = params?.item as JsonObject | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        active.finalMessage = item.text;
        active.summary.lastAgentMessage = item.text;
      }
      if (item?.type === "commandExecution") {
        active.summary.commands.push({
          command: typeof item.command === "string" ? item.command : undefined,
          status: typeof item.status === "string" ? item.status : undefined,
        });
      }
    }

    if (method === "error") {
      active.summary.errors.push(JSON.stringify(params ?? message));
    }

    if (method === "turn/completed") {
      const turn = params?.turn as JsonObject | undefined;
      const status = resultStatusFromTurn(turn?.status);
      if (hasTurnErrorStatus(turn?.status) && turn?.error) {
        active.summary.errors.push(JSON.stringify(turn.error));
      }
      active.completed = true;
      active.status = status;
      active.resolve(this.finishActiveTurn(status));
      return;
    }

    active.publishSnapshot();
  }

  private finishActiveTurn(status: AgentRunResult["status"]): AgentRunResult {
    const active = this.activeTurn;
    if (!active) throw new Error("No active app-server turn to finish.");
    const maxOutputChars = active.options.maxOutputChars ?? 60_000;
    const final = truncate(redactSensitiveText(active.summary.lastAgentMessage ?? ""), maxOutputChars);
    return {
      name: active.options.name,
      ok: status === "completed",
      status,
      durationMs: Date.now() - active.started,
      codexBinary: this.codexBinary,
      cwd: this.cwd,
      model: resolveRequestedModel(active.options, this.env),
      modelPreset: active.options.modelPreset,
      reasoningEffort: active.options.reasoningEffort ?? defaultReasoningEffort(this.env),
      sandbox: active.options.sandbox ?? "read-only",
      dangerouslyBypassApprovalsAndSandbox: Boolean(active.options.dangerouslyBypassApprovalsAndSandbox),
      serviceTier: active.options.serviceTier,
      exitCode: status === "completed" ? 0 : null,
      signal: null,
      finalMessage: final.text,
      stderr: redactSensitiveText(active.stderr.text()),
      stdoutTail: redactSensitiveText(active.stdout.text()),
      truncated: {
        stdoutChars: active.stdout.truncated(),
        stderrChars: active.stderr.truncated(),
        finalMessageChars: final.truncatedChars,
      },
      eventSummary: cloneSummary(active.summary),
      commandPreview: [this.codexBinary.path, "app-server", "--listen", "stdio://", "turn/start"],
      codexSubagents: {
        customAgents: this.preparedSubagents.names,
        requestedTasks: active.options.subagentTasks?.length ?? 0,
        tempCodexHomeUsed: Boolean(this.preparedSubagents.tempCodexHome),
      },
    };
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.activeTurn) {
      this.activeTurn.summary.errors.push(error.message);
      this.activeTurn.resolve(this.finishActiveTurn("failed"));
      this.activeTurn = undefined;
    }
  }
}
