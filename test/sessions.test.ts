import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionManager } from "../src/sessions.js";

const fakeCodex = path.resolve("test/fixtures/fake-codex.mjs");
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function recordedCalls(recordDir: string): Promise<Array<{ args: string[]; cwd: string; prompt: string }>> {
  return (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CodexSessionManager", () => {
  it("preserves the session project directory when follow-up prompts omit overrides", async () => {
    const manager = new CodexSessionManager();
    const projectDir = await tempDir("codex-subagents-session-project-");
    const recordDir = await tempDir("codex-subagents-session-record-");

    const started = await manager.start({
      prompt: "session first",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(started.result.ok).toBe(true);
    expect(started.session.projectDir).toBe(projectDir);
    expect(started.session.codexThreadId).toMatch(/^fake-/);

    const followUp = await manager.send(started.session.id, "session second");

    expect(followUp.error).toBeUndefined();
    expect(followUp.result?.ok).toBe(true);
    expect(followUp.result?.cwd).toBe(projectDir);
    expect(followUp.session?.projectDir).toBe(projectDir);

    const calls = await recordedCalls(recordDir);
    expect(calls).toHaveLength(2);
    const [initialCall, followUpCall] = calls as [
      { args: string[]; cwd: string; prompt: string },
      { args: string[]; cwd: string; prompt: string },
    ];
    expect(initialCall.cwd).toBe(projectDir);
    expect(followUpCall.cwd).toBe(projectDir);
    expect(followUpCall.args).toContain("resume");
    expect(followUpCall.args).toContain(started.session.codexThreadId);
  });
});
