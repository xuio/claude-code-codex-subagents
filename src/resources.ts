import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outputArtifactDiagnostics } from "./artifacts.js";
import { cleanOption } from "./binary.js";
import { diagnosticStats, recentDiagnosticEvents } from "./diagnostics.js";
import { jobManager } from "./jobs.js";
import { lifecycleStats } from "./lifecycle.js";
import { errorForLog, logger, loggingDiagnostics } from "./logging.js";
import { detectPluginProcesses } from "./processes.js";
import { redactJsonValue, redactSensitiveText } from "./redaction.js";
import {
  compactAgentResultForMcp,
} from "./response.js";
import {
  defaultModel,
  defaultReasoningEffort,
  mcpConfigPolicies,
  outputContracts,
  probeCodexVersion,
  reasoningEfforts,
  resolveWorkingDirectory,
  sandboxModes,
} from "./runner.js";
import { maxSessionMilestones, sessionManager, type CodexSessionSnapshot, type SessionMilestone } from "./sessions.js";
import { modelPresets } from "./subagents.js";
import {
  configuredMaxBlockingWaitMs,
  defaultBlockingWaitTimeoutMs,
  hardMaxBlockingWaitTimeoutMs,
} from "./wait-timeout.js";

type ResourceVisibility = {
  debugToolsEnabled: boolean;
  legacyToolsEnabled: boolean;
};

export function sessionResourceUri(sessionId: string): string {
  return `codex://sessions/${encodeURIComponent(sessionId)}`;
}

export async function codexStatusPayload(codexBin?: string, visibility?: ResourceVisibility) {
  const status = await probeCodexVersion(codexBin);
  const processes = await detectPluginProcesses();
  return {
    ok: !status.error,
    binary: status.binary,
    version: status.version,
    error: status.error,
    cwd: process.cwd(),
    defaultTools: ["codex_task", "codex_task_group", "codex_followup", "codex_wait_any"],
    hiddenDebugTools: visibility ? !visibility.debugToolsEnabled : process.env.CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS !== "1",
    hiddenLegacyTools: visibility ? !visibility.legacyToolsEnabled : process.env.CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS !== "1",
    defaultModel: defaultModel(),
    defaultReasoningEffort: defaultReasoningEffort(),
    defaultSandbox: "read-only",
    fullAccessFlag: "full_access",
    advancedFullAccessFlag: "advanced.dangerously_bypass_approvals_and_sandbox",
    defaultServiceTier: "codex-default",
    defaultSessionProtocol: process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL === "exec" ? "exec" : "app-server",
    appServerProtocol: {
      transport: "stdio",
      command: "codex app-server --listen stdio://",
      default: process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL === "exec" ? "exec" : "app-server",
      requiredMethods: ["initialize", "thread/start", "turn/start"],
      liveSteeringMethods: ["turn/steer", "turn/interrupt"],
      recoveryMethods: ["thread/resume", "thread/read"],
      passiveMethods: ["thread/read"],
      fallbackToExec: process.env.CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK === "1" ? "disabled" : "enabled",
    },
    appServerFallback: process.env.CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK === "1" ? "disabled" : "enabled",
    modelPresets: {
      codex: "gpt-5.3-codex",
      spark: "gpt-5.3-codex-spark",
    },
    outputContracts,
    mcpConfigPolicies,
    pluginCodexBin: cleanOption(process.env.CODEX_SUBAGENTS_CODEX_BIN),
    claudeProjectDir: cleanOption(process.env.CLAUDE_PROJECT_DIR),
    queue: jobManager.stats(),
    sessions: sessionManager.stats(),
    notifications: {
      resource_updates_enabled: true,
      debounce_ms: 250,
      max_delay_ms: 2_000,
      max_milestones_per_session: maxSessionMilestones(),
    },
    waits: {
      default_blocking_wait_timeout_ms: defaultBlockingWaitTimeoutMs,
      max_blocking_wait_ms: configuredMaxBlockingWaitMs(),
      hard_max_blocking_wait_ms: hardMaxBlockingWaitTimeoutMs,
    },
    logging: loggingDiagnostics(),
    artifacts: outputArtifactDiagnostics(),
    processes,
    diagnostics: {
      ...diagnosticStats(),
      recentFailures: recentDiagnosticEvents(20),
    },
    lifecycle: lifecycleStats(),
  };
}

