import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup, restoreBackup } from "../src/lib/backup.js";

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

function tempHome(prefix: string): string {
  const root = tempDir(prefix);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

describe("[followup-1] restore count mismatch reports incomplete, preserves backupId", () => {
  it("fake bin deletes backup store → incomplete recovery with backupId", async () => {
    const home = tempHome("jx-follow1-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.toml"), 'model = "user/model"\n');
    // Fake engram bin: borra el store de backups y falla (spawn ok:false).
    const bin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nrm -rf "$HOME/.jorgex-stack/backups"/*/files/*\nexit 1\n`,
      { mode: 0o755 },
    );
    try {
      fs.chmodSync(bin, 0o755);
    } catch {
      // Windows: el bit de ejecución no aplica; el spawn fallará igual.
    }
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      await import("../src/adapters/codex.js");
      const mod = await import("../src/lib/official-engram-setup.js");
      const pathsMod = await import("../src/lib/paths.js");
      // Aislamiento: la raíz de backups efectiva debe vivir dentro del HOME del test.
      const effectiveBackupRoot = path.join(pathsMod.dataDir(), "backups");
      expect(path.resolve(effectiveBackupRoot).startsWith(path.resolve(home) + path.sep)).toBe(true);
      const result = await mod.runOfficialSetupIfNeeded("codex", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin: bin,
        configDir,
        homeDir: home,
      });
      expect(result.ran).toBe(true);
      if (result.ran) {
        expect(result.ok).toBe(false);
        expect(result.backupId).not.toBeNull();
        expect(result.backupId).not.toBeUndefined();
        const incomplete =
          (result as unknown as Record<string, unknown>).incompleteRecovery === true ||
          result.recovery === "incomplete";
        expect(incomplete).toBe(true);
      }
    } finally {
      homedirSpy.mockRestore();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      vi.resetModules();
    }
  });

  it("restoreBackup skips missing stored → count differs (unit)", async () => {
    const root = tempDir("jx-follow1-unit-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, "config.toml");
    fs.writeFileSync(file, "original\n");
    const backupRoot = path.join(root, "backups");
    const backup = createBackup([file], "follow1", backupRoot);
    expect(backup).not.toBeNull();
    const expected = backup!.files.length;
    expect(expected).toBe(1);
    // Simula skip silencioso: borra el stored.
    fs.rmSync(backup!.files[0]!.stored, { force: true });
    const restored = restoreBackup(backup!.id, backupRoot, home);
    expect(restored).toBe(0);
    expect(restored).not.toBe(expected);
  });
});

describe("[followup-2] marketplace dir: preexisting preserved, new descendants removed", () => {
  it("existing file restored, new file/dir removed on failure", async () => {
    const home = tempHome("jx-follow2-");
    const configDir = path.join(home, ".claude");
    const marketplace = path.join(configDir, "plugins", "marketplaces", "engram");
    fs.mkdirSync(path.join(marketplace, "hooks"), { recursive: true });
    const existing = path.join(marketplace, "existing.txt");
    const original = "preexisting\n";
    fs.writeFileSync(existing, original);
    fs.writeFileSync(path.join(configDir, "settings.json"), "{}\n");

    const mod = await import("../src/lib/official-engram-setup.js");
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;

    const expand = (files: string[]): string[] => {
      const out: string[] = [];
      for (const file of files) {
        try {
          if (fs.statSync(file).isDirectory()) {
            const walk = (dir: string): void => {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else out.push(full);
              }
            };
            walk(file);
            continue;
          }
        } catch {
          // ausente: se conserva el path para el gate de targets
        }
        out.push(file);
      }
      return out;
    };

    const targets = [marketplace, path.join(configDir, "settings.json")];
    const result = await mod.runOfficialSetup("claude-code", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets,
      backup: async () => {
        const backup = createBackup(expand(targets), "follow2", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        // Mutación parcial: modifica preexistente + crea nuevos dentro del dir existente.
        fs.writeFileSync(existing, "mutated\n");
        fs.writeFileSync(path.join(marketplace, "new-partial.txt"), "partial\n");
        const newDir = path.join(marketplace, "new-dir");
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(path.join(newDir, "nested.txt"), "nested\n");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: false, reason: "verify falló" }),
      restore: async () => {
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(existing, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(marketplace, "new-partial.txt"))).toBe(false);
    expect(fs.existsSync(path.join(marketplace, "new-dir"))).toBe(false);
    expect(fs.existsSync(marketplace)).toBe(true);
  });
});

describe("[followup-pi] Pi install real runs verified official setup (install-only)", () => {
  it("pi declares official path and runs on install real; gated modes skip; unknown still fails", async () => {
    const home = tempHome("jx-followpi-");
    const configDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(configDir, { recursive: true });
    const bin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    try {
      fs.chmodSync(bin, 0o755);
    } catch {
      // Windows: el bit de ejecución no aplica; el spawn fallará igual.
    }
    await import("../src/adapters/pi.js");
    const mod = await import("../src/lib/official-engram-setup.js");
    // Verified official Pi path (T41/T42 canonical: argv/env/targets/destination/verifier).
    expect(mod.resolveOfficialSetupArgv("pi")).toEqual(["setup", "pi"]);
    expect(mod.isOfficialSetupRuntime("pi")).toBe(true);
    expect(mod.resolveOfficialSetupEnv("pi", configDir)).toMatchObject({ PI_CODING_AGENT_DIR: configDir });
    expect(mod.validateOfficialSetupDestination("pi", configDir, home)).toBeNull();
    const targets = mod.collectOfficialSetupBackupTargets("pi", configDir, home) as string[];
    const joined = targets.join("\n");
    expect(joined).toMatch(/settings\.json/);
    expect(joined).toMatch(/mcp\.json/);
    expect(joined).not.toMatch(/engram\.db/);
    expect(joined).not.toMatch(/\.local\/bin\/engram/);
    expect(typeof mod.officialSetupVerifiers["pi"]).toBe("function");
    // Install-only: sync/dry-run/target-dir skip without running setup.
    for (const gated of [
      { command: "sync", dryRun: false, targetDir: undefined },
      { command: "install", dryRun: true, targetDir: undefined },
      { command: "install", dryRun: false, targetDir: path.join(home, "target") },
    ] as const) {
      const skipped = await mod.runOfficialSetupIfNeeded("pi", {
        ...gated,
        engramBin: bin,
        configDir,
        homeDir: home,
      });
      expect(skipped, `Pi debe omitir setup en ${gated.command}/dryRun=${gated.dryRun}`).toMatchObject({ ran: false });
    }
    // Install real runs official setup (T42: short-circuit eliminado); estado
    // vacío falla cerrado sin ownership (verify singleton + MCP ausentes).
    const pi = await mod.runOfficialSetupIfNeeded("pi", {
      command: "install",
      dryRun: false,
      targetDir: undefined,
      engramBin: bin,
      configDir,
      homeDir: home,
    });
    expect(pi.ran).toBe(true);
    if (pi.ran) {
      expect(pi.ok).toBe(false);
      expect(pi.ownershipTransferred ?? false).toBe(false);
    }
    // Failure guard preserved: arbitrary unknown still fails (never silent skip).
    const unknown = await mod.runOfficialSetupIfNeeded("unknown-rt-xyz", {
      command: "install",
      dryRun: false,
      targetDir: undefined,
      engramBin: bin,
      configDir,
      homeDir: home,
    });
    expect(unknown).not.toMatchObject({ ran: false });
    if (unknown.ran) expect(unknown.ok).toBe(false);
  });
});

describe("[followup-boundary] outside-HOME fails before backup mutation", () => {
  it("backup and spawn are not called", async () => {
    const root = tempDir("jx-followb-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside\n");
    const mod = await import("../src/lib/official-engram-setup.js");
    let backupCalls = 0;
    let spawnCalls = 0;
    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [outside],
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
    expect(result.recovery).toBe("none");
  });
});

describe("[followup-3] OpenCode honors XDG over OPENCODE_CONFIG_DIR", () => {
  it("env fija ambos al mismo configDir efectivo", async () => {
    const mod = await import("../src/lib/official-engram-setup.js");
    const configDir = path.join("/tmp", "home", ".config", "opencode");
    const env = mod.resolveOfficialSetupEnv("opencode", configDir);
    expect(env.OPENCODE_CONFIG_DIR).toBe(configDir);
    expect(env.XDG_CONFIG_HOME).toBe(path.dirname(configDir));
  });

  it("custom con basename distinto de opencode falla pre-spawn sin efectos", async () => {
    await import("../src/adapters/opencode.js");
    const mod = await import("../src/lib/official-engram-setup.js");
    const home = tempHome("jx-follow3-");
    const configDir = path.join(home, "custom-dir");
    fs.mkdirSync(configDir, { recursive: true });
    const bin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    const marker = path.join(configDir, "should-not-exist.txt");
    const result = await mod.runOfficialSetupIfNeeded("opencode", {
      command: "install",
      dryRun: false,
      targetDir: undefined,
      engramBin: bin,
      configDir,
      homeDir: home,
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.ok).toBe(false);
      expect(String(result.reason ?? result.stderr ?? "")).toMatch(/opencode/i);
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});
