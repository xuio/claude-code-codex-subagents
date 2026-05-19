#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const shouldPull = args.has("--pull");
const skipDeps = args.has("--skip-deps");
const noValidate = args.has("--no-validate");

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${[command, ...commandArgs].join(" ")}`);
  execFileSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}

function exists(target) {
  try {
    accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

if (shouldPull) {
  run("git", ["pull", "--ff-only"]);
}

if (!skipDeps && !exists(path.join(root, "node_modules"))) {
  run("npm", ["install"]);
} else if (skipDeps) {
  console.log("Skipping dependency install (--skip-deps).");
} else {
  console.log("Dependencies already installed; skipping npm install.");
}

run("npm", ["run", "build"]);
run("npm", ["run", "test:plugin-manifest"]);
run("npm", ["run", "dev:link"]);

if (!noValidate && commandExists("claude")) {
  run("npm", ["run", "validate:plugin"]);
} else if (noValidate) {
  console.log("Skipping Claude plugin validation (--no-validate).");
} else {
  console.log("Skipping Claude plugin validation because `claude` is not on PATH.");
}

console.log("\nLocal install/update complete.");
console.log("Start Claude Code with the installed plugin, or run: claude --plugin-dir .");
console.log("During development, keep dist fresh with: npm run dev:watch");

