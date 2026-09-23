import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import type { InstallContext } from "../src/adapters/types.js";
import {
  loadCanonicalDefaults,
  loadCanonicalHooks,
  loadCanonicalMcp,
} from "../src/lib/canonical.js";
import { writeText } from "../src/lib/fsx.js";
import { stackRoot } from "../src/lib/paths.js";
import { TEST_MODEL_MAP, testModelsForRuntime } from "./fixtures/model-map.js";

// Silencia la salida interactiva y fija Engram como ausente para que los
// planes sean deterministas. No se mockea ninguna regla de permisos: los
// comparadores y el reseed se ejecutan de verdad.
const promptLogs = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock("@clack/prompts", () => ({
  intro: promptLogs.intro,
  outro: promptLogs.outro,
  confirm: promptLogs.confirm,
  multiselect: promptLogs.multiselect,
  select: promptLogs.select,
  isCancel: promptLogs.isCancel,
  log: {
    info: promptLogs.info,
    warn: promptLogs.warn,
    step: promptLogs.step,
    success: promptLogs.success,
    error: promptLogs.error,
    message: promptLogs.message,
  },
}));

vi.mock("../src/lib/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/detect.js")>(
    "../src/lib/detect.js",
  );
  return { ...actual, detectEngram: () => null, runDetectedBin: () => "1.2.3" };
});

const tmpRoots: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// HOME aislado con model-map real: ningún test toca el HOME del usuario.
// Los módulos se reimportan en fresco para que dataDir()/HOME apunten al tmp.
async function withIsolatedHome<T>(run: (homeDir: string, root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-perm-upgrade-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(path.join(homeDir, ".jorgex-stack"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".jorgex-stack", "model-map.json"),
    `${JSON.stringify(TEST_MODEL_MAP, null, 2)}\n`,
  );
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    vi.resetModules();
    return await run(homeDir, root);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const canonicalOpencodePermission = () =>
  loadCanonicalDefaults(stackRoot())["opencode"]?.["permission"] as Record<string, unknown>;
const canonicalClaudePermissions = () =>
  loadCanonicalDefaults(stackRoot())["claude-code"]?.["permissions"] as Record<string, unknown>;

// Legacy exacto (default anterior) y custom divergente: ambos cuentan como
// "difiere" según T02 (absent/legacy/custom → reseed con flag).
const OPENCODE_LEGACY_PERMISSION = {
  edit: "allow",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
  webfetch: "allow",
  websearch: "allow",
  bash: {
    "*": "allow",
    "rm *": "ask",
    "del *": "ask",
    "rmdir *": "ask",
    "git push --force*": "ask",
    "format *": "deny",
    "mkfs *": "deny",
    "dd *": "deny",
    "shred *": "deny",
  },
};
const OPENCODE_CUSTOM_PERMISSION = { edit: "deny", read: "ask" };

const CLAUDE_CUSTOM_PERMISSIONS = { allow: ["Bash", "Edit"], deny: ["Bash(shred:*)"] };
const CLAUDE_LEGACY_PERMISSIONS = {
  allow: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
  ask: ["Bash(rm:*)", "Bash(rmdir:*)", "Bash(del:*)", "Bash(git push --force:*)"],
  deny: [
    "Bash(format:*)",
    "Bash(mkfs:*)",
    "Bash(dd:*)",
    "Bash(shred:*)",
    "Read(./.env)",
    "Read(./.env.*)",
  ],
};

const CODEX_CUSTOM_TOML =
  'approval_policy = "never"\ndefault_permissions = "custom"\nsandbox_mode = "workspace-write"\n';
const CODEX_LEGACY_TOML = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n';

function opencodeCtx(configDir: string, overrides: Partial<InstallContext> = {}): InstallContext {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: testModelsForRuntime("opencode"),
    warnings: [],
    ...overrides,
  };
}

describe("permissions-upgrade: opencode planMainConfig", () => {
  it.each([
    ["legacy", OPENCODE_LEGACY_PERMISSION],
    ["custom", OPENCODE_CUSTOM_PERMISSION],
  ])("sin flag: %s se preserva byte a byte y avisa solo-si-difiere con --upgrade-permissions (sin dump)", (_label, permission) => {
    const dir = mkTmp("jx-perm-oc-");
    writeText(path.join(dir, "opencode.json"), JSON.stringify({ other: true, permission }));
    const ctx = opencodeCtx(dir);
    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const parsed = JSON.parse((action as { content: string }).content) as Record<string, unknown>;

    expect(parsed.other).toBe(true);
    expect(parsed.permission).toEqual(permission);
    const warnings = ctx.warnings.join("\n");
    expect(warnings).toMatch(/--upgrade-permissions/);
    expect(warnings).toMatch(/backup/i);
    expect(warnings).toMatch(/discards your own permission changes/i);
    expect(warnings).not.toContain(JSON.stringify(canonicalOpencodePermission()).slice(0, 80));
    expect(warnings).not.toContain('"external_directory"');
  });

  it.each([
    ["legacy", OPENCODE_LEGACY_PERMISSION],
    ["custom", OPENCODE_CUSTOM_PERMISSION],
  ])("con flag: %s se reemplaza entero por el canon preservando claves ajenas", (_label, permission) => {
    const dir = mkTmp("jx-perm-oc-flag-");
    writeText(path.join(dir, "opencode.json"), JSON.stringify({ other: true, permission }));
    const ctx = opencodeCtx(dir, { upgradePermissions: true });
    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const parsed = JSON.parse((action as { content: string }).content) as Record<string, unknown>;

    expect(parsed.other).toBe(true);
    expect(parsed.permission).toEqual(canonicalOpencodePermission());
    expect(ctx.warnings.join("\n")).not.toMatch(/differs from the stack default/);
  });

  it("up-to-date: silencioso y sin tocar", () => {
    const dir = mkTmp("jx-perm-oc-ok-");
    const [fresh] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeCtx(dir));
    const freshContent = (fresh as { content: string }).content;
    writeText(path.join(dir, "opencode.json"), freshContent);

    const ctx = opencodeCtx(dir);
    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const parsed = JSON.parse((action as { content: string }).content) as Record<string, unknown>;

    expect(parsed.permission).toEqual(canonicalOpencodePermission());
    expect((action as { content: string }).content).toBe(freshContent);
    expect(ctx.warnings.join("\n")).not.toMatch(/differs from the stack default/);
    expect(ctx.warnings.join("\n")).not.toContain("--upgrade-permissions");
  });
});

