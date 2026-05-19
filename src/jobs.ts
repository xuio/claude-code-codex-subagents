import {
  type AgentRunOptions,
  type AgentRunPartial,
  type AgentRunResult,
  type ParallelRunOptions,
  runAgent,
} from "./runner.js";
import { errorForLog, logger, summarizeRawTrafficForLog } from "./logging.js";

export class AbortError extends Error {
  constructor(message = "Operation was cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}

type JobKind = "agent" | "agents";
type JobStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

interface QueueTask<T> {
  id: string;
  projectKey: string;
  enqueuedAt: number;
  run: () => Promise<T>;
  resolve: (value: { value: T; queuedMs: number }) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onStart?: (queuedMs: number) => void | Promise<void>;
}

interface QueueRunOptions {
  signal?: AbortSignal;
  projectKey?: string;
  onStart?: (queuedMs: number, label?: string) => void | Promise<void>;
  onComplete?: (result: AgentRunResult, index?: number, total?: number) => void | Promise<void>;
  onSnapshot?: (snapshot: AgentRunPartial, index?: number, total?: number) => void | Promise<void>;
}

interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  queuedMs?: number;
  result?: unknown;
  partial?: unknown;
  error?: string;
  controller: AbortController;
  waiters: Set<() => void>;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  queuedMs?: number;
  result?: unknown;
  partial?: unknown;
  error?: string;
}

export interface QueueStats {
  active: number;
  pending: number;
  maxGlobal: number;
  maxPerProject: number;
}

function readPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function projectKeyForOptions(options: Pick<AgentRunOptions, "projectDir" | "cwd">): string {
  return options.projectDir?.trim() || options.cwd?.trim() || process.env.CLAUDE_PROJECT_DIR?.trim() || "__default__";
}

function statusFromAgentResult(result: AgentRunResult): JobStatus {
  if (result.status === "cancelled") return "cancelled";
  return result.ok ? "completed" : "failed";
}

function statusFromAgentResults(results: AgentRunResult[]): JobStatus {
  if (results.every((result) => result.ok)) return "completed";
  if (results.some((result) => result.status === "cancelled")) return "cancelled";
  return "failed";
}

function snapshot(job: JobRecord): JobSnapshot {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    queuedMs: job.queuedMs,
    result: job.result,
    partial: job.partial,
    error: job.error,
  };
}

async function callQueueCallback(callback: () => void | Promise<void>): Promise<void> {
  try {
    await callback();
  } catch {
    // Queue callbacks are observational; callback failures must not change run results.
  }
}

class AgentRunQueue {
  private pending: Array<QueueTask<unknown>> = [];
  private active = 0;
  private readonly projectActive = new Map<string, number>();

  constructor(
    private readonly maxGlobal = readPositiveInt(process.env.CODEX_SUBAGENTS_MAX_GLOBAL_PROCESSES, 4, 32),
    private readonly maxPerProject = readPositiveInt(process.env.CODEX_SUBAGENTS_MAX_PROJECT_PROCESSES, 2, 32),
  ) {}

  stats(): QueueStats {
    return {
      active: this.active,
      pending: this.pending.length,
      maxGlobal: this.maxGlobal,
      maxPerProject: this.maxPerProject,
    };
  }

