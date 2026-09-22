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

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
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

const REAL_OPENCODE_TS = [
  "// official engram setup opencode (same path, real markers)",
  "const url = CONFIGURED_ENGRAM_URL;",
  "async function ensureLocalReady() { return true; }",
  "const tools = SESSION_ATTRIBUTED_WRITE_TOOLS;",
  "function canonicalEngramToolName() { return 'engram'; }",
  "const id = localInstanceID;",
  "",
].join("\n");

describe("[doctor-runtimes] incomplete selected installed runtime is unhealthy", () => {
  it("opencode installed with custom configDir and incomplete setup → nonzero, outro not healthy", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-doc-rt-"));
    const homeDir = path.join(tmp, "home");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = TEST_MODEL_MAP;
        const bin = path.join(homeDir, ".local", "bin", "engram");
        mocks.detectEngram.mockReturnValue(bin);
        mocks.runDetectedBin.mockReturnValue("1.20.0");
        const customDir = path.join(homeDir, "custom-opencode");
        fs.mkdirSync(path.join(customDir, "plugins"), { recursive: true });
        fs.writeFileSync(path.join(customDir, "plugins", "engram.ts"), "// legacy\n");
        fs.writeFileSync(path.join(customDir, "opencode.json"), JSON.stringify({ mcp: {} }));

        const install = await import("../src/install.js");
        const { runDoctor } = await import("../src/doctor.js");
        const opencode = install.ADAPTERS.opencode!;
        const codex = install.ADAPTERS.codex!;
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const o = opencode.detect;
        const c = codex.detect;
        const cc = claudeCode.detect;
        opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir: customDir });
        codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
        claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });
        try {
          const code = await runDoctor({ runtimes: ["opencode"] });
          expect(code).not.toBe(0);
          const outro = mocks.prompts.outro.mock.calls.flat().join("\n");
          expect(outro).not.toMatch(/todo sano/i);
          const logs = [
            ...mocks.prompts.log.info.mock.calls.flat(),
            ...mocks.prompts.log.warn.mock.calls.flat(),
            ...mocks.prompts.log.error.mock.calls.flat(),
          ].join("\n");
          expect(logs).toMatch(/setup|exposure/i);
          expect(logs).toMatch(/custom-opencode/);
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

  it("healthy control: complete official setup in custom dir → no official problem", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-doc-rt-ok-"));
    const homeDir = path.join(tmp, "home");
    try {
      await withTempHome(homeDir, async () => {
        mocks.modelMapOverride = { opencode: OPEN_CODE_TEST_MODELS };
        const bin = path.join(homeDir, ".local", "bin", "engram");
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, "#!/bin/sh\n");
        mocks.detectEngram.mockReturnValue(bin);
        mocks.runDetectedBin.mockReturnValue("1.20.0");
        const customDir = path.join(homeDir, "custom-opencode");
        fs.mkdirSync(path.join(customDir, "plugins"), { recursive: true });
        fs.writeFileSync(path.join(customDir, "plugins", "engram.ts"), REAL_OPENCODE_TS);
        fs.writeFileSync(
          path.join(customDir, "opencode.json"),
          JSON.stringify({
            mcp: { engram: { type: "local", command: [bin, "mcp", "--tools=agent"] } },
            statusline: { command: "engram statusline" },
          }),
        );

        const install = await import("../src/install.js");
        const { runDoctor } = await import("../src/doctor.js");
        const opencode = install.ADAPTERS.opencode!;
        const codex = install.ADAPTERS.codex!;
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const o = opencode.detect;
        const c = codex.detect;
        const cc = claudeCode.detect;
        opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir: customDir });
        codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
        claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });
        try {
          // Stack al día: siembra mínima para que el diff no sume problemas.
          await install.runInstall({ runtimes: ["opencode"], dryRun: false, yes: true, mode: { mode: "human", subagentConcurrency: "serial" } });
          vi.clearAllMocks();
          mocks.detectEngram.mockReturnValue(bin);
          mocks.runDetectedBin.mockReturnValue("1.20.0");
          const code = await runDoctor({ runtimes: ["opencode"] });
          const logs = [
            ...mocks.prompts.log.info.mock.calls.flat(),
            ...mocks.prompts.log.warn.mock.calls.flat(),
            ...mocks.prompts.log.error.mock.calls.flat(),
          ].join("\n");
          expect(logs).toMatch(/setup|exposure/i);
          // Sin problemas oficiales; el exit depende solo del resto del estado.
          expect(logs).not.toMatch(/setup oficial Engram incompleto/i);
          void code;
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

// ---------------------------------------------------------------------------
// T41-RED: doctor Pi distingue binary/setup/runtime (fail-closed, solo lectura).
// Contrato: binario Engram (found/path/version) vs setup oficial Pi
// (singleton gentle-engram + pi-mcp-adapter + mcpServers.engram válido,
// versiones observadas sin pin) vs runtime Pi (exposición/doctor del paquete).
// Ausente/duplicado/inválido/ilegible/parcial falla cerrado con razón
// diagnóstica distinta por capa; nunca ejecuta setup ni escribe.
// Temporales aislados; cero HOME real/red.
// ---------------------------------------------------------------------------

describe("[T41-RED] doctor Pi distingue binary/setup/runtime", () => {
  it("expone bin, setup pi y exposure pi como capas distintas en filesystem aislado", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t41-doc-pi-"));
    const homeDir = path.join(tmp, "home");
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      const bin = path.join(homeDir, ".local", "bin", "engram");
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      // Binario aislado que responde --version (capa bin exige versión legible).
      fs.writeFileSync(bin, "#!/bin/sh\necho 2.0.0\n");
      try { fs.chmodSync(bin, 0o755); } catch { /* best-effort en tmp */ }
      const piAgentDir = path.join(homeDir, ".pi", "agent");
      fs.mkdirSync(piAgentDir, { recursive: true });

      const { resolveEngramOfficialState } = await import("../src/doctor.js") as any;
      expect(typeof resolveEngramOfficialState, "falta doctor oficial Pi por capas (T41)").toBe("function");

      const state = await resolveEngramOfficialState({ homeDir });
      expect(Object.keys(state)).toEqual(expect.arrayContaining(["bin", "setup", "exposure"]));
      // Pi debe aparecer como runtime propio, distinto de claude/codex/opencode.
      expect(state.setup.runtimes).toHaveProperty("pi");
      expect(state.exposure.runtimes).toHaveProperty("pi");
      // Capas distinguibles: binario presente pero setup Pi ausente => no expuesto.
      expect(state.bin.found).toBe(true);
      expect(state.setup.runtimes.pi.ok).toBe(false);
      expect(state.exposure.runtimes.pi.exposed).toBe(false);
      expect(JSON.stringify(state.setup.runtimes.pi)).toMatch(/pi|setup|singleton|mcp|package/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("setup Pi parcial/ilegible falla cerrado con razón de setup, sin confundirla con binario", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t41-doc-pi-partial-"));
    const homeDir = path.join(tmp, "home");
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      const bin = path.join(homeDir, ".local", "bin", "engram");
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, "#!/bin/sh\necho 2.0.0\n");
      try { fs.chmodSync(bin, 0o755); } catch { /* best-effort en tmp */ }
      const piAgentDir = path.join(homeDir, ".pi", "agent");
      fs.mkdirSync(piAgentDir, { recursive: true });
      // Parcial canónico: settings con solo npm:gentle-engram (falta
      // npm:pi-mcp-adapter + mcp.json). Fuente Pi: string u objeto con source.
      fs.writeFileSync(
        path.join(piAgentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:gentle-engram@0.1.99"] }),
      );
      // Ilegible: directorio donde el verificador espera el MCP exacto
      // (mcp.json canónico de `engram setup pi`).
      fs.mkdirSync(path.join(piAgentDir, "mcp.json"));

      const { resolveEngramOfficialState } = await import("../src/doctor.js") as any;
      const state = await resolveEngramOfficialState({ homeDir });

      expect(state.bin.found).toBe(true);
      expect(state.setup.runtimes.pi.ok).toBe(false);
      expect(state.exposure.runtimes.pi.exposed).toBe(false);
      const detail = JSON.stringify(state.setup.runtimes.pi);
      expect(detail).toMatch(/partial|singleton|duplicate|invalid|unreadable|mcp|package/i);
      // La razón de setup no debe culpar al binario cuando este existe.
      expect(detail).not.toMatch(/binario.*no detectado|NO detectado/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no ejecuta setup ni escribe durante el diagnóstico Pi", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t41-doc-pi-readonly-"));
    const homeDir = path.join(tmp, "home");
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      const before = new Set(fs.readdirSync(tmp));

      const { resolveEngramOfficialState } = await import("../src/doctor.js") as any;
      await resolveEngramOfficialState({ homeDir });

      expect(new Set(fs.readdirSync(tmp))).toEqual(before);
      expect(fs.existsSync(path.join(homeDir, ".jorgex-stack"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T50-RED: doctor honra PI_CODING_AGENT_DIR efectivo del runtime.
// Contrato: resolveEngramOfficialState usa el mismo PI_CODING_AGENT_DIR
// efectivo que el runtime (env explícito, por defecto <home>/.pi/agent);
// nunca lee el default cuando el env apunta a otro dir aislado.
// Temporales aislados; env restaurado; cero HOME real.
// ---------------------------------------------------------------------------

function t50SeedValidPi(piAgentDir: string, engramBin: string): void {
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5"] }),
  );
  fs.writeFileSync(
    path.join(piAgentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }),
  );
}

function t50SeedBin(homeDir: string): string {
  const bin = path.join(homeDir, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\necho 2.0.0\n");
  try { fs.chmodSync(bin, 0o755); } catch { /* best-effort en tmp */ }
  return bin;
}

describe("[T50-RED] doctor Pi honra PI_CODING_AGENT_DIR", () => {
  it("usa el dir efectivo del env aunque el default esté ausente/inválido", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-doc-pi-env-"));
    const homeDir = path.join(tmp, "home");
    const customDir = path.join(tmp, "custom-pi-agent");
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      const bin = t50SeedBin(homeDir);
      t50SeedValidPi(customDir, bin);
      // Default deliberadamente ausente: solo el env es válido.
      expect(fs.existsSync(path.join(homeDir, ".pi", "agent", "settings.json"))).toBe(false);
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = customDir;
      try {
        const { resolveEngramOfficialState } = await import("../src/doctor.js") as any;
        expect(typeof resolveEngramOfficialState, "falta doctor Pi con env (T50)").toBe("function");
        const state = await resolveEngramOfficialState({ homeDir });
        expect(state.bin.found).toBe(true);
        expect(state.setup.runtimes.pi.ok, "doctor debe leer PI_CODING_AGENT_DIR efectivo, no el default").toBe(true);
        expect(state.exposure.runtimes.pi.exposed).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("nunca lee el default cuando el env apunta a un setup parcial", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-doc-pi-env-partial-"));
    const homeDir = path.join(tmp, "home");
    const customDir = path.join(tmp, "custom-pi-partial");
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      const bin = t50SeedBin(homeDir);
      // Default válido que no debe leerse cuando el env es efectivo.
      t50SeedValidPi(path.join(homeDir, ".pi", "agent"), bin);
      // Env parcial: falta adapter + mcp exacto.
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.99"] }));
      fs.writeFileSync(path.join(customDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = customDir;
      try {
        const { resolveEngramOfficialState } = await import("../src/doctor.js") as any;
        const state = await resolveEngramOfficialState({ homeDir });
        expect(state.bin.found).toBe(true);
        expect(state.setup.runtimes.pi.ok, "doctor debe fallar por el env parcial, no pasar por el default").toBe(false);
        expect(state.exposure.runtimes.pi.exposed).toBe(false);
        expect(JSON.stringify(state.setup.runtimes.pi)).toMatch(/pi|singleton|mcp|package|partial|missing/i);
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