describe("permissions-upgrade: claude-code planHooks (nunca main-config)", () => {
  const makeCtx = (configDir: string, overrides: Partial<InstallContext> = {}): InstallContext => ({
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: testModelsForRuntime("claude-code"),
    warnings: [],
    ...overrides,
  });

  const run = (ctx: InstallContext) => {
    const [action] = claudeCodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), ctx);
    const content = (action as { content: string }).content;
    return { content, settings: JSON.parse(content) as Record<string, unknown> };
  };

  it.each([
    ["custom", CLAUDE_CUSTOM_PERMISSIONS],
    ["legacy", CLAUDE_LEGACY_PERMISSIONS],
  ])("sin flag: %s se preserva y avisa solo-si-difiere con --upgrade-permissions (sin dump)", (_label, permissions) => {
    const dir = mkTmp("jx-perm-cc-");
    const settingsFile = path.join(dir, "settings.json");
    writeText(settingsFile, JSON.stringify({ other: true, permissions }));
    const ctx = makeCtx(dir);
    const { settings } = run(ctx);

    expect(settings.other).toBe(true);
    expect(settings.permissions).toEqual(permissions);
    const warnings = ctx.warnings.join("\n");
    expect(warnings).toMatch(/--upgrade-permissions/);
    expect(warnings).toMatch(/backup/i);
    expect(warnings).toMatch(/discards your own permission changes/i);
    expect(warnings).not.toContain("Read(//**/.ssh/**)");
  });

  it.each([
    ["custom", CLAUDE_CUSTOM_PERMISSIONS],
    ["legacy", CLAUDE_LEGACY_PERMISSIONS],
  ])("con flag: %s se reemplaza entero por el canon preservando claves ajenas", (_label, permissions) => {
    const dir = mkTmp("jx-perm-cc-flag-");
    const settingsFile = path.join(dir, "settings.json");
    writeText(settingsFile, JSON.stringify({ other: true, permissions }));
    const ctx = makeCtx(dir, { upgradePermissions: true });
    const { settings } = run(ctx);

    expect(settings.other).toBe(true);
    expect(settings.permissions).toEqual(canonicalClaudePermissions());
    expect(ctx.warnings.join("\n")).not.toMatch(/differs from the stack default/);
  });

  it("up-to-date: silencioso y sin tocar el bloque", () => {
    const dir = mkTmp("jx-perm-cc-ok-");
    const settingsFile = path.join(dir, "settings.json");
    const fresh = run(makeCtx(dir));
    writeText(settingsFile, fresh.content);

    const ctx = makeCtx(dir);
    const { settings } = run(ctx);

    expect(settings.permissions).toEqual(canonicalClaudePermissions());
    expect(ctx.warnings.join("\n")).not.toMatch(/differs from the stack default/);
    expect(ctx.warnings.join("\n")).not.toContain("--upgrade-permissions");
  });

  it("el reseed vive en el hooks-path: main-config nunca escribe permissions", () => {
    const dir = mkTmp("jx-perm-cc-main-");
    const ctx: InstallContext = {
      stackDir: stackRoot(),
      configDir: dir,
      engramBin: null,
      models: testModelsForRuntime("claude-code"),
      warnings: [],
      upgradePermissions: true,
    };
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const parsed = JSON.parse((action as { content: string }).content) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty("permissions");
  });
});

