import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RED net for the three final symlink findings (no production change).
 * Each test must FAIL now for the intended behavioral reason.
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// 1) Post-spawn symlink with verify ok must not return ok.
// ---------------------------------------------------------------------------

describe("[final-1] spawn creates symlink to valid outside content with verify ok must not succeed", () => {
  it("preexisting replaced by symlink to valid outside file + verify ok → ok false, incomplete, outside untouched", async () => {
    const root = tempDir("jx-final1-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "victim.txt");
    fs.writeFileSync(outsideFile, "outside-original\n");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const preexisting = path.join(configDir, "config.toml");
    fs.writeFileSync(preexisting, "original\n");

    const mod = await import("../src/lib/official-engram-setup.js");
    const { createBackup } = await import("../src/lib/backup.js");
    const backupRoot = path.join(root, "backups");
    let backupId: string | null = null;

    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [preexisting],
      backup: async () => {
        const backup = createBackup([preexisting], "final1", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        // Faulty/malicious setup replaces the target with a symlink to valid
        // outside content.
        fs.rmSync(preexisting, { force: true });
        fs.symlinkSync(outsideFile, preexisting);
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: true }),
      restore: async () => {
        const { restoreBackup } = await import("../src/lib/backup.js");
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });

    // Post-spawn symlink check must participate before success: this run
    // planted an alias yet verify says ok, so it must not report success.
    expect(result.ok).toBe(false);
    // Recovery cannot write through the link, so it must be incomplete.
    const incomplete =
      (result as unknown as Record<string, unknown>).incompleteRecovery === true ||
      result.recovery === "incomplete";
    expect(incomplete).toBe(true);
    // The outside file must survive untouched.
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside-original\n");
  });
});

// ---------------------------------------------------------------------------
// 2a) runOfficialSetup: missing intermediate under ancestor symlink.
// ---------------------------------------------------------------------------

describe("[final-2a] runOfficialSetup rejects missing intermediate under ancestor symlink before backup/spawn", () => {
  it("plugins ancestor is a symlink, target has missing intermediate dir → blocked with 0 backup/spawn calls", async () => {
    const root = tempDir("jx-final2a-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside-real");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "keep.txt"), "keep\n");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const ancestor = path.join(configDir, "plugins");
    fs.symlinkSync(outsideDir, ancestor);
    // Intermediate `missing-dir` does not exist; the existing ancestor above
    // it is a symlink to outside. The scan must continue past ENOENT.
    const target = path.join(ancestor, "missing-dir", "config.toml");
    expect(fs.existsSync(path.dirname(target))).toBe(false);

    const mod = await import("../src/lib/official-engram-setup.js");
    let backupCalls = 0;
    let spawnCalls = 0;
    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [target],
      backup: async () => {
        backupCalls++;
        return { id: "should-not-happen" };
      },
      spawn: async () => {
        spawnCalls++;
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: true }),
    });

    expect(result.ok).toBe(false);
    expect(backupCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(fs.readFileSync(path.join(outsideDir, "keep.txt"), "utf8")).toBe("keep\n");
  });
});

// ---------------------------------------------------------------------------
// 2b) restoreBackup: missing intermediate under ancestor symlink.
// ---------------------------------------------------------------------------

describe("[final-2b] restoreBackup skips missing intermediate under ancestor symlink instead of writing through", () => {
  it("manifest original under symlinked ancestor with missing intermediate → restored 0, outside not polluted", async () => {
    const root = tempDir("jx-final2b-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside-real");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "keep.txt"), "keep\n");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const ancestor = path.join(configDir, "plugins");
    fs.symlinkSync(outsideDir, ancestor);
    const taintedOriginal = path.join(ancestor, "missing-dir", "restored.txt");
    expect(fs.existsSync(path.dirname(taintedOriginal))).toBe(false);

    const { createBackup, restoreBackup } = await import("../src/lib/backup.js");
    const seed = path.join(home, "seed.txt");
    fs.writeFileSync(seed, "original-content\n");
    const backupRoot = path.join(root, "backups");
    const backup = createBackup([seed], "final2b", backupRoot);
    expect(backup).not.toBeNull();
    // Point the manifest entry at the tainted path; the stored copy stays.
    const manifestPath = path.join(backupRoot, backup!.id, "manifest.json");
    const info = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      files: Array<{ original: string; stored: string }>;
    };
    info.files[0]!.original = taintedOriginal;
    fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2) + "\n");

    const restored = restoreBackup(backup!.id, backupRoot, home);

    // The ancestor scan must continue past the ENOENT on `missing-dir` and
    // find the symlinked `plugins` ancestor, skipping instead of writing
    // through it into outside.
    expect(restored).toBe(0);
    expect(fs.existsSync(path.join(outsideDir, "missing-dir", "restored.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3) Public CLI restore reports incomplete failure on safety skips.
// ---------------------------------------------------------------------------

describe("[final-3] CLI restore reports incomplete failure when safety skips restore fewer files than manifest", () => {
  it("restore <id> with one symlink-skipped file → exit 1 with incomplete report, not bare success", async () => {
    const root = tempDir("jx-final3-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "outside-original\n");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalArgv = [...process.argv];
    const originalExitCode = process.exitCode;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.exitCode = undefined;
    vi.resetModules();
    try {
      const { createBackup, listBackups } = await import("../src/lib/backup.js");
      const configDir = path.join(home, ".codex");
      fs.mkdirSync(configDir, { recursive: true });
      const fileA = path.join(configDir, "config-a.toml");
      const fileB = path.join(configDir, "config-b.toml");
      fs.writeFileSync(fileA, "a-original\n");
      fs.writeFileSync(fileB, "b-original\n");
      const backup = createBackup([fileA, fileB], "final3");
      expect(backup).not.toBeNull();
      expect(listBackups().find((b) => b.id === backup!.id)?.files.length).toBe(2);
      // Safety skip: fileB becomes a symlink to valid outside content, so the
      // real restoreBackup restores 1/2.
      fs.rmSync(fileB, { force: true });
      fs.symlinkSync(outsideFile, fileB);

      const logs: string[] = [];
      const errors: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
      const ROOT = path.dirname(fileURLToPath(import.meta.url));
      const CLI_PATH = path.join(ROOT, "..", "src", "cli.ts");
      process.argv = [process.execPath, CLI_PATH, "restore", backup!.id];
      process.exitCode = undefined;
      try {
        await import("../src/cli.js");
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      const observedExit = process.exitCode;
      const combined = [...logs, ...errors].join("\n");

      // Incomplete restore must fail the command and say so; a bare
      // "Restaurados 1 archivos." success is the bug.
      expect(observedExit).toBe(1);
      expect(combined).toMatch(/incomplet/i);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside-original\n");
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      vi.resetModules();
    }
  });
});
