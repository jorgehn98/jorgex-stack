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
