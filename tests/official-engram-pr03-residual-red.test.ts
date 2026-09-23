import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_CODE_TEST_MODELS } from "./fixtures/model-map.js";

const mocks = vi.hoisted(() => ({
  modelMapOverride: undefined as undefined | Record<string, unknown>,
  detectEngram: vi.fn(),
  runDetectedBin: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
    },
  },
}));

vi.mock("@clack/prompts", () => ({
  intro: mocks.prompts.intro,
  outro: mocks.prompts.outro,
  log: mocks.prompts.log,
}));

vi.mock("../src/lib/model-map.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
  return {
    ...actual,
    loadModelMap: () => mocks.modelMapOverride ?? actual.loadModelMap(),
  };
});

vi.mock("../src/lib/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/detect.js")>("../src/lib/detect.js");
  return {
    ...actual,
    detectEngram: mocks.detectEngram,
    runDetectedBin: mocks.runDetectedBin,
  };
});

const tempRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  mocks.modelMapOverride = undefined;
  mocks.detectEngram.mockReset();
  mocks.runDetectedBin.mockReset();
  try {
    vi.restoreAllMocks();
  } catch {
    // no spies
  }
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

async function withTempHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    vi.resetModules();
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

const REAL_OFFICIAL_OPENCODE_TS = [
  "// official engram setup opencode (same path, real markers)",
  "const url = CONFIGURED_ENGRAM_URL;",
  "async function ensureLocalReady() { return true; }",
  "const tools = SESSION_ATTRIBUTED_WRITE_TOOLS;",
  "function canonicalEngramToolName() { return 'engram'; }",
  "const id = localInstanceID;",
  "",
].join("\n");

function seedOpencodeExact(home: string, pluginContent: string, engramBin: string): string {
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "plugins", "engram.ts"), pluginContent);
  fs.writeFileSync(
    path.join(configDir, "opencode.json"),
    JSON.stringify({
      mcp: { engram: { type: "local", command: [engramBin, "mcp", "--tools=agent"] } },
      statusline: { command: "engram statusline" },
    }),
  );
  return configDir;
}

// ---------------------------------------------------------------------------
// 1) Orphan manifest ownership via runInstall
// ---------------------------------------------------------------------------