export async function codexDoctorPayload(args: { codex_bin?: string; project_dir?: string } = {}) {
  const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
  let ok = true;

  try {
    const status = await probeCodexVersion(args.codex_bin);
    checks.push({
      name: "codex_binary",
      ok: !status.error,
      detail: { binary: status.binary, version: status.version, error: status.error },
    });
    if (status.error) ok = false;
  } catch (error) {
    ok = false;
    logger.error("codex_doctor.binary_failed", { error: errorForLog(error) });
    checks.push({
      name: "codex_binary",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const projectDir = await resolveWorkingDirectory(args.project_dir);
    checks.push({
      name: "project_dir",
      ok: true,
      detail: { projectDir: cleanOption(projectDir) },
    });
  } catch (error) {
    ok = false;
    logger.error("codex_doctor.project_dir_failed", { error: errorForLog(error) });
    checks.push({ name: "project_dir", ok: false, detail: String(error) });
  }

  checks.push({
    name: "defaults",
    ok: defaultReasoningEffort() !== "minimal",
    detail: {
      sandbox: "read-only",
      fullAccess: false,
      approvalPolicy: "never",
      defaultModel: defaultModel(),
      defaultReasoningEffort: defaultReasoningEffort(),
      forwardSensitiveEnvDefault: false,
    },
  });
  checks.push({ name: "queue", ok: true, detail: jobManager.stats() });
  checks.push({ name: "sessions", ok: true, detail: sessionManager.stats() });
  checks.push({ name: "logging", ok: true, detail: loggingDiagnostics() });
  checks.push({ name: "artifacts", ok: true, detail: outputArtifactDiagnostics() });
  checks.push({ name: "diagnostics", ok: true, detail: diagnosticStats() });
  checks.push({ name: "lifecycle", ok: true, detail: lifecycleStats() });
  const processes = await detectPluginProcesses();
  const processOk = processes.highCpuStaleSuspects.length === 0;
  if (!processOk) ok = false;
  checks.push({
    name: "stale_processes",
    ok: processOk,
    detail: processes,
  });

  return {
    ok,
    checks,
    supported: {
      modelPresets,
      reasoningEfforts,
      sandboxModes,
      fullAccessFlag: "full_access",
      advancedFullAccessFlag: "advanced.dangerously_bypass_approvals_and_sandbox",
      outputContracts,
      mcpConfigPolicies,
    },
  };
}

export function sessionResourceStatus(session: CodexSessionSnapshot): "running" | "idle" | "failed" | "cancelled" {
  if (session.status === "failed" || session.status === "cancelled") return session.status;
  return session.active ? "running" : "idle";
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function sessionResourceMilestone(milestone: SessionMilestone): Record<string, unknown> {
  return redactJsonValue({
    seq: milestone.seq,
    at: milestone.at,
    kind: milestone.kind,
    turn_id: milestone.turn_id,
    command: milestone.command,
    text: milestone.text,
    error: milestone.error,
  });
}

function sessionResourceBody(session: CodexSessionSnapshot): Record<string, unknown> {
  const lastResult = session.lastResult ? compactAgentResultForMcp(session.lastResult) : undefined;
  return redactJsonValue({
    id: session.id,
    name: session.name,
    status: sessionResourceStatus(session),
    active: session.active,
    completed: Boolean(
      !session.active &&
        session.queuedTurns.length === 0 &&
        (session.lastResult || session.status === "failed" || session.status === "cancelled"),
    ),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    project_dir: session.projectDir ?? session.cwd,
    turns: session.turns,
    queued_turns: session.queuedTurns.length,
    last_milestone_seq: session.lastMilestoneSeq,
    milestones: session.milestones.map(sessionResourceMilestone),
    last_result: lastResult
      ? {
          ok: lastResult.ok,
          status: lastResult.status,
          final_message: redactSensitiveText(lastResult.finalMessage),
          duration_ms: lastResult.durationMs,
          turn_id: session.lastResultTurnId,
        }
      : null,
  });
}

function sessionResourceList() {
  return {
    resources: sessionManager.list().slice(0, 100).map((session) => ({
      uri: sessionResourceUri(session.id),
      name: session.name ?? session.id,
      mimeType: "application/json",
      description: `Codex session ${sessionResourceStatus(session)} - ${session.turns} turn${session.turns === 1 ? "" : "s"}`,
    })),
  };
}

function templateVariable(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}

export function registerResources(
  server: McpServer,
  options: ResourceVisibility & { usageGuide: string },
): void {
  server.registerResource(
    "codex-usage",
    "codex://usage",
    {
      title: "Codex Subagents Usage",
      description: "Claude-facing operating guide for using Codex subagents through the native MCP tools.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: options.usageGuide,
        },
      ],
    }),
  );

  server.registerResource(
    "codex-status",
    "codex://status",
    {
      title: "Codex Subagents Status",
      description: "Read-only diagnostics: binary, version, default settings, queues, sessions, logging, and recent failures.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await codexStatusPayload(undefined, options)),
  );

  server.registerResource(
    "codex-doctor",
    "codex://doctor",
    {
      title: "Codex Subagents Doctor",
      description: "Read-only health checks for Codex binary resolution, project directory, defaults, queues, and logging.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await codexDoctorPayload()),
  );

  server.registerResource(
    "codex-session",
    new ResourceTemplate("codex://sessions/{session_id}", {
      list: () => sessionResourceList(),
    }),
    {
      title: "Codex Session",
      description: "Codex TaskGet/TaskList-style resource: per-session progress milestones and completion state for background tasks.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const sessionId = templateVariable(variables.session_id);
      const session = sessionManager.get(sessionId);
      if (!session) throw new Error(`Unknown session_id: ${sessionId}`);
      return jsonResource(uri, sessionResourceBody(session));
    },
  );
}
