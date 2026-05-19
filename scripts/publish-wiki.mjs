#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wikiSource = path.join(root, "docs", "wiki");
const remote = process.env.CODEX_SUBAGENTS_WIKI_REMOTE ??
  "git@github.com:xuio/claude-code-codex-subagents.wiki.git";
const tempParent = mkdtempSync(path.join(os.tmpdir(), "codex-subagents-wiki-"));
const temp = path.join(tempParent, "wiki");

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  return execFileSync(command, args, {
    cwd: options.cwd ?? temp,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
  });
}

function tryRun(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    cwd: options.cwd ?? temp,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
  });
}

try {
  if (!existsSync(wikiSource)) {
    throw new Error(`Missing wiki source directory: ${wikiSource}`);
  }

  const clone = tryRun("git", ["clone", remote, temp], { cwd: root });
  if (clone.status !== 0) {
    console.log("Wiki git remote is not initialized yet; creating a first local wiki commit.");
    mkdirSync(temp, { recursive: true });
    run("git", ["init", "-b", "master"]);
    run("git", ["remote", "add", "origin", remote]);
  }

  for (const file of readdirSync(wikiSource)) {
    if (file.endsWith(".md")) {
      cpSync(path.join(wikiSource, file), path.join(temp, file));
    }
  }

  run("git", ["add", "."]);
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: temp,
    stdio: "ignore",
  });
  if (diff.status === 0) {
    console.log("Wiki already up to date.");
  } else {
    run("git", ["commit", "-m", "Update onboarding wiki"]);
    const push = tryRun("git", ["push", "-u", "origin", "master"]);
    if (push.status !== 0) {
      throw new Error(
        "GitHub rejected the wiki push. If it says `Repository not found`, create any first wiki page in the GitHub UI, then rerun `npm run wiki:publish`.",
      );
    }
    console.log("Wiki published.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  rmSync(tempParent, { recursive: true, force: true });
}
