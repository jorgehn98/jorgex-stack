import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_CODE_TEST_MODELS } from "./fixtures/model-map.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

afterEach(() => {
  vi.clearAllMocks();
  mocks.modelMapOverride = undefined;
  mocks.detectEngram.mockReset();
  mocks.runDetectedBin.mockReset();
});

describe("target inventory regressions", () => {
  it("marca el inventario como incompleto si un runtime detectado no tiene contexto/model-map usable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-inventory-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(tmp, "opencode");

    await withTempHome(homeDir, async () => {
      mocks.modelMapOverride = {};

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const originalDetect = opencode.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });

      try {
        const current = install.collectAllCurrentTargets();

        expect(current.complete).toBe(false);
        expect(current.warnings.length).toBeGreaterThan(0);
      } finally {
        opencode.detect = originalDetect;
      }
    });
  });

  it("vuelve visible en doctor la desactivación de limpieza cuando falta ese contexto", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-doctor-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(tmp, "opencode");

    await withTempHome(homeDir, async () => {
      mocks.modelMapOverride = {};
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const originalDetect = opencode.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });

      try {
        const { runDoctor } = await import("../src/doctor.js");
        await expect(runDoctor()).resolves.toBe(1);

        expect(mocks.prompts.log.warn).toHaveBeenCalledWith(
          expect.stringMatching(/Limpieza de huérfanos deshabilitada/i),
        );
      } finally {
        opencode.detect = originalDetect;
      }
    });
  });

  it("usa la preferencia guardada de modo programmatic en doctor y no reporta drift falso", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-doctor-mode-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(tmp, "opencode");

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = {
        opencode: OPEN_CODE_TEST_MODELS,
        codex: DEFAULT_MODEL_MAP.codex,
        "claude-code": DEFAULT_MODEL_MAP["claude-code"],
      };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;
      const originalClaudeDetect = claudeCode.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });
      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".codex"),
      });
      claudeCode.detect = () => ({
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".claude"),
      });

      try {
        await expect(
          install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "programmatic", subagentConcurrency: "parallel" },
          }),
        ).resolves.toBe(0);

        const { runDoctor } = await import("../src/doctor.js");
        await expect(runDoctor()).resolves.toBe(0);
        expect(mocks.prompts.log.warn).not.toHaveBeenCalledWith(
          expect.stringMatching(/OpenCode: .*desactualizados o ausentes/i),
        );
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
        claudeCode.detect = originalClaudeDetect;
      }
    });
  });

  it("no borra huérfanos de manifest cuando el inventario global está incompleto", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-orphan-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".opencode");
    const orphanFile = path.join(configDir, "legacy", "orphan.txt");

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      fs.mkdirSync(path.dirname(orphanFile), { recursive: true });
      fs.writeFileSync(orphanFile, "keep me\n");

      const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
      writeRuntimeManifest("opencode", { configDir, owned: [orphanFile], updatedAt: "t" });

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });
      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: true,
        binPath: null,
        configDir: path.join(homeDir, ".codex"),
      });

      try {
        await expect(
          install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          }),
        ).resolves.toBe(0);

        expect(fs.existsSync(orphanFile)).toBe(true);
        expect(fs.readFileSync(orphanFile, "utf8")).toBe("keep me\n");
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
      }
    });
  });

  it("con inventario incompleto conserva en el manifest los owned previos y los del plan actual", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-manifest-owned-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".opencode");
    const previousOwned = path.join(configDir, "legacy", "orphan.txt");
    const currentOwned = path.join(configDir, "agents", "backend-analyst.md");

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      fs.mkdirSync(path.dirname(previousOwned), { recursive: true });
      fs.writeFileSync(previousOwned, "keep me\n");

      const { readManifest, writeRuntimeManifest } = await import("../src/lib/manifest.js");
      writeRuntimeManifest("opencode", { configDir, owned: [previousOwned], updatedAt: "t" });

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });
      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: true,
        binPath: null,
        configDir: path.join(homeDir, ".codex"),
      });

      try {
        await expect(
          install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          }),
        ).resolves.toBe(0);

        expect(fs.existsSync(previousOwned)).toBe(true);
        expect(fs.readFileSync(previousOwned, "utf8")).toBe("keep me\n");
        expect(readManifest().runtimes.opencode?.owned).toEqual(expect.arrayContaining([previousOwned, currentOwned]));
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
      }
    });
  });

  it("con inventario degradado no mete en el manifest los targets compartidos del unmerge", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-manifest-unmerge-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".opencode");
    const sharedTarget = path.join(configDir, "AGENTS.md");
    const privateTarget = path.join(configDir, "legacy", "private.txt");

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      fs.mkdirSync(path.dirname(privateTarget), { recursive: true });
      fs.writeFileSync(sharedTarget, "# shared\n");
      fs.writeFileSync(privateTarget, "private\n");

      const { writeRuntimeManifest, readManifest } = await import("../src/lib/manifest.js");
      writeRuntimeManifest("opencode", { configDir, owned: [sharedTarget, privateTarget], updatedAt: "t" });

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });
      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: true,
        binPath: null,
        configDir: path.join(homeDir, ".codex"),
      });

      try {
        await expect(
          install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          }),
        ).resolves.toBe(0);

        const manifest = readManifest();
        expect(manifest.runtimes.opencode?.owned).toEqual(expect.arrayContaining([privateTarget]));
        expect(manifest.runtimes.opencode?.owned ?? []).not.toContain(sharedTarget);
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
      }
    });
  });

  it("preserva agent-browser modificado sin ownership y lo retira solo cuando un manifest válido lo declara", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-agent-browser-manifest-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const legacySkill = path.join(homeDir, ".agents", "skills", "agent-browser", "SKILL.md");

    await withTempHome(homeDir, async () => {
      mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");
      fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
      fs.writeFileSync(legacySkill, "# User-modified agent-browser\n");

      const { readManifest, writeRuntimeManifest } = await import("../src/lib/manifest.js");
      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;
      const originalClaudeDetect = claudeCode.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir,
      });
      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".codex"),
      });
      claudeCode.detect = () => ({
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".claude"),
      });

      try {
        const current = install.collectAllCurrentTargets();
        expect(current.complete).toBe(true);
        expect(current.targets).not.toContain(path.resolve(legacySkill));

        await expect(
          install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          }),
        ).resolves.toBe(0);

        expect(fs.readFileSync(legacySkill, "utf8")).toBe("# User-modified agent-browser\n");

        const previous = readManifest().runtimes.opencode!;
        writeRuntimeManifest("opencode", {
          ...previous,
          owned: [...previous.owned, legacySkill],
        });

        await expect(
          install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          }),
        ).resolves.toBe(0);

        expect(fs.existsSync(legacySkill)).toBe(false);
        expect(readManifest().runtimes.opencode?.owned).not.toContain(legacySkill);
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
        claudeCode.detect = originalClaudeDetect;
      }
    });
  });

  it("conserva la skill Playwright compartida al desinstalar Codex si OpenCode sigue instalado", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-shared-playwright-uninstall-"));
    const homeDir = path.join(tmp, "home");
    const codexDir = path.join(homeDir, ".codex");
    const opencodeDir = path.join(homeDir, ".config", "opencode");
    const sharedSkill = path.join(homeDir, ".agents", "skills", "playwright-cli", "SKILL.md");

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = {
        opencode: OPEN_CODE_TEST_MODELS,
        codex: DEFAULT_MODEL_MAP.codex,
      };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");
      fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
      fs.writeFileSync(sharedSkill, "Playwright CLI skill\n");

      const { readManifest, writeRuntimeManifest } = await import("../src/lib/manifest.js");
      writeRuntimeManifest("codex", { configDir: codexDir, owned: [sharedSkill], updatedAt: "t" });

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;
      const originalClaudeDetect = claudeCode.detect;

      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: true,
        binPath: null,
        configDir: opencodeDir,
      });
      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: true,
        binPath: null,
        configDir: codexDir,
      });
      claudeCode.detect = () => ({
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".claude"),
      });

      try {
        const { runUninstall } = await import("../src/uninstall.js");
        await expect(
          runUninstall({
            runtimes: ["codex"],
            dryRun: false,
            yes: true,
            removeEngram: false,
            removePlaywright: false,
          }),
        ).resolves.toBe(0);

        expect(fs.existsSync(sharedSkill)).toBe(true);
        expect(readManifest().runtimes.codex).toBeUndefined();
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
        claudeCode.detect = originalClaudeDetect;
      }
    });
  });

  it.each([
    "codex",
    "opencode",
  ] as const)("conserva la skill compartida de Pi al desinstalar solo %s", async (runtime) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jx-pi-${runtime}-uninstall-`));
    const homeDir = path.join(tmp, "home");
    const configDirs = {
      codex: path.join(homeDir, ".codex"),
      opencode: path.join(homeDir, ".config", "opencode"),
    };

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = {
        codex: DEFAULT_MODEL_MAP.codex,
        opencode: OPEN_CODE_TEST_MODELS,
      };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      const { PI_RUNTIME_CANDIDATE } = await import("../src/lib/pi-runtime.js");
      const { runPiProjectionLifecycleSystem } = await import("../src/lib/pi-projection-lifecycle.js");
      const projection = runPiProjectionLifecycleSystem({
        operation: "install",
        packageSource: PI_RUNTIME_CANDIDATE.package.source,
        engramBin: null,
        playwrightCliEnabled: false,
      });
      expect(projection.kind).toBe("installed");

      const sharedSkill = path.join(homeDir, ".agents", "skills", "tdd", "SKILL.md");
      const receiptFile = path.join(homeDir, ".jorgex-stack", "pi-projection-receipt.json");
      expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toMatchObject({
        schemaVersion: 1,
        scope: {
          kind: "real",
          home: homeDir,
          codingAgentDir: path.join(homeDir, ".pi", "agent"),
          receiptFile,
        },
        owned: expect.arrayContaining([sharedSkill]),
      });

      const { readManifest, writeRuntimeManifest } = await import("../src/lib/manifest.js");
      writeRuntimeManifest(runtime, { configDir: configDirs[runtime], owned: [sharedSkill], updatedAt: "t" });

      const install = await import("../src/install.js");
      const codex = install.ADAPTERS.codex!;
      const opencode = install.ADAPTERS.opencode!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const originalCodexDetect = codex.detect;
      const originalOpencodeDetect = opencode.detect;
      const originalClaudeDetect = claudeCode.detect;

      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: runtime === "codex",
        binPath: null,
        configDir: configDirs.codex,
      });
      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: runtime === "opencode",
        binPath: null,
        configDir: configDirs.opencode,
      });
      claudeCode.detect = () => ({
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".claude"),
      });

      try {
        const { runUninstall } = await import("../src/uninstall.js");
        await expect(
          runUninstall({
            runtimes: [runtime],
            dryRun: false,
            yes: true,
            removeEngram: false,
            removePlaywright: false,
          }),
        ).resolves.toBe(0);

        expect(fs.existsSync(sharedSkill)).toBe(true);
        expect(fs.existsSync(receiptFile)).toBe(true);
        expect(readManifest().runtimes[runtime]).toBeUndefined();
      } finally {
        codex.detect = originalCodexDetect;
        opencode.detect = originalOpencodeDetect;
        claudeCode.detect = originalClaudeDetect;
      }
    });
  });

  it.each([
    "codex",
    "opencode",
  ] as const)("blocks destructive %s uninstall when Pi's shared projection receipt is corrupt", async (runtime) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jx-pi-corrupt-receipt-${runtime}-uninstall-`));
    const homeDir = path.join(tmp, "home");
    const configDirs = {
      codex: path.join(homeDir, ".codex"),
      opencode: path.join(homeDir, ".config", "opencode"),
    };
    const sharedSkill = path.join(homeDir, ".agents", "skills", "tdd", "SKILL.md");
    const receiptFile = path.join(homeDir, ".jorgex-stack", "pi-projection-receipt.json");

    await withTempHome(homeDir, async () => {
      const { DEFAULT_MODEL_MAP } = await vi.importActual<typeof import("../src/lib/model-map.js")>("../src/lib/model-map.js");
      mocks.modelMapOverride = {
        codex: DEFAULT_MODEL_MAP.codex,
        opencode: OPEN_CODE_TEST_MODELS,
      };
      mocks.detectEngram.mockReturnValue("C:/mock/engram.exe");
      mocks.runDetectedBin.mockReturnValue("1.2.3");

      fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
      fs.writeFileSync(sharedSkill, "Pi shared skill\n");
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.writeFileSync(receiptFile, "{not-json\n");

      const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
      writeRuntimeManifest(runtime, { configDir: configDirs[runtime], owned: [sharedSkill], updatedAt: "t" });

      const install = await import("../src/install.js");
      const codex = install.ADAPTERS.codex!;
      const opencode = install.ADAPTERS.opencode!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const originalCodexDetect = codex.detect;
      const originalOpencodeDetect = opencode.detect;
      const originalClaudeDetect = claudeCode.detect;

      codex.detect = () => ({
        id: "codex",
        name: "Codex CLI",
        installed: runtime === "codex",
        binPath: null,
        configDir: configDirs.codex,
      });
      opencode.detect = () => ({
        id: "opencode",
        name: "OpenCode",
        installed: runtime === "opencode",
        binPath: null,
        configDir: configDirs.opencode,
      });
      claudeCode.detect = () => ({
        id: "claude-code",
        name: "Claude Code",
        installed: false,
        binPath: null,
        configDir: path.join(homeDir, ".claude"),
      });

      try {
        const { runUninstall } = await import("../src/uninstall.js");
        const exitCode = await runUninstall({
          runtimes: [runtime],
          dryRun: false,
          yes: true,
          removeEngram: false,
          removePlaywright: false,
        });

        expect({
          exitCode,
          sharedSkillExists: fs.existsSync(sharedSkill),
        }).toEqual({
          exitCode: 1,
          sharedSkillExists: true,
        });
      } finally {
        codex.detect = originalCodexDetect;
        opencode.detect = originalOpencodeDetect;
        claudeCode.detect = originalClaudeDetect;
      }
    });
  });
});
