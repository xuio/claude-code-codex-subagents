import { describe, expect, it } from "vitest";
import { extractJsonResult } from "./json-result.mjs";

describe("extractJsonResult", () => {
  it("parses strict JSON, fenced JSON, and prefixed Claude text", () => {
    expect(extractJsonResult('{"ok":true}')).toEqual({ ok: true });
    expect(extractJsonResult('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(extractJsonResult('All checks passed. {"ok":true,"text":"brace } inside string"}')).toEqual({
      ok: true,
      text: "brace } inside string",
    });
  });
});
