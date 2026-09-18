import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stackRoot } from "../src/lib/paths.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "../src/lib/canonical.js";
import { TEST_MODEL_MAP } from "./fixtures/model-map.js";

const logs = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: logs.intro,
  outro: logs.outro,
  log: {
    info: logs.info,
    warn: logs.warn,
    error: logs.error,
    message: logs.message,
    success: logs.success,
  },
}));

type DoctorModule = {
  runDoctor(options?: {
    targetDir?: string;
    runtimes?: ("claude-code" | "codex" | "opencode" | "pi")[];
  }): Promise<number>;
};

const STALE_FRAGMENTS = ["differs from the stack default", "--upgrade-permissions", "discards your own permission changes"];
const REMEDY_COMMAND = "jorgex-stack sync --upgrade-permissions --dry-run";

function output(): string {
  return [
    ...logs.info.mock.calls,
    ...logs.warn.mock.calls,
    ...logs.error.mock.calls,
    ...logs.message.mock.calls,
    ...logs.success.mock.calls,
    ...logs.outro.mock.calls,
  ].flat().map(String).join("\n");
}

function errorOutput(): string {
  return logs.error.mock.calls.flat().map(String).join("\n");
}

interface FakeEnv {
  root: string;
  home: string;
  restore(): void;
}

const MANAGED_ENV = ["HOME", "USERPROFILE", "ENGRAM_DATA_DIR", "OPENCODE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "ENGRAM_BIN"] as const;

/**
 * Aísla HOME y los overrides de detección. No se mockea detect.js: tras
 * resetModules el mock quedaría ligado al HOME original; en su lugar se usa
 * un binario Engram falso (ENGRAM_BIN) y un model-map real en el HOME ficticio.
 */
function fakeEnv(extra: Record<string, string> = {}): FakeEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-permissions-doctor-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const saved: Record<string, string | undefined> = {};
  for (const name of MANAGED_ENV) saved[name] = process.env[name];
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const engramBin = path.join(binDir, "engram");
  fs.writeFileSync(engramBin, '#!/bin/sh\necho "engram 1.20.0"\n');
  fs.chmodSync(engramBin, 0o755);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ENGRAM_DATA_DIR = path.join(home, ".engram");
  process.env.ENGRAM_BIN = engramBin;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.PI_CODING_AGENT_DIR;
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  return {
    root,
    home,
    restore() {
      for (const name of MANAGED_ENV) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const key of Object.keys(extra)) {
        if (!(MANAGED_ENV as readonly string[]).includes(key)) delete process.env[key];
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Model-map completo (incluye opencode) para que makeContext no omita runtimes. */
function writeModelMap(home: string): void {
  const dir = path.join(home, ".jorgex-stack");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "model-map.json"), JSON.stringify(TEST_MODEL_MAP));
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function freshDoctor(): Promise<DoctorModule> {
  vi.resetModules();
  return (await import("../src/doctor.js")) as unknown as DoctorModule;
}

function makeCtx(id: "opencode" | "claude-code" | "codex", configDir: string) {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: TEST_MODEL_MAP[id]!,
    warnings: [] as string[],
  };
}

/** Contenido canónico fresco generado por el propio adapter (sin duplicar el canon). */
async function freshOpencodeContent(configDir: string): Promise<string> {
  const { opencodeAdapter } = await import("../src/adapters/opencode.js");
  const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx("opencode", configDir));
  return (action as { content: string }).content;
}

async function freshClaudeSettings(configDir: string): Promise<string> {
  const { claudeCodeAdapter } = await import("../src/adapters/claude-code.js");
  const actions = claudeCodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), makeCtx("claude-code", configDir));
  const write = actions.find((action) => action.kind === "write" && action.target.endsWith("settings.json"));
  if (write === undefined || write.kind !== "write") throw new Error("planHooks fresco sin settings.json");
  return write.content;
}

async function freshCodexContent(configDir: string): Promise<string> {
  const { codexAdapter } = await import("../src/adapters/codex.js");
  const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx("codex", configDir));
  return (action as { content: string }).content;
}

