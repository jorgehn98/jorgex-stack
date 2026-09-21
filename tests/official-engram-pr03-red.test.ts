import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_CODE_TEST_MODELS, TEST_MODEL_MAP } from "./fixtures/model-map.js";

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

/**
 * RED regression net for PR03 candidate cf0d9b7.
 * Each test asserts the required contract; all must FAIL now for the
 * intended behavioral reason (not fixture noise). No production change here.
 */

// Representative REAL official OpenCode markers (adapter-recognized).
const REAL_OFFICIAL_OPENCODE_TS = [
  "// official engram setup opencode (same path, real markers)",
  "const url = CONFIGURED_ENGRAM_URL;",
  "async function ensureLocalReady() { return true; }",
  "const tools = SESSION_ATTRIBUTED_WRITE_TOOLS;",
  "function canonicalEngramToolName() { return 'engram'; }",
  "const id = localInstanceID;",
  "",
].join("\n");

const STUB_ONLY_TS = [
  "// engram official plugin",
  "export const Engram = {};",
  "",
].join("\n");

const LEGACY_STACK_TS = [
  "// jorgex-stack legacy engram plugin",
  'declare const Bun: { which?: (bin: string) => string | null };',
  'const ENGRAM_BIN = "{{ENGRAM_BIN}}";',
  "export function resolveEngramBin(installerBin = ENGRAM_BIN): string { return installerBin; }",
  "function stripPrivateTags(str: string): string { return str; }",
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

describe("[PR03-RED-1] install/sync preserves owned legacy engram.ts without verified setup", () => {
  it("owned legacy manifest entry survives a skipped official setup (no silent ownership drop)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pr03-red1-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const legacyFile = path.join(configDir, "plugins", "engram.ts");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
        mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
        mocks.runDetectedBin.mockReturnValue("1.2.3");
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.writeFileSync(legacyFile, LEGACY_STACK_TS);

        const { writeRuntimeManifest, readManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir, owned: [legacyFile], updatedAt: "legacy" });

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
          // No `command: "install"` + non-absolute bin => official setup skipped (ran:false).
          await expect(
            install.runInstall({ runtimes: ["opencode"], dryRun: false, yes: true, mode: { mode: "human", subagentConcurrency: "serial" } }),
          ).resolves.toBe(0);
          // File itself is spared by findOrphans, but ownership must also survive a skip.
          expect(fs.readFileSync(legacyFile, "utf8")).toBe(LEGACY_STACK_TS);
          expect(readManifest().runtimes.opencode?.owned ?? []).toContain(legacyFile);
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

describe("[PR03-RED-2] rollback exposes incomplete recovery; Claude inventory covers marketplace tree", () => {
  it("Claude backup targets include the marketplace plugin tree", async () => {
    const home = tempHome("jx-pr03-red2-claude-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const targets = mod.collectOfficialSetupBackupTargets("claude-code", configDir, home) as string[];
    expect(targets).toContain(path.join(configDir, "plugins", "marketplaces", "engram"));
  });

  it("restore failure is exposed as incomplete recovery, never silent success", async () => {
    const home = tempHome("jx-pr03-red2-rollback-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const preexisting = path.join(configDir, "config.toml");
    fs.writeFileSync(preexisting, 'model = "user/model"\n');
    const created = path.join(configDir, "new-from-setup.txt");
    const mod = await import("../src/lib/official-engram-setup.js");
    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [created, preexisting],
      backup: async () => ({ id: "fake-backup" }),
      spawn: async () => {
        fs.writeFileSync(created, "partial\n");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: false, reason: "verify falló" }),
      restore: async () => {
        throw new Error("restore I/O failed");
      },
    });
    expect(result.ok).toBe(false);
    // Must expose incomplete recovery instead of a generic failure.
    expect((result as unknown as Record<string, unknown>).incompleteRecovery).toBe(true);
  });
});

describe("[PR03-RED-3] OpenCode verifier rejects weak signals, accepts real markers", () => {
  it("rejects the test-only marker but accepts representative real official markers", async () => {
    const home = tempHome("jx-pr03-red3-marker-");
    const engramBin = path.join(home, ".local", "bin", "engram");
    const stubDir = seedOpencodeExact(home, STUB_ONLY_TS, engramBin);
    const mod = await import("../src/adapters/opencode.js");
    const stubReport = await mod.verifyOfficialSetup({ configDir: stubDir, engramBin });
    expect(stubReport.ok).toBe(false);

    const home2 = tempHome("jx-pr03-red3-real-");
    const bin2 = path.join(home2, ".local", "bin", "engram");
    const realDir = seedOpencodeExact(home2, REAL_OFFICIAL_OPENCODE_TS, bin2);
    const realReport = await mod.verifyOfficialSetup({ configDir: realDir, engramBin: bin2 });
    expect(realReport.ok).toBe(true);
  });

  it("rejects malformed/truncated JSON, loose fragments and duplicate Engram plugins", async () => {
    const mod = await import("../src/adapters/opencode.js");

    // Truncated JSON that still contains the loose substrings.
    const homeA = tempHome("jx-pr03-red3-trunc-");
    const binA = path.join(homeA, ".local", "bin", "engram");
    const dirA = path.join(homeA, ".config", "opencode");
    fs.mkdirSync(path.join(dirA, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(dirA, "plugins", "engram.ts"), REAL_OFFICIAL_OPENCODE_TS);
    fs.writeFileSync(
      path.join(dirA, "opencode.json"),
      `{"mcp": {"engram": {"type": "local", "command": ["${binA}", "mcp", "--tools=agent"]}, "statusline": {"command": "engram statusline"}`,
    );
    const truncReport = await mod.verifyOfficialSetup({ configDir: dirA, engramBin: binA });
    expect(truncReport.ok).toBe(false);

    // Loose fragments across unrelated blocks in unparseable JSONC.
    const homeB = tempHome("jx-pr03-red3-loose-");
    const binB = path.join(homeB, ".local", "bin", "engram");
    const dirB = path.join(homeB, ".config", "opencode");
    fs.mkdirSync(path.join(dirB, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(dirB, "plugins", "engram.ts"), REAL_OFFICIAL_OPENCODE_TS);
    fs.writeFileSync(
      path.join(dirB, "opencode.json"),
      [
        "// official config with comments",
        '{"mcp": {"engram": {"type": "remote", "url": "https://ajeno.invalid"}},',
        `"other": {"type": "local", "command": ["${binB}", "mcp", "--tools=agent"]},`,
        `"notes": "engram statusline fragment" // trailing`,
      ].join("\n"),
    );
    const looseReport = await mod.verifyOfficialSetup({ configDir: dirB, engramBin: binB });
    expect(looseReport.ok).toBe(false);

    // Detected duplicate Engram plugin must block success.
    const homeC = tempHome("jx-pr03-red3-dup-");
    const binC = path.join(homeC, ".local", "bin", "engram");
    const dirC = seedOpencodeExact(homeC, REAL_OFFICIAL_OPENCODE_TS, binC);
    const dupRaw = JSON.parse(fs.readFileSync(path.join(dirC, "opencode.json"), "utf8")) as Record<string, unknown>;
    (dupRaw as Record<string, unknown>).plugin = ["https://example.com/engram-extra"];
    fs.writeFileSync(path.join(dirC, "opencode.json"), JSON.stringify(dupRaw));
    const dupReport = await mod.verifyOfficialSetup({ configDir: dirC, engramBin: binC });
    expect(dupReport.ok).toBe(false);
  });
});

describe("[PR03-RED-4] doctor uses exact predicates and surfaces setup/exposure", () => {
  it("Claude wrong command/args and incomplete hooks are not healthy", async () => {
    mocks.detectEngram.mockReturnValue(null);
    mocks.runDetectedBin.mockReturnValue(null);
    const home = tempHome("jx-pr03-red4-claude-");
    const configDir = path.join(home, ".claude");
    const pluginDir = path.join(configDir, "plugins", "marketplaces", "engram");
    fs.mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "engram@engram": [{}] } }),
    );
    fs.writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    // Wrong binary but right shape: adapter-exact would fail, doctor must too.
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { engram: { type: "stdio", command: "/wrong/bin", args: ["mcp", "--tools=agent"] } } }),
    );
    const doctor = await import("../src/doctor.js");
    const wrongBin = await doctor.resolveEngramOfficialState({ homeDir: home });
    expect((wrongBin.setup.runtimes["claude-code"] as { ok: boolean }).ok).toBe(false);

    // Incomplete hooks: hooks.json present but no scripts at all.
    fs.rmSync(path.join(pluginDir, "scripts"), { recursive: true, force: true });
    const bin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { engram: { type: "stdio", command: bin, args: ["mcp", "--tools=agent"] } } }),
    );
    const noScripts = await doctor.resolveEngramOfficialState({ homeDir: home });
    expect((noScripts.setup.runtimes["claude-code"] as { ok: boolean }).ok).toBe(false);
  });

  it("Codex wrong MCP binary and missing compact/instructions are not healthy", async () => {
    mocks.detectEngram.mockReturnValue(null);
    mocks.runDetectedBin.mockReturnValue(null);
    const home = tempHome("jx-pr03-red4-codex-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const bin = path.join(home, ".local", "bin", "engram");
    const writeConfig = (command: string) =>
      fs.writeFileSync(
        path.join(configDir, "config.toml"),
        [
          'model_instructions_file = "engram-instructions.md"',
          'experimental_compact_prompt_file = "engram-compact-prompt.md"',
          "",
          '[plugins."engram@main"]',
          "",
          "[mcp_servers.engram]",
          `command = ${JSON.stringify(command)}`,
          'args = ["mcp", "--tools=agent"]',
          "",
        ].join("\n"),
      );
    fs.writeFileSync(path.join(configDir, "engram-instructions.md"), "official instructions\n");
    fs.writeFileSync(path.join(configDir, "engram-compact-prompt.md"), "official compact\n");
    writeConfig("/foreign/bin");
    const doctor = await import("../src/doctor.js");
    const wrongMcp = await doctor.resolveEngramOfficialState({ homeDir: home });
    expect((wrongMcp.setup.runtimes.codex as { ok: boolean }).ok).toBe(false);

    writeConfig(bin);
    fs.rmSync(path.join(configDir, "engram-compact-prompt.md"), { force: true });
    const missingCompact = await doctor.resolveEngramOfficialState({ homeDir: home });
    expect((missingCompact.setup.runtimes.codex as { ok: boolean }).ok).toBe(false);
  });

  it("runDoctor surfaces official setup/exposure status", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pr03-red4-doc-"));
    const homeDir = path.join(tmp, "home");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = TEST_MODEL_MAP;
        mocks.detectEngram.mockReturnValue(path.join(homeDir, ".local", "bin", "engram"));
        mocks.runDetectedBin.mockReturnValue("1.20.0");
        const { runDoctor } = await import("../src/doctor.js");
        await runDoctor({ runtimes: [] });
        const logs = [
          ...mocks.prompts.log.info.mock.calls.flat(),
          ...mocks.prompts.log.success.mock.calls.flat(),
          ...mocks.prompts.log.warn.mock.calls.flat(),
          ...mocks.prompts.log.error.mock.calls.flat(),
        ].join("\n");
        expect(logs).toMatch(/setup|exposure/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("[PR03-RED-5] uninstall preserves real official, retires stub legacy; unknown fails closed", () => {
  it("with --remove-engram keeps real official content but retires stub-marked legacy per ownership", async () => {
    // Real official preservation (control, passes now).
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pr03-red5-real-"));
      const homeDir = path.join(tmp, "home");
      const configDir = path.join(homeDir, ".config", "opencode");
      const pluginFile = path.join(configDir, "plugins", "engram.ts");
      try {
        await withTempHome(homeDir, async () => {
          mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
          mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
          mocks.runDetectedBin.mockReturnValue("1.2.3");
          const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
          const install = await import("../src/install.js");
          const { runUninstall } = await import("../src/uninstall.js");
          const opencode = install.ADAPTERS.opencode!;
          const o = opencode.detect;
          opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
          try {
            fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
            fs.writeFileSync(pluginFile, REAL_OFFICIAL_OPENCODE_TS);
            writeRuntimeManifest("opencode", { configDir, owned: [pluginFile], updatedAt: "t" });
            await expect(
              runUninstall({ runtimes: ["opencode"], dryRun: false, yes: true, removeEngram: true, removePlaywright: false }),
            ).resolves.toBe(0);
            expect(fs.readFileSync(pluginFile, "utf8")).toBe(REAL_OFFICIAL_OPENCODE_TS);
          } finally {
            opencode.detect = o;
          }
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    // Stub-marked file owned by the manifest must NOT count as official.
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pr03-red5-"));
      const homeDir = path.join(tmp, "home");
      const configDir = path.join(homeDir, ".config", "opencode");
      const pluginFile = path.join(configDir, "plugins", "engram.ts");
      try {
        await withTempHome(homeDir, async () => {
          mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
          mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
          mocks.runDetectedBin.mockReturnValue("1.2.3");
          const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
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
          try {
            fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
            fs.writeFileSync(pluginFile, STUB_ONLY_TS);
            writeRuntimeManifest("opencode", { configDir, owned: [pluginFile], updatedAt: "t" });
            await expect(
              runUninstall({ runtimes: ["opencode"], dryRun: false, yes: true, removeEngram: true, removePlaywright: false }),
            ).resolves.toBe(0);
            expect(fs.existsSync(pluginFile)).toBe(false);
          } finally {
            opencode.detect = o;
            codex.detect = c;
            claudeCode.detect = cc;
          }
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});

describe("[PR03-RED-6] real install requiring setup never silently skips", () => {
  it("missing verifier, unknown runtime and missing absolute bin are errors; intentional skips stay ran:false", async () => {
    const mod = await import("../src/lib/official-engram-setup.js");
    const home = tempHome("jx-pr03-red6-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const absBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(absBin), { recursive: true });
    fs.writeFileSync(absBin, "#!/bin/sh\n");

    // Unknown runtime on a REAL install must not silently skip.
    const unknown = await mod.runOfficialSetupIfNeeded("unknown-rt", {
      command: "install", dryRun: false, targetDir: undefined, engramBin: absBin, configDir, homeDir: home,
    });
    expect(unknown).not.toMatchObject({ ran: false });

    // Missing verifier on a REAL install must not silently skip.
    const verifiers = mod.officialSetupVerifiers as Record<string, unknown>;
    const saved = verifiers.codex;
    delete verifiers.codex;
    try {
      const missing = await mod.runOfficialSetupIfNeeded("codex", {
        command: "install", dryRun: false, targetDir: undefined, engramBin: absBin, configDir, homeDir: home,
      });
      expect(missing).not.toMatchObject({ ran: false });
    } finally {
      verifiers.codex = saved;
    }

    // Missing absolute bin on a REAL install must not silently skip.
    const noBin = await mod.runOfficialSetupIfNeeded("codex", {
      command: "install", dryRun: false, targetDir: undefined, engramBin: null, configDir, homeDir: home,
    });
    expect(noBin).not.toMatchObject({ ran: false });

    // Intentional non-install / dry-run / target-dir skips remain non-errors.
    await expect(
      mod.runOfficialSetupIfNeeded("codex", { command: "sync", dryRun: false, targetDir: undefined, engramBin: absBin, configDir, homeDir: home }),
    ).resolves.toMatchObject({ ran: false });
    await expect(
      mod.runOfficialSetupIfNeeded("codex", { command: "install", dryRun: true, targetDir: undefined, engramBin: absBin, configDir, homeDir: home }),
    ).resolves.toMatchObject({ ran: false });
    await expect(
      mod.runOfficialSetupIfNeeded("codex", { command: "install", dryRun: false, targetDir: "/tmp/x", engramBin: absBin, configDir, homeDir: home }),
    ).resolves.toMatchObject({ ran: false });
  });
});

describe("[PR03-RED-7] custom config outside HOME is blocked before backup/spawn (tightened; superseded by followup-boundary)", () => {
  it("custom Codex config outside HOME blocks before backup mutation", async () => {
    const root = tempDir("jx-pr03-red7-");
    const home = path.join(root, "home");
    const customDir = path.join(root, "custom-codex");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(customDir, { recursive: true });
    const customFile = path.join(customDir, "config.toml");
    const original = 'model = "user/model"\n';
    fs.writeFileSync(customFile, original);
    const backupRoot = path.join(root, "backups");
    const { createBackup, restoreBackup } = await import("../src/lib/backup.js");
    const mod = await import("../src/lib/official-engram-setup.js");
    let backupId: string | null = null;
    let backupCalls = 0;
    let spawnCalls = 0;
    const result = await mod.runOfficialSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [customFile],
      backup: async () => {
        backupCalls++;
        const backup = createBackup([customFile], "pr03-red7", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        spawnCalls++;
        fs.writeFileSync(customFile, "mutated by setup\n");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: false, reason: "verify falló" }),
      restore: async () => {
        // Production boundary is HOME: custom outside HOME is unrestorable here.
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });
    expect(result.ok).toBe(false);
    // Strict fail-closed contract (no OR): outside-HOME must block before any
    // backup mutation or spawn, matching [followup-boundary]. The previous
    // `blocked || exposed || restored` OR accepted silent unrestorable runs.
    expect(backupCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(result.recovery).toBe("none");
    expect(fs.readFileSync(customFile, "utf8")).toBe(original);
  });
});
