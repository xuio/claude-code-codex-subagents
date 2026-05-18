export const outputContracts = [
  "freeform",
  "review_findings",
  "plan",
  "risk_matrix",
  "patch_suggestions",
] as const;

export type OutputContract = (typeof outputContracts)[number];

const reviewFindingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "description"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          title: { type: "string" },
          description: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          recommendation: { type: "string" },
        },
      },
    },
  },
};

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps"],
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const riskMatrixSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "risks"],
  properties: {
    summary: { type: "string" },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk", "likelihood", "impact", "mitigation"],
        properties: {
          risk: { type: "string" },
          likelihood: { type: "string", enum: ["low", "medium", "high"] },
          impact: { type: "string", enum: ["low", "medium", "high"] },
          mitigation: { type: "string" },
          owner: { type: "string" },
        },
      },
    },
  },
};

const patchSuggestionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "suggestions"],
  properties: {
    summary: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "description"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          description: { type: "string" },
          suggested_change: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

export function schemaForOutputContract(
  contract: OutputContract | undefined,
  customSchema?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (customSchema) return customSchema;
  switch (contract) {
    case "review_findings":
      return reviewFindingsSchema;
    case "plan":
      return planSchema;
    case "risk_matrix":
      return riskMatrixSchema;
    case "patch_suggestions":
      return patchSuggestionsSchema;
    default:
      return undefined;
  }
}

export function parseStructuredOutput(text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Codex returned an empty final message." };
  try {
    return { value: JSON.parse(trimmed) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
