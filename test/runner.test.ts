import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexExecArgs,
  resolveWorkingDirectory,
  runAgent,
  runAgents,
} from "../src/runner.js";

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

describe("buildCodexExecArgs", () => {
  it("defaults to read-only, non-interactive approvals, fast tier, and stdin prompt input", () => {
    const args = buildCodexExecArgs({ cwd: "/repo" }, "/tmp/out.md", {});

    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('service_tier="fast"');
    expect(args).toContain("--cd");
    expect(args[args.indexOf("--cd") + 1]).toBe("/repo");
    expect(args.at(-1)).toBe("-");
  });

  it("applies explicit model and reasoning settings", () => {
    const args = buildCodexExecArgs(
      {
        cwd: "/repo",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "flex",
        modelVerbosity: "low",
        reasoningSummary: "concise",
      },
      "/tmp/out.md",
      {},
    );

    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.4");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('service_tier="flex"');
    expect(args).toContain('model_verbosity="low"');
    expect(args).toContain('model_reasoning_summary="concise"');
  });

  it("maps model presets and subagent runtime options into Codex exec args", () => {
    const args = buildCodexExecArgs(
      {
        cwd: "/repo",
        modelPreset: "spark",
        subagentRuntime: {
          maxThreads: 8,
          maxDepth: 2,
          jobMaxRuntimeSeconds: 900,
        },
      },
      "/tmp/out.md",
      {},
    );

    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.3-codex-spark");
    expect(args).toContain("agents.max_threads=8");
    expect(args).toContain("agents.max_depth=2");
    expect(args).toContain("agents.job_max_runtime_seconds=900");
  });
});

describe("resolveWorkingDirectory", () => {
  it("prefers CLAUDE_PROJECT_DIR when no project_dir or cwd is passed", async () => {
    const dir = await tempDir("codex-subagents-project-");
    const previous = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      await expect(resolveWorkingDirectory()).resolves.toBe(dir);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    }
  });
});

describe("runAgent", () => {
  it("runs fake Codex in the requested project_dir and captures the final message", async () => {
    const projectDir = await tempDir("codex-subagents-repo-");
    const recordDir = await tempDir("codex-subagents-record-");

    const result = await runAgent({
      prompt: "inspect the repository RUN_COMMAND_EVENT",
      projectDir,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.sandbox).toBe("read-only");
    expect(result.cwd).toBe(projectDir);
    expect(result.codexBinary.source).toBe("explicit");
    expect(result.finalMessage).toContain("inspect the repository");
    expect(result.eventSummary.threadId).toMatch(/^fake-/);
    expect(result.eventSummary.commands).toEqual([
      { command: "rg example", status: "completed" },
    ]);

    const calls = (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(projectDir);
    expect(calls[0].args).toContain("--sandbox");
    expect(calls[0].args[calls[0].args.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("materializes custom Codex subagents in a temporary Codex home", async () => {
    const projectDir = await tempDir("codex-subagents-repo-");
    const recordDir = await tempDir("codex-subagents-record-");

    const result = await runAgent({
      prompt: "coordinate nested work",
      projectDir,
      codexBin: fakeCodex,
      modelPreset: "spark",
      codexSubagents: [
        {
          name: "ui_spark",
          description: "Fast focused UI iteration.",
          developerInstructions: "Stay scoped and concise.",
          modelPreset: "spark",
          reasoningEffort: "medium",
          sandbox: "read-only",
        },
      ],
      subagentTasks: [{ agent: "ui_spark", prompt: "Inspect the toolbar." }],
      subagentRuntime: { maxThreads: 4, maxDepth: 2 },
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe("gpt-5.3-codex-spark");
    expect(result.codexSubagents).toEqual({
      customAgents: ["ui_spark"],
      requestedTasks: 1,
      tempCodexHomeUsed: true,
    });

    const calls = (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0].prompt).toContain("Custom agents available: ui_spark");
    expect(calls[0].prompt).toContain("Spawn ui_spark: Inspect the toolbar.");
    expect(calls[0].args[calls[0].args.indexOf("--model") + 1]).toBe("gpt-5.3-codex-spark");
    expect(calls[0].args).toContain("agents.max_threads=4");
    expect(calls[0].args).toContain('agents.ui_spark.description="Fast focused UI iteration."');
    expect(calls[0].args).toContain(
      'agents.ui_spark.developer_instructions="Stay scoped and concise."',
    );
    expect(calls[0].args).toContain('agents.ui_spark.model="gpt-5.3-codex-spark"');
    expect(Object.values(calls[0].agentFiles).join("\n")).toContain(
      'model = "gpt-5.3-codex-spark"',
    );
    expect(Object.values(calls[0].agentFiles).join("\n")).toContain('name = "ui_spark"');
    await expect(stat(calls[0].codexHome)).rejects.toThrow();
  });

  it("returns failed status for non-zero Codex exits", async () => {
    const projectDir = await tempDir("codex-subagents-repo-");
    const result = await runAgent({
      prompt: "EXIT_7",
      projectDir,
      codexBin: fakeCodex,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("requested failure");
  });

  it("times out long-running Codex processes", async () => {
    const projectDir = await tempDir("codex-subagents-repo-");
    const result = await runAgent({
      prompt: "DELAY_MS=200",
      projectDir,
      codexBin: fakeCodex,
      timeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
  });
});

describe("runAgents", () => {
  it("runs multiple fake Codex agents in parallel with the requested project_dir", async () => {
    const projectDir = await tempDir("codex-subagents-repo-");
    const recordDir = await tempDir("codex-subagents-record-");
    const results = await runAgents({
      agents: [
        { name: "one", prompt: "agent one DELAY_MS=100", projectDir },
        { name: "two", prompt: "agent two DELAY_MS=100", projectDir },
      ],
      maxParallel: 2,
      codexBin: fakeCodex,
      env: {
        FAKE_CODEX_RECORD_DIR: recordDir,
      },
    });

    expect(results.map((result) => result.name)).toEqual(["one", "two"]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.every((result) => result.cwd === projectDir)).toBe(true);

    const calls = (await readFile(path.join(recordDir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.cwd === projectDir)).toBe(true);
    expect(Math.max(...calls.map((call) => call.at)) - Math.min(...calls.map((call) => call.at))).toBeLessThan(150);
  });
});
