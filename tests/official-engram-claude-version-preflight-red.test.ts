import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * RED version-preflight contract for Claude official setup (masking risk).
 *
 * Real diagnosis (Claude 2.1.267):
 * - Engram 1.20.0 / 2.0.0-rc.11 write the obsolete `<config>/mcp/engram.json`,
 *   which the CLI ignores (`claude mcp list` shows none).
 * - Engram 2.0.0 writes the exact MCP in the effective location (default
 *   sibling `$HOME/.claude.json`, custom nested `$CLAUDE_CONFIG_DIR/.claude.json`).
 * - Stack `planMainConfig` writes/retains an exact legacy MCP in the same
 *   sibling/nested file BEFORE the provider setup runs, so a final-filesystem
 *   verifier alone cannot prove the provider (1.20.0 / rc) registered it.
 *   The failure is masked as success.
 *
 * Required contract (no network/download, binary untouched):
 * - `runOfficialSetupIfNeeded("claude-code", { ..., engramVersion })` must
 *   reject `1.20.0` and `2.0.0-rc.11` BEFORE backup/spawn with an actionable
 *   reason to update to 2.0.0+ (mentions `update` + `2.0.0` + existing version).
 * - Stable `2.0.0` must pass through to setup (verifier runs).
 * - The existing binary file must remain byte-identical (never auto-replaced).
 * - Codex/OpenCode are provider-managed: the same old versions must NOT be
 *   version-blocked there unless a diagnosis supports it (controls below).
 *
 * Current `runOfficialSetupIfNeeded` accepts no `engramVersion` and performs
 * no Claude version gate, so the two rejection cases below must FAIL now for
 * the intended behavioral reason (setup proceeds instead of rejecting).
 * The `2.0.0` and Codex/OpenCode controls lock the non-blocking contract and
 * must keep passing after GREEN.
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

const FAKE_BIN_SCRIPT = "#!/bin/sh\nexit 0\n";

function seedFakeBin(home: string): string {
  const bin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, FAKE_BIN_SCRIPT);
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit not applicable; spawn still attempted via execFileSync.
  }
  return bin;
}

async function withCountingVerifier<T>(
  runtime: "claude-code" | "codex" | "opencode",
  run: (count: { calls: number }) => Promise<T>,
): Promise<T> {
  const setup = await import("../src/lib/official-engram-setup.js");
  // Ensure the real adapters registered their verifiers first.
  await import("../src/adapters/claude-code.js");
  await import("../src/adapters/codex.js");
  await import("../src/adapters/opencode.js");
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

function versionDetail(result: unknown): string {
  const rec = result as Record<string, unknown>;
  return String((rec["reason"] ?? rec["stderr"] ?? "") as unknown);
}

describe("[claude-version-preflight] legacy Engram is rejected before setup", () => {
  it("1.20.0 is rejected before backup/spawn with actionable update-to-2.0.0+ reason, binary untouched", async () => {
    const home = tempHome("jx-claude-ver-120-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const engramBin = seedFakeBin(home);
    const before = fs.readFileSync(engramBin, "utf8");

    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as any)("claude-code", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin,
        configDir,
        homeDir: home,
        engramVersion: "1.20.0",
      })) as Record<string, unknown>;

      // Must be an explicit version failure, not a silent skip nor success.
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      // Blocked before any mutation: same shape as existing pre-backup blocks.
      expect(result["backupId"] ?? null).toBeNull();
      expect(result["recovery"] ?? "none").toBe("none");
      // Actionable: tells the user to update to 2.0.0+ and names the culprit.
      const detail = versionDetail(result);
      expect(detail).toMatch(/update/i);
      expect(detail).toMatch(/2\.0\.0/);
      expect(detail).toMatch(/1\.20\.0/);
      // Never reached backup/spawn/verify: verifier must not have run.
      expect(count.calls).toBe(0);
      // Existing binary is never auto-replaced.
      expect(fs.readFileSync(engramBin, "utf8")).toBe(before);
    });
  });

  it("2.0.0-rc.11 is rejected before backup/spawn with actionable update-to-2.0.0+ reason, binary untouched", async () => {
    const home = tempHome("jx-claude-ver-rc-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const engramBin = seedFakeBin(home);
    const before = fs.readFileSync(engramBin, "utf8");

    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as any)("claude-code", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin,
        configDir,
        homeDir: home,
        engramVersion: "2.0.0-rc.11",
      })) as Record<string, unknown>;

      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      expect(result["recovery"] ?? "none").toBe("none");
      const detail = versionDetail(result);
      expect(detail).toMatch(/update/i);
      expect(detail).toMatch(/2\.0\.0/);
      expect(detail).toMatch(/2\.0\.0-rc\.11/);
      expect(count.calls).toBe(0);
      expect(fs.readFileSync(engramBin, "utf8")).toBe(before);
    });
  });
});

describe("[claude-version-preflight] stable 2.0.0 passes through to setup", () => {
  it("control: 2.0.0 reaches the verifier (not version-blocked)", async () => {
    const home = tempHome("jx-claude-ver-200-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const engramBin = seedFakeBin(home);

    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as any)("claude-code", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin,
        configDir,
        homeDir: home,
        engramVersion: "2.0.0",
      })) as Record<string, unknown>;

      // Pass-through: the stub verifier ran, so the version gate did not block.
      expect(count.calls).toBe(1);
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(true);
    });
  });
});

describe("[claude-version-preflight] provider-managed runtimes are not version-blocked", () => {
  it("control: codex with 1.20.0 still reaches setup (no Claude gate)", async () => {
    const home = tempHome("jx-codex-ver-120-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const engramBin = seedFakeBin(home);

    await withCountingVerifier("codex", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as any)("codex", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin,
        configDir,
        homeDir: home,
        engramVersion: "1.20.0",
      })) as Record<string, unknown>;

      expect(count.calls).toBe(1);
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(true);
    });
  });

  it("control: opencode with 1.20.0 still reaches setup (no Claude gate)", async () => {
    const home = tempHome("jx-opencode-ver-120-");
    const configDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const engramBin = seedFakeBin(home);

    await withCountingVerifier("opencode", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as any)("opencode", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin,
        configDir,
        homeDir: home,
        engramVersion: "1.20.0",
      })) as Record<string, unknown>;

      expect(count.calls).toBe(1);
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(true);
    });
  });
});