  enqueue<T>(run: () => Promise<T>, options: QueueRunOptions = {}): Promise<{ value: T; queuedMs: number }> {
    if (options.signal?.aborted) {
      logger.warn("queue.enqueue_rejected_cancelled", { projectKey: options.projectKey ?? "__default__" });
      return Promise.reject(new AbortError("Codex run was cancelled before it entered the queue."));
    }

    return new Promise((resolve, reject) => {
      const task: QueueTask<T> = {
        id: `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        projectKey: options.projectKey ?? "__default__",
        enqueuedAt: Date.now(),
        run,
        resolve,
        reject,
        signal: options.signal,
        onStart: options.onStart,
      };

      const abortPending = () => {
        const index = this.pending.indexOf(task as QueueTask<unknown>);
        if (index >= 0) {
          this.pending.splice(index, 1);
          logger.warn("queue.cancelled_while_pending", { queueTaskId: task.id, projectKey: task.projectKey });
          reject(new AbortError("Codex run was cancelled while queued."));
        }
      };

      options.signal?.addEventListener("abort", abortPending, { once: true });
      this.pending.push(task as QueueTask<unknown>);
      logger.debug("queue.enqueued", {
        queueTaskId: task.id,
        projectKey: task.projectKey,
        stats: this.stats(),
      });
      this.tryStart();
    });
  }

  private canStart(projectKey: string): boolean {
    return this.active < this.maxGlobal && (this.projectActive.get(projectKey) ?? 0) < this.maxPerProject;
  }

  private tryStart(): void {
    while (this.active < this.maxGlobal) {
      const index = this.pending.findIndex((task) => this.canStart(task.projectKey));
      if (index < 0) return;

      const [task] = this.pending.splice(index, 1);
      if (!task) return;
      if (task.signal?.aborted) {
        logger.warn("queue.cancelled_before_start", { queueTaskId: task.id, projectKey: task.projectKey });
        task.reject(new AbortError("Codex run was cancelled while queued."));
        continue;
      }

      const queuedMs = Date.now() - task.enqueuedAt;
      this.active += 1;
      this.projectActive.set(task.projectKey, (this.projectActive.get(task.projectKey) ?? 0) + 1);
      logger.debug("queue.started", {
        queueTaskId: task.id,
        projectKey: task.projectKey,
        queuedMs,
        stats: this.stats(),
      });
      void callQueueCallback(() => task.onStart?.(queuedMs));

      Promise.resolve()
        .then(task.run)
        .then((value) => {
          logger.debug("queue.completed", { queueTaskId: task.id, projectKey: task.projectKey });
          task.resolve({ value, queuedMs });
        })
        .catch((error) => {
          logger.error("queue.failed", {
            queueTaskId: task.id,
            projectKey: task.projectKey,
            error: errorForLog(error),
          });
          task.reject(error);
        })
        .finally(() => {
          this.active -= 1;
          const projectCount = (this.projectActive.get(task.projectKey) ?? 1) - 1;
          if (projectCount > 0) this.projectActive.set(task.projectKey, projectCount);
          else this.projectActive.delete(task.projectKey);
          logger.debug("queue.released", {
            queueTaskId: task.id,
            projectKey: task.projectKey,
            stats: this.stats(),
          });
          this.tryStart();
        });
    }
  }
}

export const agentRunQueue = new AgentRunQueue();

export async function runQueuedAgent(
  options: AgentRunOptions,
  queueOptions: QueueRunOptions = {},
): Promise<AgentRunResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  queueOptions.signal?.addEventListener("abort", abort, { once: true });
  if (options.abortSignal?.aborted || queueOptions.signal?.aborted) controller.abort();

  try {
    const onSnapshot = options.onSnapshot || queueOptions.onSnapshot
      ? (snapshot: AgentRunPartial) => {
          options.onSnapshot?.(snapshot);
          void callQueueCallback(() => queueOptions.onSnapshot?.(snapshot));
        }
      : undefined;
    const { value, queuedMs } = await agentRunQueue.enqueue(
      () => runAgent({ ...options, abortSignal: controller.signal, onSnapshot }),
      {
        signal: controller.signal,
        projectKey: queueOptions.projectKey ?? projectKeyForOptions(options),
        onStart: (queuedMs) => queueOptions.onStart?.(queuedMs, options.name),
      },
    );
    await callQueueCallback(() => queueOptions.onComplete?.(value));
    return {
      ...value,
      queue: { queuedMs },
    };
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
    queueOptions.signal?.removeEventListener("abort", abort);
  }
}

export async function runQueuedAgents(
  options: ParallelRunOptions,
  queueOptions: QueueRunOptions = {},
): Promise<AgentRunResult[]> {
  const maxParallel = Math.max(
    1,
    Math.min(options.maxParallel ?? Math.min(options.agents.length, 4), 8),
  );
  const results: AgentRunResult[] = new Array(options.agents.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < options.agents.length) {
      const index = next;
      next += 1;
      const agent = options.agents[index];
      if (!agent) continue;
      const result = await runQueuedAgent(
        {
          ...options,
          ...agent,
          model: agent.model ?? options.defaultModel,
          modelPreset: agent.modelPreset ?? options.modelPreset,
          reasoningEffort: agent.reasoningEffort ?? options.defaultReasoningEffort,
          prompt: agent.prompt,
          name: agent.name ?? `agent-${index + 1}`,
        },
        {
          ...queueOptions,
          onStart: (queuedMs) => queueOptions.onStart?.(queuedMs, agent.name ?? `agent-${index + 1}`),
          onComplete: undefined,
          onSnapshot: (snapshot) =>
            queueOptions.onSnapshot?.(snapshot, index, options.agents.length),
        },
      );
      results[index] = result;
      await callQueueCallback(() => queueOptions.onComplete?.(result, index, options.agents.length));
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxParallel, options.agents.length) }, worker));
  return results;
}

export class CodexJobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly ttlMs = readPositiveInt(process.env.CODEX_SUBAGENTS_JOB_TTL_SECONDS, 3600, 86_400) * 1000;

  startAgent(options: AgentRunOptions): JobSnapshot {
    return this.start("agent", async (job) => {
      const result = await runQueuedAgent(options, {
        signal: job.controller.signal,
        onStart: (queuedMs) => {
          job.status = "running";
          job.startedAt = new Date().toISOString();
          job.queuedMs = queuedMs;
          job.updatedAt = job.startedAt;
        },
        onSnapshot: (partial) => {
          job.partial = partial;
          job.updatedAt = new Date().toISOString();
        },
      });
      return result;
    });
  }

  startAgents(options: ParallelRunOptions): JobSnapshot {
    return this.start("agents", async (job) => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      job.updatedAt = job.startedAt;
      const results = await runQueuedAgents(options, {
        signal: job.controller.signal,
        onSnapshot: (partial, index) => {
          const current =
            job.partial && typeof job.partial === "object" && Array.isArray((job.partial as { agents?: unknown[] }).agents)
              ? [...((job.partial as { agents: unknown[] }).agents)]
              : new Array(options.agents.length).fill(undefined);
          if (index !== undefined) current[index] = partial;
          job.partial = { agents: current };
          job.updatedAt = new Date().toISOString();
        },
      });
      return {
        ok: results.every((result) => result.ok),
        agents: results,
      };
    });
  }

  get(id: string): JobSnapshot | undefined {
    this.prune();
    const job = this.jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  cancel(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!job.completedAt && job.status !== "cancelled") {
      job.status = "cancelling";
      job.updatedAt = new Date().toISOString();
      job.controller.abort();
    }
    return snapshot(job);
  }

  async wait(id: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<JobSnapshot | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.completedAt) return snapshot(job);
    if (abortSignal?.aborted) return snapshot(job);

    await new Promise<void>((resolve) => {
      let finished = false;
      let waiter: (() => void) | undefined;
      let abortHandler: (() => void) | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (waiter) job.waiters.delete(waiter);
        if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      waiter = () => {
        finish();
      };
      abortHandler = finish;
      job.waiters.add(waiter);
      abortSignal?.addEventListener("abort", abortHandler, { once: true });
      if (abortSignal?.aborted) finish();
    });

    return snapshot(job);
  }

  stats(): QueueStats & { jobs: number; waiters: number } {
    this.prune();
    return {
      ...agentRunQueue.stats(),
      jobs: this.jobs.size,
      waiters: [...this.jobs.values()].reduce((count, job) => count + job.waiters.size, 0),
    };
  }

  cancelAll(reason = "shutdown"): JobSnapshot[] {
    logger.warn("job.cancel_all", { reason, jobs: this.jobs.size });
    const snapshots: JobSnapshot[] = [];
    for (const job of this.jobs.values()) {
      if (!job.completedAt && job.status !== "cancelled") {
        job.status = "cancelling";
        job.updatedAt = new Date().toISOString();
        job.controller.abort();
      }
      this.notifyJob(job);
      snapshots.push(snapshot(job));
    }
    return snapshots;
  }

  private start(kind: JobKind, run: (job: JobRecord) => Promise<unknown>): JobSnapshot {
    this.prune();
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      kind,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
      waiters: new Set(),
    };
    this.jobs.set(job.id, job);
    logger.rawDebug("job.started", {
      job: summarizeRawTrafficForLog(snapshot(job)),
    });

    void run(job)
      .then((result) => {
        job.result = result;
        if (kind === "agent") {
          job.status = statusFromAgentResult(result as AgentRunResult);
        } else {
          const agents = (result as { agents?: AgentRunResult[] }).agents ?? [];
          job.status = statusFromAgentResults(agents);
        }
        logger.rawInfo("job.finished", {
          jobId: job.id,
          kind: job.kind,
          status: job.status,
          result: summarizeRawTrafficForLog(result),
        });
      })
      .catch((error) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = error instanceof AbortError ? "cancelled" : "failed";
        logger.error("job.failed", {
          jobId: job.id,
          kind: job.kind,
          status: job.status,
          error: errorForLog(error),
        });
      })
      .finally(() => {
        const nowDone = new Date().toISOString();
        job.completedAt = nowDone;
        job.updatedAt = nowDone;
        this.notifyJob(job);
      });

    return snapshot(job);
  }

  private notifyJob(job: JobRecord): void {
    for (const waiter of [...job.waiters]) waiter();
    job.waiters.clear();
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (!job.completedAt) continue;
      if (Date.parse(job.completedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

export const jobManager = new CodexJobManager();
