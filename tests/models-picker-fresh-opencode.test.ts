import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  detectOpenCode: vi.fn(() => ({
    id: "opencode",
    name: "OpenCode",
    installed: true,
    binPath: "opencode",
    configDir: "unused",
  })),
  runDetectedBin: vi.fn(() => "xai/grok-code\nzhipu/glm-code\nminimax/MiniMax-M3\n"),
}));

type PickerOption = { value: string; label: string };
type PickerQuestion = {
  message: string;
  options: PickerOption[];
};

function pickerQuestions(): PickerQuestion[] {
  return mocks.select.mock.calls.map(([question]) => question as PickerQuestion);
}

vi.mock("@clack/prompts", () => ({
  select: mocks.select,
  text: vi.fn(),
  isCancel: vi.fn(() => false),
  intro: vi.fn(),
  cancel: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../src/lib/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/detect.js")>("../src/lib/detect.js");
  return {
    ...actual,
    detectOpenCode: mocks.detectOpenCode,
    runDetectedBin: mocks.runDetectedBin,
  };
});

function setStdoutTty(): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  return () => {
    if (original === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", original);
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("fresh OpenCode model selection", () => {
  it("rejects a malformed existing map before starting selection or replacing its bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-corrupt-"));
    const homeDir = path.join(root, "home");
    const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
    const malformed = '{"opencode":\n';
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const restoreTty = setStdoutTty();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, malformed);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
      const { runModelsPicker } = await import("../src/models-picker.js");

      await expect(runModelsPicker({ yes: false, runtimes: ["opencode"] })).rejects.toThrow(/model-map|corrige|restaura/i);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, "utf8")).toBe(malformed);
    } finally {
      restoreTty();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("initializa el mapa OpenCode por defecto de forma no interactiva sin tocar catálogo ni credenciales", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-noninteractive-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
      const { runModelsPicker } = await import("../src/models-picker.js");
      const { DEFAULT_MODEL_MAP } = await import("../src/lib/model-map.js");
      await expect(runModelsPicker({ yes: true, runtimes: ["opencode"] })).resolves.toBe(0);

      const stored = JSON.parse(
        fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"),
      );
      // El default fresco vive en la fuente actual, no en una copia del test.
      expect(stored.opencode).toEqual(DEFAULT_MODEL_MAP.opencode);
      // Fresco no depende de catálogo, detección ni credenciales.
      expect(mocks.runDetectedBin).not.toHaveBeenCalled();
      expect(mocks.detectOpenCode).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("no reemplaza una selección manual existente con el default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-existing-"));
    const homeDir = path.join(root, "home");
    const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
    const manual = JSON.stringify({
      opencode: {
        strong: { model: "user/strong" },
        standard: { model: "user/standard" },
        cheap: { model: "user/cheap" },
      },
    }, null, 2) + "\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, manual);
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
      const { runModelsPicker } = await import("../src/models-picker.js");
      await expect(runModelsPicker({ yes: true, runtimes: ["opencode"] })).resolves.toBe(0);
      expect(fs.readFileSync(file, "utf8")).toBe(manual);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the first OpenCode map from connected providers by tier", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-fresh-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const restoreTty = setStdoutTty();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    mocks.select
      .mockResolvedValueOnce("tier")
      .mockResolvedValueOnce("xai/grok-code")
      .mockResolvedValueOnce("high")
      .mockResolvedValueOnce("zhipu/glm-code")
      .mockResolvedValueOnce("medium")
      .mockResolvedValueOnce("minimax/MiniMax-M3")
      .mockResolvedValueOnce("");

    try {
      const { runModelsPicker } = await import("../src/models-picker.js");
      const { DEFAULT_MODEL_MAP } = await import("../src/lib/model-map.js");
      await expect(runModelsPicker({ yes: false, runtimes: ["opencode"] })).resolves.toBe(0);

      const stored = JSON.parse(
        fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"),
      );
      const openCodeEffortOptions = pickerQuestions()
        .filter((question) => question.message.includes("OpenCode") && question.message.includes("variant"))
        .flatMap((question) => question.options.map((option) => option.value));
      // Tiers elegidos con literales propios; los overrides prellenados del
      // default se preservan (el picker no purga el mapa).
      expect(stored.opencode).toEqual({
        strong: { model: "xai/grok-code", variant: "high" },
        standard: { model: "zhipu/glm-code", variant: "medium" },
        cheap: { model: "minimax/MiniMax-M3" },
        overrides: DEFAULT_MODEL_MAP.opencode.overrides,
      });
      expect(openCodeEffortOptions).not.toContain("max");
    } finally {
      restoreTty();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("builds the first OpenCode map one subagent at a time", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-agents-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const restoreTty = setStdoutTty();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    mocks.select.mockImplementation(async (question: { message: string }) => {
      if (question.message.includes("¿cómo asignar")) return "agent";
      if (question.message.includes("— modelo")) {
        if (question.message.includes("tester (")) return "zhipu/glm-code";
        if (question.message.includes("engram (")) return "minimax/MiniMax-M3";
        return "xai/grok-code";
      }
      return "";
    });

    try {
      const { runModelsPicker } = await import("../src/models-picker.js");
      const { DEFAULT_MODEL_MAP } = await import("../src/lib/model-map.js");
      await expect(runModelsPicker({ yes: false, runtimes: ["opencode"] })).resolves.toBe(0);

      const stored = JSON.parse(
        fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"),
      );
      // Los tiers prellenados del default permanecen intactos y cada subagente
      // elegido queda como override literal (con "" limpiando el effort del tier).
      expect(stored.opencode).toEqual({
        strong: DEFAULT_MODEL_MAP.opencode.strong,
        standard: DEFAULT_MODEL_MAP.opencode.standard,
        cheap: DEFAULT_MODEL_MAP.opencode.cheap,
        overrides: {
          "codebase-analyst": { model: "xai/grok-code", variant: "" },
          "code-reviewer": { model: "xai/grok-code", variant: "" },
          "code-simplifier": { model: "xai/grok-code", variant: "" },
          "comment-fixer": { model: "xai/grok-code", variant: "" },
          "docs-maintainer": { model: "xai/grok-code", variant: "" },
          implementer: { model: "xai/grok-code", variant: "" },
          "security-auditor": { model: "xai/grok-code", variant: "" },
          "silent-failure-hunter": { model: "xai/grok-code", variant: "" },
          "test-analyzer": { model: "xai/grok-code", variant: "" },
          translator: { model: "xai/grok-code", variant: "" },
          "type-design-analyzer": { model: "xai/grok-code", variant: "" },
          engram: { model: "minimax/MiniMax-M3", variant: "" },
          tester: { model: "zhipu/glm-code", variant: "" },
        },
      });
    } finally {
      restoreTty();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});
