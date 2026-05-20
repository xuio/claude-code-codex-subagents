import { describe, expect, it } from "vitest";
import { isSensitiveKey, redactSensitiveText, sanitizeChildEnv } from "../src/redaction.js";

describe("redaction", () => {
  it("redacts common token and credential-url shapes", () => {
    const text = [
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "GITHUB=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0000",
      "AWS=AKIAABCDEFGHIJKLMNOP",
      "postgres://user:password@example.com/db",
      "Authorization: Bearer bearer-token-1234567890",
    ].join("\n");

    const redacted = redactSensitiveText(text);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0000");
    expect(redacted).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(redacted).not.toContain("postgres://user:password@example.com/db");
    expect(redacted).not.toContain("bearer-token-1234567890");
  });

  it("uses one sensitive-key policy for env and log redaction", () => {
    expect(isSensitiveKey("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(isSensitiveKey("DATABASE_URL")).toBe(true);
    expect(isSensitiveKey("SLACK_WEBHOOK_URL")).toBe(true);
    expect(isSensitiveKey("RATE_LIMIT_TOKEN_BUCKET")).toBe(false);
  });

  it("drops common credential env vars and URL credentials by default", () => {
    const env = sanitizeChildEnv({
      PATH: "/bin",
      AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP",
      DATABASE_URL: "postgres://user:password@example.com/db",
      SERVICE_URL: "https://user:secret@example.com",
      RATE_LIMIT_TOKEN_BUCKET: "safe bucket name",
    });

    expect(env.PATH).toBe("/bin");
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SERVICE_URL).toBeUndefined();
    expect(env.RATE_LIMIT_TOKEN_BUCKET).toBe("safe bucket name");
  });
});
