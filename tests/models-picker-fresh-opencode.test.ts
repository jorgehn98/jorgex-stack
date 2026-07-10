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
  it("rejects non-interactive initialization instead of writing provider defaults", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-noninteractive-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
      const { runModelsPicker } = await import("../src/models-picker.js");
      await expect(runModelsPicker({ yes: true, runtimes: ["opencode"] })).resolves.toBe(1);

      const stored = JSON.parse(
        fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"),
      );
      expect(stored.opencode).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
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
      await expect(runModelsPicker({ yes: false, runtimes: ["opencode"] })).resolves.toBe(0);

      const stored = JSON.parse(
        fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"),
      );
      expect(stored.opencode).toEqual({
        strong: { model: "xai/grok-code", variant: "high" },
        standard: { model: "zhipu/glm-code", variant: "medium" },
        cheap: { model: "minimax/MiniMax-M3" },
      });
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
      await expect(runModelsPicker({ yes: false, runtimes: ["opencode"] })).resolves.toBe(0);

      const stored = JSON.parse(
        fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"),
      );
      expect(stored.opencode).toEqual({
        strong: { model: "xai/grok-code" },
        standard: { model: "xai/grok-code" },
        cheap: { model: "xai/grok-code" },
        overrides: {
          tester: { model: "zhipu/glm-code" },
          engram: { model: "minimax/MiniMax-M3" },
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
