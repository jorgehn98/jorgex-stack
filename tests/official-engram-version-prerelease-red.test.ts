import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engramVersion } from "../src/lib/detect.js";

/**
 * RED: shared `engramVersion(bin)` strips the prerelease suffix, masking the
 * Claude preflight through the actual install wiring.
 *
 * Real shape: `engram --version` prints `engram 2.0.0-rc.11`. The shared
 * helper in `src/lib/detect.ts` matches only `(\d+\.\d+\.\d+)`, so it returns
 * `2.0.0`. That stable-looking value passes
 * `isClaudeEngramVersionSupported` and `runOfficialSetupIfNeeded("claude-code")`
 * proceeds to backup/spawn instead of rejecting before mutation with an
 * actionable update-to-2.0.0+ reason. Stable `engram 2.0.0` must keep parsing
 * to `2.0.0` and passing through (control).
 *
 * Seam: executable temp script (real `runDetectedBin` spawn, no mocks, no
 * personal dirs, no network). The prerelease case must FAIL now with
 * `expected '2.0.0' to be '2.0.0-rc.11'` (suffix stripped); the stable control
 * must keep passing.
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeVersionBin(output: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-engram-version-"));
  tempRoots.push(root);
  const bin = path.join(root, "engram");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

async function withCountingVerifier<T>(
  runtime: "claude-code",
  run: (count: { calls: number }) => Promise<T>,
): Promise<T> {
  const setup = await import("../src/lib/official-engram-setup.js");
  await import("../src/adapters/claude-code.js");
  const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
  const original = verifiers[runtime];
  const count = { calls: 0 };
  verifiers[runtime] = async () => {
    count.calls++;
    return { ok: true, layers: ["plugin", "mcp", "hooks"] };
  };
  try {
    return await run(count);
  } finally {
    if (original === undefined) delete verifiers[runtime];
    else verifiers[runtime] = original;
  }
}

describe("[engram-version-prerelease] shared helper preserves suffix so Claude preflight rejects", () => {
  it("engram 2.0.0-rc.11 parses to 2.0.0-rc.11 and Claude install wiring rejects before setup", async () => {
    const bin = makeVersionBin("engram 2.0.0-rc.11");

    // Core contract: prerelease suffix is preserved, not stripped to stable.
    const version = engramVersion(bin);
    expect(version).toBe("2.0.0-rc.11");

    // Through the actual install wiring: the preserved value is unsupported
    // and the Claude preflight rejects before backup/spawn.
    const { isClaudeEngramVersionSupported, runOfficialSetupIfNeeded } = await import(
      "../src/lib/official-engram-setup.js"
    );
    expect(isClaudeEngramVersionSupported(version ?? "")).toBe(false);

    const home = tempHome("jx-engram-ver-rc-wire-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const before = fs.readFileSync(bin, "utf8");
    await withCountingVerifier("claude-code", async (count) => {
      const result = (await (runOfficialSetupIfNeeded as any)("claude-code", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin: bin,
        configDir,
        homeDir: home,
        engramVersion: version,
      })) as Record<string, unknown>;
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      const detail = String((result["reason"] ?? result["stderr"] ?? "") as unknown);
      expect(detail).toMatch(/update/i);
      expect(detail).toMatch(/2\.0\.0/);
      expect(detail).toMatch(/2\.0\.0-rc\.11/);
      expect(count.calls).toBe(0);
      expect(fs.readFileSync(bin, "utf8")).toBe(before);
    });
  });
});

describe("[engram-version-prerelease] stable output control", () => {
  it("control: engram 2.0.0 still parses to 2.0.0", () => {
    const bin = makeVersionBin("engram 2.0.0");
    expect(engramVersion(bin)).toBe("2.0.0");
  });
});
