import { describe, expect, it } from "vitest";
import { cleanOption, desktopCodexCandidates, resolveCodexBinary } from "../src/binary.js";

describe("resolveCodexBinary", () => {
  it("prefers the Codex desktop app binary over CODEX_BIN and PATH by default", () => {
    const executable = new Set([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/custom/codex",
      "/bin/codex",
    ]);

    const result = resolveCodexBinary({
      env: {
        CODEX_BIN: "/custom/codex",
        PATH: "/bin",
      },
      platform: "darwin",
      homedir: "/Users/tester",
      existsExecutable: (candidate) => executable.has(candidate),
    });

    expect(result).toEqual({
      path: "/Applications/Codex.app/Contents/Resources/codex",
      source: "desktop-app",
    });
  });

  it("allows a per-call explicit binary to override the desktop app binary", () => {
    const executable = new Set([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/tmp/fake-codex",
    ]);

    const result = resolveCodexBinary({
      explicitPath: "/tmp/fake-codex",
      env: {},
      platform: "darwin",
      existsExecutable: (candidate) => executable.has(candidate),
    });

    expect(result).toEqual({
      path: "/tmp/fake-codex",
      source: "explicit",
    });
  });

  it("allows plugin configuration to override the desktop app binary", () => {
    const executable = new Set([
      "/Applications/Codex.app/Contents/Resources/codex",
      "/configured/codex",
    ]);

    const result = resolveCodexBinary({
      env: {
        CODEX_SUBAGENTS_CODEX_BIN: "/configured/codex",
      },
      platform: "darwin",
      existsExecutable: (candidate) => executable.has(candidate),
    });

    expect(result).toEqual({
      path: "/configured/codex",
      source: "plugin-config",
    });
  });

  it("ignores unresolved Claude user_config placeholders", () => {
    expect(cleanOption("${user_config.codex_bin}")).toBeUndefined();
  });

  it("falls back to PATH when desktop and configured binaries are unavailable", () => {
    const result = resolveCodexBinary({
      env: {
        PATH: "/usr/local/bin",
      },
      platform: "linux",
      existsExecutable: (candidate) => candidate === "/usr/local/bin/codex",
    });

    expect(result).toEqual({
      path: "/usr/local/bin/codex",
      source: "PATH",
    });
  });

  it("throws a clear error for an invalid explicit binary", () => {
    expect(() =>
      resolveCodexBinary({
        explicitPath: "/missing/codex",
        env: {},
        platform: "darwin",
        existsExecutable: () => false,
      }),
    ).toThrow("Configured Codex binary is not executable: /missing/codex");
  });

  it("builds macOS desktop candidates from the standard app locations", () => {
    expect(desktopCodexCandidates({}, "darwin", "/Users/tester")).toContain(
      "/Applications/Codex.app/Contents/Resources/codex",
    );
    expect(desktopCodexCandidates({}, "darwin", "/Users/tester")).toContain(
      "/Users/tester/Applications/Codex.app/Contents/Resources/codex",
    );
  });
});
