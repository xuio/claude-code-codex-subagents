import { describe, expect, it } from "vitest";
import { schemaForOutputContract } from "../src/contracts.js";

function objectProperties(schema: unknown): Record<string, unknown> {
  expect(schema && typeof schema === "object").toBe(true);
  return (schema as { properties: Record<string, unknown> }).properties;
}

function required(schema: unknown): string[] {
  expect(schema && typeof schema === "object").toBe(true);
  return (schema as { required?: string[] }).required ?? [];
}

describe("output contracts", () => {
  it("uses strict required keys for review_findings item schemas", () => {
    const schema = schemaForOutputContract("review_findings");
    const findings = objectProperties(schema).findings as { items: unknown };
    const itemProperties = Object.keys(objectProperties(findings.items));

    expect(required(findings.items).sort()).toEqual(itemProperties.sort());
  });

  it("uses nullable fields for optional review_findings values", () => {
    const schema = schemaForOutputContract("review_findings");
    const findings = objectProperties(schema).findings as { items: unknown };
    const itemProperties = objectProperties(findings.items) as Record<string, { type?: unknown }>;

    expect(itemProperties.file?.type).toEqual(["string", "null"]);
    expect(itemProperties.line?.type).toEqual(["integer", "null"]);
    expect(itemProperties.recommendation?.type).toEqual(["string", "null"]);
  });
});
