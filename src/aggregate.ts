import type { AgentRunResult } from "./runner.js";

export interface AggregatedResult {
  ok: boolean;
  totalAgents: number;
  completedAgents: number;
  failedAgents: string[];
  findings: Array<Record<string, unknown>>;
  summaries: Array<{ agent: string; summary: string }>;
  recommendedNextAction: string;
}

function agentName(result: AgentRunResult, index: number): string {
  return result.name ?? `agent-${index + 1}`;
}

function structuredRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function aggregateAgentResults(results: AgentRunResult[]): AggregatedResult {
  const failedAgents = results
    .map((result, index) => ({ result, name: agentName(result, index) }))
    .filter(({ result }) => !result.ok)
    .map(({ name }) => name);
  const findings: Array<Record<string, unknown>> = [];
  const summaries: Array<{ agent: string; summary: string }> = [];

  results.forEach((result, index) => {
    const name = agentName(result, index);
    const structured = structuredRecord(result.structuredOutput);
    if (typeof structured?.summary === "string") {
      summaries.push({ agent: name, summary: structured.summary });
    } else if (result.finalMessage.trim()) {
      summaries.push({ agent: name, summary: result.finalMessage.trim().slice(0, 1000) });
    }

    const structuredFindings = Array.isArray(structured?.findings)
      ? structured.findings
      : Array.isArray(structured?.risks)
        ? structured.risks
        : Array.isArray(structured?.suggestions)
          ? structured.suggestions
          : [];
    for (const finding of structuredFindings) {
      if (finding && typeof finding === "object") {
        findings.push({ agent: name, ...(finding as Record<string, unknown>) });
      }
    }
  });

  return {
    ok: failedAgents.length === 0,
    totalAgents: results.length,
    completedAgents: results.filter((result) => result.ok).length,
    failedAgents,
    findings,
    summaries,
    recommendedNextAction:
      failedAgents.length > 0
        ? `Inspect failed agents first: ${failedAgents.join(", ")}.`
        : findings.length > 0
          ? "Review the aggregated findings and address the highest-severity concrete items first."
          : "Use the per-agent summaries to decide whether more focused follow-up is needed.",
  };
}
