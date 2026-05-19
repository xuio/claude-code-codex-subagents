import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackpressureError, CodexJobManager } from "../src/jobs.js";

const fakeCodex = path.resolve("test/fixtures/fake-codex.mjs");
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CodexJobManager", () => {
  it("rejects new async jobs when the retained job table is full", async () => {
    const manager = new CodexJobManager(1);
    const projectDir = await tempDir("codex-subagents-job-project-");

    const first = manager.startAgent({
      prompt: "DELAY_MS=200",
      projectDir,
      codexBin: fakeCodex,
    });

    expect(first.id).toMatch(/^job-/);
    expect(() =>
      manager.startAgent({
        prompt: "second",
        projectDir,
        codexBin: fakeCodex,
      }),
    ).toThrow(BackpressureError);

    manager.cancelAll("test_cleanup");
  });
});