describe("permissions-upgrade: codex planMainConfig (perfil TOML)", () => {
  it.each([
    ["custom", CODEX_CUSTOM_TOML],
    ["legacy", CODEX_LEGACY_TOML],
  ])("sin flag: %s se preserva y avisa solo-si-difiere con --upgrade-permissions (sin dump)", (_label, toml) => {
    const dir = mkTmp("jx-perm-cx-");
    writeText(path.join(dir, "config.toml"), toml);
    const ctx: InstallContext = {
      stackDir: stackRoot(),
      configDir: dir,
      engramBin: null,
      models: testModelsForRuntime("codex"),
      warnings: [],
    };
    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const content = (action as { content: string }).content;

    expect(content).toContain('sandbox_mode = "workspace-write"');
    const warnings = ctx.warnings.join("\n");
    expect(warnings).toMatch(/--upgrade-permissions/);
    expect(warnings).toMatch(/backup/i);
    expect(warnings).toMatch(/discards your own permission changes/i);
    expect(warnings).not.toContain('extends = ":workspace"');
  });

  it.each([
    ["custom", CODEX_CUSTOM_TOML],
    ["legacy", CODEX_LEGACY_TOML],
  ])("con flag: %s se reemplaza entero preservando sandbox_mode y el resto", (_label, toml) => {
    const dir = mkTmp("jx-perm-cx-flag-");
    writeText(path.join(dir, "config.toml"), toml);
    const ctx: InstallContext = {
      stackDir: stackRoot(),
      configDir: dir,
      engramBin: null,
      models: testModelsForRuntime("codex"),
      warnings: [],
      upgradePermissions: true,
    };
    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const content = (action as { content: string }).content;

    expect(content).toContain('approval_policy = "on-request"');
    expect(content).toContain('default_permissions = "jorgex-read-anywhere"');
    expect(content).toContain("[permissions.jorgex-read-anywhere]");
    expect(content).toContain('sandbox_mode = "workspace-write"');
    expect(ctx.warnings.join("\n")).not.toMatch(/--upgrade-permissions/);
  });

  it("up-to-date: silencioso", () => {
    const dir = mkTmp("jx-perm-cx-ok-");
    const freshCtx: InstallContext = {
      stackDir: stackRoot(),
      configDir: dir,
      engramBin: null,
      models: testModelsForRuntime("codex"),
      warnings: [],
    };
    const [fresh] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), freshCtx);
    writeText(path.join(dir, "config.toml"), (fresh as { content: string }).content);

    const ctx: InstallContext = {
      stackDir: stackRoot(),
      configDir: dir,
      engramBin: null,
      models: testModelsForRuntime("codex"),
      warnings: [],
    };
    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const content = (action as { content: string }).content;

    expect(content).toContain('default_permissions = "jorgex-read-anywhere"');
    expect(ctx.warnings.join("\n")).not.toMatch(/--upgrade-permissions/);
    expect(ctx.warnings.join("\n")).not.toMatch(/differs from the stack default/);
  });
});

describe("permissions-upgrade: dry-run no escribe con flag", () => {
  it("runInstall dry-run + --upgrade-permissions deja el stale intacto y no crea backups", async () => {
    await withIsolatedHome(async (_homeDir, root) => {
      const targetDir = path.join(root, "target");
      fs.mkdirSync(targetDir, { recursive: true });
      const staleFile = path.join(targetDir, "opencode.json");
      const stale = JSON.stringify({ other: true, permission: OPENCODE_CUSTOM_PERMISSION });
      fs.writeFileSync(staleFile, stale);
      fs.writeFileSync(path.join(targetDir, "writing-style.md"), "Estilo sintético de dry-run.\n");

      const install = await import("../src/install.js");
      const exitCode = await install.runInstall({
        runtimes: ["opencode"],
        targetDir,
        dryRun: true,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        engramBin: null,
        upgradePermissions: true,
        showSummary: false,
      });

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(staleFile, "utf8")).toBe(stale);
      const { listBackups } = await import("../src/lib/backup.js");
      expect(listBackups()).toEqual([]);
    });
  });
});