describe("[residual-1a] official setup failure keeps all undeleted orphans tracked", () => {
  it("failed official setup leaves both orphans in manifest (runInstall seam)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-res1a-"));
    const homeDir = path.join(tmp, "home");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
        const absBin = path.join(homeDir, ".local", "bin", "engram");
        mocks.detectEngram.mockReturnValue(absBin);
        mocks.runDetectedBin.mockReturnValue("1.20.0");

        const configDir = path.join(homeDir, ".config", "opencode");
        fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
        // Incomplete official setup: no plugin/MCP/statusline, so verify fails.
        fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ mcp: {} }));

        const orphan1 = path.join(configDir, "orphan-keep-1.txt");
        const orphan2 = path.join(configDir, "orphan-keep-2.txt");
        fs.writeFileSync(orphan1, "orphan1\n");
        fs.writeFileSync(orphan2, "orphan2\n");

        const { writeRuntimeManifest, readManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir, owned: [orphan1, orphan2], updatedAt: "seed" });

        const install = await import("../src/install.js");
        const opencode = install.ADAPTERS.opencode!;
        const codex = install.ADAPTERS.codex!;
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const o = opencode.detect;
        const c = codex.detect;
        const cc = claudeCode.detect;
        opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
        codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
        claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });
        try {
          const code = await install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            command: "install",
            engramBin: absBin,
          });
          // Official setup must have failed (incomplete layers), so exit is failure.
          expect(code).toBe(1);
          // Nothing was deleted (setup failed before orphan deletion), so both
          // orphans must remain on disk AND tracked in manifest.
          expect(fs.existsSync(orphan1)).toBe(true);
          expect(fs.existsSync(orphan2)).toBe(true);
          const owned = readManifest().runtimes.opencode?.owned ?? [];
          expect(owned).toContain(orphan1);
          expect(owned).toContain(orphan2);
        } finally {
          opencode.detect = o;
          codex.detect = c;
          claudeCode.detect = cc;
        }
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("[residual-1b] orphan deletion failure keeps failed and later orphans tracked", () => {
  it("second orphan deletion throws: failed + later remain, earlier may go (runInstall seam)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-res1b-"));
    const homeDir = path.join(tmp, "home");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
        // Fake successful engram bin (spawn exits 0).
        const absBin = path.join(homeDir, ".local", "bin", "engram");
        fs.mkdirSync(path.dirname(absBin), { recursive: true });
        fs.writeFileSync(absBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        try {
          fs.chmodSync(absBin, 0o755);
        } catch {
          // Windows: bit not applicable, spawn still attempted.
        }
        mocks.detectEngram.mockReturnValue(absBin);
        mocks.runDetectedBin.mockReturnValue("1.20.0");

        const configDir = seedOpencodeExact(homeDir, REAL_OFFICIAL_OPENCODE_TS, absBin);

        const orphan1 = path.join(configDir, "orphan-del-1.txt");
        const orphan2 = path.join(configDir, "orphan-del-2.txt");
        const orphan3 = path.join(configDir, "orphan-del-3.txt");
        fs.writeFileSync(orphan1, "o1\n");
        fs.writeFileSync(orphan2, "o2\n");
        fs.writeFileSync(orphan3, "o3\n");

        const { writeRuntimeManifest, readManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir, owned: [orphan1, orphan2, orphan3], updatedAt: "seed" });

        const install = await import("../src/install.js");
        const opencode = install.ADAPTERS.opencode!;
        const codex = install.ADAPTERS.codex!;
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const o = opencode.detect;
        const c = codex.detect;
        const cc = claudeCode.detect;
        opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
        codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
        claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });

        const realRm = fs.rmSync;
        const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((target: unknown, opts: unknown) => {
          const t = String(target);
          if (path.resolve(t) === path.resolve(orphan2)) {
            throw new Error("EACCES: deletion failed (injected)");
          }
          return (realRm as (t: string, o?: unknown) => void)(t as string, o as never);
        }) as typeof fs.rmSync);
        try {
          const code = await install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            command: "install",
            engramBin: absBin,
          });
          // Deletion failed at orphan2, so install reports failure.
          expect(code).toBe(1);
          // Earlier orphan1 was successfully deleted and may be untracked.
          // Failed orphan2 and later orphan3 were NOT deleted and must remain tracked.
          expect(fs.existsSync(orphan2)).toBe(true);
          expect(fs.existsSync(orphan3)).toBe(true);
          const owned = readManifest().runtimes.opencode?.owned ?? [];
          expect(owned).toContain(orphan2);
          expect(owned).toContain(orphan3);
        } finally {
          rmSpy.mockRestore();
          opencode.detect = o;
          codex.detect = c;
          claudeCode.detect = cc;
        }
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2) OpenCode fail-closed on unreadable/malformed/unverifiable configs
// ---------------------------------------------------------------------------