describe("doctor: aviso stale de permisos (T03)", () => {
  it("opencode stale avisa con el comando exacto y no vuelca el bloque", async () => {
    const canary = "do-not-print-canary-opencode-7f3a9c";
    const env = fakeEnv();
    const oc = path.join(env.root, "oc");
    fs.mkdirSync(oc, { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = oc;
    writeModelMap(env.home);
    try {
      const fresh = JSON.parse(await freshOpencodeContent(oc)) as Record<string, unknown>;
      const permission = fresh.permission as Record<string, unknown>;
      (permission.bash as Record<string, string>).format = "ask";
      permission.canary_probe = canary;
      const before = JSON.stringify({ ...fresh, permission }, null, 2);
      fs.writeFileSync(path.join(oc, "opencode.json"), before);

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ runtimes: ["opencode"] });
      const text = output();

      expect(exitCode).toBe(1);
      for (const fragment of [...STALE_FRAGMENTS, REMEDY_COMMAND]) expect(text).toContain(fragment);
      expect(text).toContain("OpenCode: permission block differs");
      expect(text).not.toContain(canary);
      expect(text).not.toContain("canary_probe");
      expect(fs.readFileSync(path.join(oc, "opencode.json"), "utf8")).toBe(before);
    } finally {
      env.restore();
    }
  });

  it("claude stale avisa con el comando exacto y no vuelca el bloque", async () => {
    const canary = "do-not-print-canary-claude-4b1e22";
    const env = fakeEnv();
    writeModelMap(env.home);
    try {
      const claudeDir = path.join(env.home, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      const fresh = JSON.parse(await freshClaudeSettings(claudeDir)) as Record<string, unknown>;
      const permissions = fresh.permissions as { allow: unknown[] };
      permissions.allow = [...permissions.allow, canary];
      const before = JSON.stringify({ ...fresh, permissions });
      fs.writeFileSync(path.join(claudeDir, "settings.json"), before);

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ runtimes: ["claude-code"] });
      const text = output();

      expect(exitCode).toBe(1);
      for (const fragment of [...STALE_FRAGMENTS, REMEDY_COMMAND]) expect(text).toContain(fragment);
      expect(text).toContain("Claude Code: permission block differs");
      expect(text).not.toContain(canary);
      expect(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")).toBe(before);
    } finally {
      env.restore();
    }
  });

  it("codex stale avisa con el comando exacto y no vuelca el bloque", async () => {
    const canary = "do-not-print-canary-codex-9d5c71";
    const env = fakeEnv();
    const dir = path.join(env.root, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    process.env.CODEX_HOME = dir;
    writeModelMap(env.home);
    try {
      const fresh = await freshCodexContent(dir);
      const before = `${fresh.replace('default_permissions = "jorgex-read-anywhere"', 'default_permissions = "custom"').trim()}\ncanary_probe = "${canary}"\n`;
      fs.writeFileSync(path.join(dir, "config.toml"), before);

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ runtimes: ["codex"] });
      const text = output();

      expect(exitCode).toBe(1);
      for (const fragment of [...STALE_FRAGMENTS, REMEDY_COMMAND]) expect(text).toContain(fragment);
      expect(text).toContain("Codex CLI: permission block differs");
      expect(text).not.toContain(canary);
      expect(fs.readFileSync(path.join(dir, "config.toml"), "utf8")).toBe(before);
    } finally {
      env.restore();
    }
  });

  it.each([
    ["opencode", "OPENCODE_CONFIG_DIR", "oc", "opencode.json"],
    ["claude-code", null, ".claude", "settings.json"],
    ["codex", "CODEX_HOME", ".codex", "config.toml"],
  ] as const)("config al día (%s) no emite aviso de permisos", async (id, envVar, dirName, fileName) => {
    const env = fakeEnv();
    try {
      const dir = envVar === null ? path.join(env.home, dirName) : path.join(env.root, dirName);
      fs.mkdirSync(dir, { recursive: true });
      if (envVar !== null) process.env[envVar] = dir;
      writeModelMap(env.home);
      const fresh = id === "opencode"
        ? await freshOpencodeContent(dir)
        : id === "claude-code"
          ? await freshClaudeSettings(dir)
          : await freshCodexContent(dir);
      fs.writeFileSync(path.join(dir, fileName), fresh);

      const doctor = await freshDoctor();
      await doctor.runDoctor({ runtimes: [id] });
      const text = output();

      expect(text).not.toContain("differs from the stack default");
      expect(text).not.toContain("--upgrade-permissions");
    } finally {
      env.restore();
    }
  });
});

