import type { AgentRunPartial, AgentRunResult, CodexEventSummary } from "./runner.js";
import { redactSensitiveText } from "./redaction.js";

interface TruncatedString {
  text: string;
  omittedChars: number;
}

interface CompactLimits {
  finalMessageChars: number;
  stdioChars: number;
  summaryMessageChars: number;
  structuredStringChars: number;
}

const singleAgentLimits: CompactLimits = {
  finalMessageChars: 12_000,
  stdioChars: 1_500,
  summaryMessageChars: 1_000,
  structuredStringChars: 4_000,
};

const partialLimits: CompactLimits = {
  finalMessageChars: 2_000,
  stdioChars: 1_000,
  summaryMessageChars: 1_000,
  structuredStringChars: 2_000,
};

function truncateString(text: string | undefined, maxChars: number): TruncatedString {
  if (!text) return { text: "", omittedChars: 0 };
  if (text.length <= maxChars) return { text, omittedChars: 0 };
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars from MCP response; full traffic is in server logs]`,
    omittedChars: text.length - maxChars,
  };
}

function compactUnknown(value: unknown, maxStringChars: number, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, maxStringChars).text;
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 6) return "[MaxDepth]";

  if (Array.isArray(value)) {
    const items = value.slice(0, 80).map((item) => compactUnknown(item, maxStringChars, depth + 1));
    if (value.length > items.length) items.push(`[truncated ${value.length - items.length} array items]`);
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const compacted = Object.fromEntries(
    entries.slice(0, 80).map(([key, child]) => [
      key,
      compactUnknown(child, maxStringChars, depth + 1),
    ]),
  );
  if (entries.length > 80) {
    compacted.__truncatedObjectKeys = `[truncated ${entries.length - 80} object keys]`;
  }
  return compacted;
}

function compactSummary(summary: CodexEventSummary, limits: CompactLimits): CodexEventSummary {
  return {
    counts: summary.counts,
    threadId: summary.threadId,
    usage: compactUnknown(summary.usage, limits.structuredStringChars),
    commands: summary.commands.slice(0, 20).map((command) => ({
      command: truncateString(command.command, 500).text,
      status: command.status,
    })),
    errors: summary.errors.slice(0, 10).map((error) => truncateString(error, limits.stdioChars).text),
    lastAgentMessage: summary.lastAgentMessage
      ? truncateString(summary.lastAgentMessage, limits.summaryMessageChars).text
      : undefined,
    events: summary.events ? (compactUnknown(summary.events, limits.structuredStringChars) as unknown[]) : undefined,
  };
}

function compactedAgentLimits(agentCount: number): CompactLimits {
  if (agentCount <= 1) return singleAgentLimits;
  return {
    ...singleAgentLimits,
    finalMessageChars: Math.max(1_500, Math.min(6_000, Math.floor(18_000 / agentCount))),
    stdioChars: 800,
    summaryMessageChars: 600,
    structuredStringChars: 2_000,
  };
}

export function compactAgentResultForMcp(
  result: AgentRunResult,
  limits: CompactLimits = singleAgentLimits,
): AgentRunResult & { mcpResponse: Record<string, unknown> } {
  const finalMessage = truncateString(result.finalMessage, limits.finalMessageChars);
  const stdoutTail = truncateString(result.stdoutTail, limits.stdioChars);
  const stderr = truncateString(result.stderr, limits.stdioChars);
  const compacted =
    finalMessage.omittedChars > 0 || stdoutTail.omittedChars > 0 || stderr.omittedChars > 0;

  return {
    ...result,
    finalMessage: finalMessage.text,
    stderr: stderr.text,
    stdoutTail: stdoutTail.text,
    eventSummary: compactSummary(result.eventSummary, limits),
    structuredOutput: compactUnknown(result.structuredOutput, limits.structuredStringChars),
    commandPreview: result.commandPreview
      .slice(0, 40)
      .map((arg) => truncateString(redactSensitiveText(arg), 1_000).text),
    mcpResponse: {
      compacted,
      finalMessageOmittedChars: finalMessage.omittedChars,
      stdoutTailOmittedChars: stdoutTail.omittedChars,
      stderrOmittedChars: stderr.omittedChars,
      note: compacted
        ? "MCP response was compacted to keep Claude responsive; full raw traffic is in server stderr logs."
        : undefined,
    },
  };
}

export function compactAgentResultsForMcp(results: AgentRunResult[]): Array<ReturnType<typeof compactAgentResultForMcp>> {
  const limits = compactedAgentLimits(results.length);
  return results.map((result) => compactAgentResultForMcp(result, limits));
}

export function compactPartialForMcp(partial: AgentRunPartial): AgentRunPartial {
  const stdoutTail = truncateString(partial.stdoutTail, partialLimits.stdioChars);
  const stderrTail = truncateString(partial.stderrTail, partialLimits.stdioChars);
  return {
    ...partial,
    stdoutTail: stdoutTail.text,
    stderrTail: stderrTail.text,
    lastAgentMessage: partial.lastAgentMessage
      ? truncateString(partial.lastAgentMessage, partialLimits.finalMessageChars).text
      : undefined,
    eventSummary: compactSummary(partial.eventSummary, partialLimits),
  };
}

export function compactJobSnapshotForMcp<T extends { result?: unknown; partial?: unknown }>(job: T): T {
  return {
    ...job,
    result: compactRunValue(job.result),
    partial: isPartial(job.partial) ? compactPartialForMcp(job.partial) : compactUnknown(job.partial, 2_000),
  };
}

function compactSessionTurn(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const turn = value as Record<string, unknown>;
  if (typeof turn.prompt !== "string") return value;
  const prompt = truncateString(turn.prompt, 2_000);
  return {
    ...turn,
    prompt: prompt.text,
    promptOmittedChars: prompt.omittedChars || undefined,
  };
}

function compactSessionTurns(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 20).map(compactSessionTurn);
}

export function compactSessionSnapshotForMcp<T extends { lastResult?: unknown; partial?: unknown }>(session: T): T {
  const sessionRecord = session as T & {
    active?: boolean;
    status?: unknown;
    activeTurn?: unknown;
    queuedTurns?: unknown;
    recentTurns?: unknown;
  };
  const status =
    sessionRecord.status === "active" && sessionRecord.active === false
      ? "idle"
      : sessionRecord.status;
  return {
    ...session,
    status,
    lastResult: compactRunValue(session.lastResult),
    partial: isPartial(session.partial) ? compactPartialForMcp(session.partial) : compactUnknown(session.partial, 2_000),
    activeTurn: compactSessionTurn(sessionRecord.activeTurn),
    queuedTurns: compactSessionTurns(sessionRecord.queuedTurns),
    recentTurns: compactSessionTurns(sessionRecord.recentTurns),
  } as T;
}

export function compactRunValue(value: unknown): unknown {
  if (isAgentResult(value)) return compactAgentResultForMcp(value);
  if (Array.isArray(value) && value.every(isAgentResult)) return compactAgentResultsForMcp(value);
  if (isParallelResult(value)) {
    return {
      ...value,
      agents: compactAgentResultsForMcp(value.agents),
    };
  }
  return compactUnknown(value, 4_000);
}

function isAgentResult(value: unknown): value is AgentRunResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "ok" in value &&
      "status" in value &&
      "finalMessage" in value &&
      "eventSummary" in value,
  );
}

function isPartial(value: unknown): value is AgentRunPartial {
  return Boolean(
    value &&
      typeof value === "object" &&
      "status" in value &&
      "stdoutTail" in value &&
      "stderrTail" in value &&
      "eventSummary" in value,
  );
}

function isParallelResult(value: unknown): value is { agents: AgentRunResult[] } {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { agents?: unknown }).agents) &&
      (value as { agents: unknown[] }).agents.every(isAgentResult),
  );
}