describe("[residual-2] OpenCode verification fails closed on any unverifiable config", () => {
  it("control: pure valid JSON single file passes", async () => {
    const home = tempHome("jx-res2-ctrl-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    const mod = await import("../src/adapters/opencode.js");
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
    expect(report.ok).toBe(true);
  });

  it("control: pure valid JSON opencode.json + tui.json passes", async () => {
    const home = tempHome("jx-res2-ctrl2-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    fs.writeFileSync(
      path.join(dir, "tui.json"),
      JSON.stringify({ plugin: ["opencode-subagent-statusline"] }),
    );
    const mod = await import("../src/adapters/opencode.js");
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
    expect(report.ok).toBe(true);
  });

  it("malformed second file blocks success even when first is valid", async () => {
    const home = tempHome("jx-res2-mal-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    // Valid first file would otherwise pass; second file is truncated JSON.
    fs.writeFileSync(
      path.join(dir, "opencode.jsonc"),
      `{"mcp": {"engram": {"type": "local", "command": ["${bin}", "mcp", "--tools=agent"]}, "statusline": {"command": "engram statusline"}`,
    );
    const mod = await import("../src/adapters/opencode.js");
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
    expect(report.ok).toBe(false);
  });

  it("malformed tui.json blocks success even when opencode.json is valid", async () => {
    const home = tempHome("jx-res2-tui-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    fs.writeFileSync(path.join(dir, "tui.json"), `{"plugin": ["opencode-subagent-statusline"`);
    const mod = await import("../src/adapters/opencode.js");
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
    expect(report.ok).toBe(false);
  });

  it("structurally unverifiable file blocks success even when another is valid", async () => {
    const home = tempHome("jx-res2-struct-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    // Valid JSON array: parseable but not an object, so duplicates/MCP cannot
    // be structurally verified. Must fail closed, not be skipped.
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), "[]\n");
    const mod = await import("../src/adapters/opencode.js");
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
    expect(report.ok).toBe(false);
  });

  it("unreadable (EACCES) second file blocks success; inability to check duplicates is not no-duplicates", async () => {
    const home = tempHome("jx-res2-eacces-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    const unreadable = path.join(dir, "opencode.jsonc");
    fs.writeFileSync(unreadable, JSON.stringify({ mcp: {} }));
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: unknown, opts: unknown) => {
      if (path.resolve(String(file)) === path.resolve(unreadable)) {
        const err = new Error(`EACCES: permission denied, open '${String(file)}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realRead as (f: string, o?: unknown) => string)(String(file), opts as never);
    }) as typeof fs.readFileSync);
    try {
      const mod = await import("../src/adapters/opencode.js");
      const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
      expect(report.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3) Empty engramBin must not accept foreign "engram" substring
// ---------------------------------------------------------------------------

describe("[residual-3] empty engramBin rejects foreign path containing engram", () => {
  it("control: exact bin with pure valid JSON passes", async () => {
    const home = tempHome("jx-res3-ctrl-");
    const bin = path.join(home, ".local", "bin", "engram");
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, bin);
    const mod = await import("../src/adapters/opencode.js");
    expect(mod.checkOpencodeOfficialMcp(dir, bin)).toBe(true);
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: bin });
    expect(report.ok).toBe(true);
  });

  it("foreign path containing engram does not count when engramBin is empty", async () => {
    const home = tempHome("jx-res3-foreign-");
    const foreign = "/tmp/foreign-engram-wrapper/bin";
    const dir = seedOpencodeExact(home, REAL_OFFICIAL_OPENCODE_TS, foreign);
    const mod = await import("../src/adapters/opencode.js");
    // Direct predicate must be false, matching Claude/Codex empty-bin behavior.
    expect(mod.checkOpencodeOfficialMcp(dir, "")).toBe(false);
    // Full verifier with empty bin must not report success via that MCP.
    const report = await mod.verifyOfficialSetup({ configDir: dir, engramBin: "" });
    expect(report.ok).toBe(false);
  });

  it("controls: Claude/Codex already fail closed on empty bin (parity reference)", async () => {
    const home = tempHome("jx-res3-parity-");
    const foreign = "/tmp/foreign-engram-wrapper/bin";
    // Claude: foreign MCP + empty bin is not healthy.
    const claudeDir = path.join(home, ".claude");
    const pluginDir = path.join(claudeDir, "plugins", "marketplaces", "engram");
    fs.mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "engram@engram": [{}] } }),
    );
    fs.writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    fs.writeFileSync(path.join(pluginDir, "scripts", "a.sh"), "#!/bin/sh\n");
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { engram: { type: "stdio", command: foreign, args: ["mcp", "--tools=agent"] } } }),
    );
    const claude = await import("../src/adapters/claude-code.js");
    const claudeReport = await claude.verifyOfficialSetup({ configDir: claudeDir, engramBin: "" });
    expect(claudeReport.ok).toBe(false);
    // Codex: foreign MCP + empty bin is conflict/missing, never ok.
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        'model_instructions_file = "engram-instructions.md"',
        'experimental_compact_prompt_file = "engram-compact-prompt.md"',
        "",
        '[plugins."engram@main"]',
        "",
        "[mcp_servers.engram]",
        `command = ${JSON.stringify(foreign)}`,
        'args = ["mcp", "--tools=agent"]',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(codexDir, "engram-instructions.md"), "official instructions\n");
    fs.writeFileSync(path.join(codexDir, "engram-compact-prompt.md"), "official compact\n");
    const codex = await import("../src/adapters/codex.js");
    const codexReport = await codex.verifyOfficialSetup({ configDir: codexDir, engramBin: "" });
    expect(codexReport.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4) Uninstall EACCES on official plugin preserves via runUninstall
// ---------------------------------------------------------------------------

describe("[residual-4] uninstall EACCES on official plugin preserves official integration", () => {
  it("EACCES reading plugins/engram.ts preserves plugin and MCP under --remove-engram", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-res4-"));
    const homeDir = path.join(tmp, "home");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
        mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
        mocks.runDetectedBin.mockReturnValue("1.2.3");
        const configDir = path.join(homeDir, ".config", "opencode");
        const pluginFile = path.join(configDir, "plugins", "engram.ts");
        const bin = path.join(homeDir, ".local", "bin", "engram");
        fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
        fs.writeFileSync(pluginFile, REAL_OFFICIAL_OPENCODE_TS);
        fs.writeFileSync(
          path.join(configDir, "opencode.json"),
          JSON.stringify({
            mcp: { engram: { type: "local", command: [bin, "mcp", "--tools=agent"] } },
            statusline: { command: "engram statusline" },
          }),
        );
        const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir, owned: [pluginFile], updatedAt: "t" });

        const install = await import("../src/install.js");
        const { runUninstall } = await import("../src/uninstall.js");
        const opencode = install.ADAPTERS.opencode!;
        const codex = install.ADAPTERS.codex!;
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const o = opencode.detect;
        const c = codex.detect;
        const cc = claudeCode.detect;
        opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
        codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
        claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });

        const realRead = fs.readFileSync;
        const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: unknown, opts: unknown) => {
          if (path.resolve(String(file)) === path.resolve(pluginFile)) {
            const err = new Error(`EACCES: permission denied, open '${String(file)}'`) as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return (realRead as (f: string, o?: unknown) => string)(String(file), opts as never);
        }) as typeof fs.readFileSync);
        try {
          await expect(
            runUninstall({ runtimes: ["opencode"], dryRun: false, yes: true, removeEngram: true, removePlaywright: false }),
          ).resolves.toBe(0);
          // Fail-closed: unreadable plugin cannot be proven legacy, so the
          // file itself must survive even with --remove-engram.
          expect(fs.existsSync(pluginFile)).toBe(true);
          // The official MCP registration belongs to the same unreadable
          // official integration and must also survive (no fail-open delete).
          const raw = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")) as Record<string, unknown>;
          const mcp = (raw["mcp"] ?? {}) as Record<string, unknown>;
          expect(mcp["engram"]).toBeDefined();
        } finally {
          spy.mockRestore();
          opencode.detect = o;
          codex.detect = c;
          claudeCode.detect = cc;
        }
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5) Symlink safety at runOfficialSetup seam
// ---------------------------------------------------------------------------

describe("[residual-5] setup rejects symlinks before backup/spawn and never follows them", () => {
  it("target itself is a symlink: blocked before backup/spawn, link target untouched", async () => {
    const root = tempDir("jx-res5-target-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "outside-original\n");
    const linkTarget = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(linkTarget), { recursive: true });
    fs.symlinkSync(outsideFile, linkTarget);

    const mod = await import("../src/lib/official-engram-setup.js");
    let backupCalls = 0;
    let spawnCalls = 0;
    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [linkTarget],
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
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside-original\n");
  });

  it("existing ancestor is a symlink: blocked before backup/spawn", async () => {
    const root = tempDir("jx-res5-ancestor-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside-real");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "keep.txt");
    fs.writeFileSync(outsideFile, "keep\n");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    // Replace plugins ancestor with a symlink to outside.
    const ancestor = path.join(configDir, "plugins");
    fs.symlinkSync(outsideDir, ancestor);
    const target = path.join(ancestor, "config.toml");

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
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep\n");
  });

  it("marketplace tree alias to outside HOME is blocked and never read/deleted", async () => {
    const root = tempDir("jx-res5-market-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideDir = path.join(root, "outside-market");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "evil.txt");
    fs.writeFileSync(outsideFile, "outside\n");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(path.join(configDir, "plugins", "marketplaces"), { recursive: true });
    const marketplace = path.join(configDir, "plugins", "marketplaces", "engram");
    fs.symlinkSync(outsideDir, marketplace);

    const mod = await import("../src/lib/official-engram-setup.js");
    let backupCalls = 0;
    let spawnCalls = 0;
    const result = await mod.runOfficialSetup("claude-code", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [marketplace, path.join(configDir, "settings.json")],
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
    expect(fs.existsSync(marketplace)).toBe(true);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });

  it("tree entry inside existing marketplace dir that is a symlink to ~/.engram is blocked", async () => {
    const root = tempDir("jx-res5-tree-");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const engramData = path.join(home, ".engram");
    fs.mkdirSync(engramData, { recursive: true });
    const db = path.join(engramData, "engram.db");
    fs.writeFileSync(db, "memories\n");
    const configDir = path.join(home, ".claude");
    const marketplace = path.join(configDir, "plugins", "marketplaces", "engram");
    fs.mkdirSync(marketplace, { recursive: true });
    fs.writeFileSync(path.join(marketplace, "keep.txt"), "keep\n");
    // Tree entry symlink pointing at ~/.engram (must never be followed).
    fs.symlinkSync(engramData, path.join(marketplace, "alias-to-engram"));

    const mod = await import("../src/lib/official-engram-setup.js");
    let backupCalls = 0;
    let spawnCalls = 0;
    const result = await mod.runOfficialSetup("claude-code", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [marketplace],
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
    expect(fs.readFileSync(db, "utf8")).toBe("memories\n");
  });

  it("post-spawn symlink replacement before restore must not write through the link", async () => {
    const root = tempDir("jx-res5-post-");
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
    // Real-ish backup of the preexisting file (copied before spawn).
    const { createBackup } = await import("../src/lib/backup.js");
    const backupRoot = path.join(root, "backups");
    let backupId: string | null = null;

    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [preexisting],
      backup: async () => {
        const backup = createBackup([preexisting], "res5-post", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        // Malicious/faulty setup replaces the preexisting file with a symlink
        // to outside BEFORE verify/restore.
        fs.rmSync(preexisting, { force: true });
        fs.symlinkSync(outsideFile, preexisting);
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: false, reason: "verify falló" }),
      restore: async () => {
        // Naive restore would copy through the link and corrupt outside.
        // The seam must protect: detect symlink and fail closed instead.
        const { restoreBackup } = await import("../src/lib/backup.js");
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });
    expect(result.ok).toBe(false);
    // Must not have corrupted the outside file through the link.
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside-original\n");
    // Recovery must be reported as incomplete (could not safely restore).
    const incomplete =
      (result as unknown as Record<string, unknown>).incompleteRecovery === true ||
      result.recovery === "incomplete";
    expect(incomplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6) Claude custom config safety: default .claude.json must be covered
// ---------------------------------------------------------------------------

describe("[residual-6] Claude custom config covers default HOME .claude.json", () => {
  it("control: default configDir backs up the HOME sibling", async () => {
    const home = tempHome("jx-res6-ctrl-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const targets = mod.collectOfficialSetupBackupTargets("claude-code", configDir, home) as string[];
    expect(targets).toContain(path.join(home, ".claude.json"));
  });

  it("custom configDir inside HOME also includes default HOME .claude.json for rollback", async () => {
    const root = tempDir("jx-res6-custom-");
    const home = path.join(root, "home");
    const customDir = path.join(home, "custom-claude");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(customDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const targets = mod.collectOfficialSetupBackupTargets("claude-code", customDir, home) as string[];
    // Conservative contract chosen: rollback must cover BOTH the custom
    // location the setup writes AND the default HOME sibling, so a custom
    // run can never leave the default unrestorable.
    expect(targets).toContain(path.join(customDir, ".claude.json"));
    expect(targets).toContain(path.join(home, ".claude.json"));
  });
});
