import { describe, expect, it } from "vitest";
import { recoveryForError } from "../src/recovery.js";

describe("recovery hints", () => {
  it("treats deterministic path errors as non-recoverable", () => {
    for (const message of [
      "ENOENT: no such file or directory, stat '/missing'",
      "ENOTDIR: not a directory, open '/tmp/file/child'",
      "Codex working directory is not a directory: /tmp/package.json",
      "Configured Codex binary is not executable: /tmp/codex",
    ]) {
      const recovery = recoveryForError(new Error(message));
      expect(recovery.recoverable).toBe(false);
      expect(recovery.reason).toBe("invalid_path");
    }
  });
});
