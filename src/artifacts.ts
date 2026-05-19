import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSensitiveText } from "./redaction.js";

export interface OutputArtifacts {
  directory: string;
  finalMessagePath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  redacted: boolean;
  retained: boolean;
}

function artifactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_SUBAGENTS_OUTPUT_ARTIFACTS !== "0";
}

function keepAllArtifacts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_SUBAGENTS_KEEP_OUTPUT_ARTIFACTS === "1";
}

function redactArtifacts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_SUBAGENTS_ARTIFACT_REDACT !== "0";
}

function artifactBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CODEX_SUBAGENTS_ARTIFACT_DIR?.trim() || path.join(os.tmpdir(), "codex-subagents-artifacts"));
}

function safeText(text: string, redacted: boolean): string {
  return redacted ? redactSensitiveText(text) : text;
}

export class OutputArtifactWriter {
  private readonly enabled: boolean;
  private readonly redacted: boolean;
  private dir: string | undefined;
  private finished = false;
  private retained = false;
  private stdoutTouched = false;
  private stderrTouched = false;
  private finalTouched = false;

  constructor(
    private readonly label: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.enabled = artifactsEnabled(env);
    this.redacted = redactArtifacts(env);
  }

  appendStdout(chunk: string): void {
    this.append("stdout.txt", chunk);
    if (chunk.length > 0) this.stdoutTouched = true;
  }

  appendStderr(chunk: string): void {
    this.append("stderr.txt", chunk);
    if (chunk.length > 0) this.stderrTouched = true;
  }

  finish(input: {
    finalMessage: string;
    keep: boolean;
  }): OutputArtifacts | undefined {
    if (!this.enabled || this.finished) return undefined;
    this.finished = true;
    if (input.finalMessage.length > 0) {
      this.ensureDir();
      writeFileSync(this.pathFor("final-message.md"), safeText(input.finalMessage, this.redacted), "utf8");
      this.finalTouched = true;
    }

    const retain = input.keep || keepAllArtifacts(this.env);
    if (!retain) {
      this.discard();
      return undefined;
    }

    const dir = this.dir;
    if (!dir) return undefined;
    this.retained = true;
    return {
      directory: dir,
      finalMessagePath: this.finalTouched ? this.pathFor("final-message.md") : undefined,
      stdoutPath: this.stdoutTouched ? this.pathFor("stdout.txt") : undefined,
      stderrPath: this.stderrTouched ? this.pathFor("stderr.txt") : undefined,
      redacted: this.redacted,
      retained: true,
    };
  }

  discard(): void {
    if (this.retained) return;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }

  private append(file: string, chunk: string): void {
    if (!this.enabled || this.finished || chunk.length === 0) return;
    this.ensureDir();
    appendFileSync(this.pathFor(file), safeText(chunk, this.redacted), "utf8");
  }

  private ensureDir(): void {
    if (this.dir) return;
    const base = artifactBaseDir(this.env);
    mkdirSync(base, { recursive: true });
    this.dir = mkdtempSync(path.join(base, `${this.label.replace(/[^a-zA-Z0-9_.-]/g, "_")}-`));
  }

  private pathFor(file: string): string {
    if (!this.dir) throw new Error("Output artifact directory was not initialized.");
    return path.join(this.dir, file);
  }
}

export function outputArtifactDiagnostics(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  return {
    enabled: artifactsEnabled(env),
    directory: artifactBaseDir(env),
    redacted: redactArtifacts(env),
    keepAll: keepAllArtifacts(env),
  };
}