describe("doctor: Pi solo-diagnóstico (T03)", () => {
  async function silentStyleTarget(): Promise<{ env: FakeEnv; targetDir: string }> {
    const env = fakeEnv();
    const targetDir = path.join(env.root, "target");
    fs.mkdirSync(targetDir, { recursive: true });
    const { prepareWritingStyle, applyWritingStyle } = await import("../src/lib/writing-style.js");
    const { upsertMarkdownSection } = await import("../src/lib/filemerge.js");
    const source = path.join(targetDir, "writing-style.md");
    fs.writeFileSync(source, "nota privada\n");
    const plan = prepareWritingStyle(source, { rootDir: targetDir });
    applyWritingStyle(plan);
    const piAgent = path.join(targetDir, "pi-agent");
    fs.mkdirSync(piAgent, { recursive: true });
    fs.writeFileSync(
      path.join(piAgent, "AGENTS.md"),
      upsertMarkdownSection("# Instrucción ajena\n", "writing-style", plan.content),
    );
    return { env, targetDir };
  }

  it("policy sin ownership avisa (warn-only), no toca nada y no ofrece el flag", async () => {
    const canary = "do-not-print-canary-pi-2e6a18";
    const { env, targetDir } = await silentStyleTarget();
    try {
      const policyDir = path.join(targetDir, "pi-agent", "extensions", "pi-permission-system");
      fs.mkdirSync(policyDir, { recursive: true });
      const configFile = path.join(policyDir, "config.json");
      const before = JSON.stringify({ permission: { read: "ask", canary_probe: canary } });
      fs.writeFileSync(configFile, before);

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["pi"] });
      const text = output();

      expect(exitCode).toBe(1);
      expect(text).toContain("Pi: permission policy present without package ownership");
      expect(text).toContain("Stack never rewrites Pi state");
      expect(text).toContain("sync --agents pi");
      expect(text).not.toContain("--upgrade-permissions");
      expect(text).not.toContain(canary);
      expect(fs.readFileSync(configFile, "utf8")).toBe(before);
      expect(fs.existsSync(path.join(targetDir, "pi-agent", "jorgex-pi", "permissions-lifecycle.v1.json"))).toBe(false);
    } finally {
      env.restore();
    }
  });

  it("policy con receipt queda en silencio", async () => {
    const { env, targetDir } = await silentStyleTarget();
    try {
      const policyDir = path.join(targetDir, "pi-agent", "extensions", "pi-permission-system");
      const receiptDir = path.join(targetDir, "pi-agent", "jorgex-pi");
      fs.mkdirSync(policyDir, { recursive: true });
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(path.join(policyDir, "config.json"), JSON.stringify({ permission: {} }));
      fs.writeFileSync(path.join(receiptDir, "permissions-lifecycle.v1.json"), JSON.stringify({ schemaVersion: 1 }));

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["pi"] });
      const text = output();

      expect(exitCode).toBe(0);
      expect(text).not.toContain("permission policy");
    } finally {
      env.restore();
    }
  });

  it("policy inválida mantiene semántica de error y no escribe", async () => {
    const { env, targetDir } = await silentStyleTarget();
    try {
      const policyDir = path.join(targetDir, "pi-agent", "extensions", "pi-permission-system");
      fs.mkdirSync(policyDir, { recursive: true });
      const configFile = path.join(policyDir, "config.json");
      fs.writeFileSync(configFile, "INVALID JSON{{{");

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["pi"] });
      const text = output();

      expect(exitCode).toBe(1);
      expect(errorOutput()).toContain("not valid JSON");
      expect(text).not.toContain("--upgrade-permissions");
      expect(fs.readFileSync(configFile, "utf8")).toBe("INVALID JSON{{{");
    } finally {
      env.restore();
    }
  });

  it("estado ilegible mantiene semántica de error", async () => {
    const { env, targetDir } = await silentStyleTarget();
    try {
      const configFile = path.join(targetDir, "pi-agent", "extensions", "pi-permission-system", "config.json");
      fs.mkdirSync(configFile, { recursive: true });

      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["pi"] });
      const text = output();

      expect(exitCode).toBe(1);
      expect(errorOutput()).toContain("cannot read permission state");
      expect(text).not.toContain("--upgrade-permissions");
      expect(fs.statSync(configFile).isDirectory()).toBe(true);
    } finally {
      env.restore();
    }
  });

  it("sin estado Pi queda en silencio", async () => {
    const { env, targetDir } = await silentStyleTarget();
    try {
      const doctor = await freshDoctor();
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["pi"] });

      expect(exitCode).toBe(0);
      expect(output()).not.toContain("permission policy");
    } finally {
      env.restore();
    }
  });
});