describe("permissions-upgrade: backup precede al reseed y restore lo revierte", () => {
  it("flagged rewrite de opencode crea backup del stale y restore lo devuelve", async () => {
    await withIsolatedHome(async (homeDir) => {
      const configDir = path.join(homeDir, ".config", "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      const target = path.join(configDir, "opencode.json");
      const stale = JSON.stringify({ other: true, permission: OPENCODE_CUSTOM_PERMISSION });
      fs.writeFileSync(target, stale);

      const install = await import("../src/install.js");
      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const originalOpencodeDetect = opencode.detect;
      const originalCodexDetect = codex.detect;
      const originalClaudeDetect = claudeCode.detect;
      opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
      claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });

      try {
        const exitCode = await install.runInstall({
          runtimes: ["opencode"],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          engramBin: null,
          upgradePermissions: true,
          showSummary: false,
        });
        expect(exitCode).toBe(0);

        const reseeded = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
        expect(reseeded.other).toBe(true);
        expect(reseeded.permission).toEqual(canonicalOpencodePermission());

        const { listBackups, restoreBackup } = await import("../src/lib/backup.js");
        const entry = listBackups()
          .flatMap((backup) => backup.files.map((file) => ({ backup, file })))
          .find(({ file }) => file.original === target);
        expect(entry, "el pipeline debe respaldar el stale antes de reescribir").toBeDefined();
        expect(fs.readFileSync(entry!.file.stored, "utf8")).toBe(stale);

        expect(restoreBackup(entry!.backup.id)).toBeGreaterThanOrEqual(1);
        expect(fs.readFileSync(target, "utf8")).toBe(stale);
      } finally {
        opencode.detect = originalOpencodeDetect;
        codex.detect = originalCodexDetect;
        claudeCode.detect = originalClaudeDetect;
      }
    });
  });
});

describe("permissions-upgrade: CLI flag end-to-end (sync --target-dir)", () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const CLI_PATH = path.join(ROOT, "src", "cli.ts");

  async function runCli(args: string[], homeDir: string): Promise<number | undefined> {
    const originalArgv = [...process.argv];
    const originalExitCode = process.exitCode;
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.exitCode = undefined;
    try {
      vi.resetModules();
      process.argv = [process.execPath, CLI_PATH, ...args];
      await import("../src/cli.js");
      return process.exitCode;
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      vi.resetModules();
    }
  }

  it("help muestra --upgrade-permissions", async () => {
    const root = mkTmp("jx-perm-help-");
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runCli(["--help"], homeDir);
      const output = log.mock.calls.flat().map(String).join("\n");
      expect(output).toContain("--upgrade-permissions");
    } finally {
      log.mockRestore();
    }
  });

  it("sync --upgrade-permissions reescribe el stale (propagación del flag)", async () => {
    const root = mkTmp("jx-perm-cli-flag-");
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    fs.mkdirSync(path.join(homeDir, ".jorgex-stack"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".jorgex-stack", "model-map.json"),
      `${JSON.stringify(TEST_MODEL_MAP, null, 2)}\n`,
    );
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "opencode.json");
    fs.writeFileSync(target, JSON.stringify({ permission: OPENCODE_CUSTOM_PERMISSION }));

    const exitCode = await runCli(
      ["sync", "--agents", "opencode", "--target-dir", targetDir, "--yes", "--upgrade-permissions"],
      homeDir,
    );

    expect(exitCode).toBe(0);
    const reseeded = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
    expect(reseeded.permission).toEqual(canonicalOpencodePermission());
  });

  it("sync sin flag preserva el stale (off por defecto end-to-end)", async () => {
    const root = mkTmp("jx-perm-cli-off-");
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    fs.mkdirSync(path.join(homeDir, ".jorgex-stack"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".jorgex-stack", "model-map.json"),
      `${JSON.stringify(TEST_MODEL_MAP, null, 2)}\n`,
    );
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "opencode.json");
    fs.writeFileSync(target, JSON.stringify({ permission: OPENCODE_CUSTOM_PERMISSION }));

    const exitCode = await runCli(
      ["sync", "--agents", "opencode", "--target-dir", targetDir, "--yes"],
      homeDir,
    );

    expect(exitCode).toBe(0);
    const preserved = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
    expect(preserved.permission).toEqual(OPENCODE_CUSTOM_PERMISSION);
  });
});
