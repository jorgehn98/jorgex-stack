import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * RED: explicit default Claude mode must not leak CLAUDE_CONFIG_DIR to setup.
 *
 * When `process.env.CLAUDE_CONFIG_DIR` is defined but the coordinator is
 * explicitly given `isExplicitClaudeConfigDir:false` for the default
 * `<home>/.claude`, the env patch must carry an explicit deletion marker
 * (`CLAUDE_CONFIG_DIR` present with value `undefined`), and the real child
 * env built by `spawnOfficialSetupBin` must see it absent (never
 * `present:<inherited>` via `process.env`).
 *
 * Covers the closest seam as one chain: `resolveOfficialSetupEnv`
 * (must return the deletion marker) plus the real `spawnOfficialSetupBin`
 * env merge (a temp probe executable reports `absent`,
 * never `present:<inherited>`).
 * All fixtures live under `os.tmpdir()`; no personal HOME is touched and
 * the parent env is restored in `finally`.
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const leaked = process.env.CLAUDE_CONFIG_DIR;
  if (typeof leaked === "string" && leaked.includes(os.tmpdir())) {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function makeProbeBin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-claude-omit-probe-"));
  tempRoots.push(root);
  const bin = path.join(root, "probe-claude-env");
  fs.writeFileSync(
    bin,
    "#!/bin/sh\nif [ -z \"${CLAUDE_CONFIG_DIR+x}\" ]; then printf 'absent\\n'; else printf 'present:%s\\n' \"$CLAUDE_CONFIG_DIR\"; fi\nexit 0\n",
  );
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit not applicable.
  }
  return bin;
}

describe("[claude-omit] explicit default omits CLAUDE_CONFIG_DIR in child setup env", () => {
  it("resolve returns deletion marker and real spawn child reports absent despite inherited parent var", async () => {
    const home = tempHome("jx-claude-omit-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const inherited = path.join(home, "inherited-custom-claude");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = inherited;
    try {
      const mod = await import("../src/lib/official-engram-setup.js");
      const setupEnv = (mod.resolveOfficialSetupEnv as unknown as CallableFunction)(
        "claude-code",
        configDir,
        home,
        false,
      ) as Record<string, string | undefined>;
      expect("CLAUDE_CONFIG_DIR" in setupEnv).toBe(true);
      expect(setupEnv["CLAUDE_CONFIG_DIR"]).toBeUndefined();

      const probeBin = makeProbeBin();
      const result = await (mod.spawnOfficialSetupBin as unknown as CallableFunction)(
        probeBin,
        [],
        setupEnv,
      );
      expect(result.ok).toBe(true);
      expect(String(result.stdout).trim()).toBe("absent");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});
