import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  text: vi.fn(),
  detectCodex: vi.fn(() => ({
    id: "codex",
    name: "Codex CLI",
    installed: true,
    binPath: "codex",
    configDir: "unused",
  })),
}));

type PickerOption = { value: string; label: string };
type PickerQuestion = {
  message: string;
  options: PickerOption[];
  initialValue?: string;
};

function pickerQuestions(): PickerQuestion[] {
  return mocks.select.mock.calls.map(([question]) => question as PickerQuestion);
}

function requiredPickerQuestion(
  questions: PickerQuestion[],
  matches: (question: PickerQuestion) => boolean,
): PickerQuestion {
  const question = questions.find(matches);
  if (!question) throw new Error("Expected picker question was not asked");
  return question;
}

vi.mock("@clack/prompts", () => ({
  select: mocks.select,
  text: mocks.text,
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
  return { ...actual, detectCodex: mocks.detectCodex };
});

function setStdoutTty(): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  return () => {
    if (original === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", original);
  };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-picker-codex-"));
  const homeDir = path.join(root, "home");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const restoreTty = setStdoutTty();
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    await run(homeDir);
  } finally {
    restoreTty();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Codex model picker", () => {
  it("offers Astra and max as selectable Codex values", async () => {
    await withTempHome(async (homeDir) => {
      mocks.select.mockImplementation(async (question: { message: string }) => {
        if (question.message.includes("¿cómo asignar")) return "tier";
        if (question.message.endsWith("— modelo")) return "gpt-6-astra";
        if (question.message.includes("reasoning effort")) return "max";
        throw new Error(`Unexpected picker prompt: ${question.message}`);
      });

      const { runModelsPicker } = await import("../src/models-picker.js");
      await expect(runModelsPicker({ yes: false, runtimes: ["codex"] })).resolves.toBe(0);

      const prompts = pickerQuestions();
      const effortPrompt = requiredPickerQuestion(
        prompts,
        (question) => question.message.includes("tier strong") && question.message.includes("reasoning effort"),
      );
      const modelPrompt = requiredPickerQuestion(
        prompts,
        (question) => question.message.includes("tier strong") && question.message.endsWith("— modelo"),
      );
      expect(effortPrompt.options.map((option) => option.value)).toContain("max");
      expect(modelPrompt.options.map((option) => option.value)).toContain("gpt-6-astra");
      expect(prompts.indexOf(modelPrompt)).toBeLessThan(prompts.indexOf(effortPrompt));

      const stored = JSON.parse(fs.readFileSync(path.join(homeDir, ".jorgex-stack", "model-map.json"), "utf8"));
      expect(stored.codex).toEqual({
        strong: { model: "gpt-6-astra", variant: "max" },
        standard: { model: "gpt-6-astra", variant: "max" },
        cheap: { model: "gpt-6-astra", variant: "max" },
        overrides: {
          implementer: { model: "gpt-5.6-luna", variant: "max" },
          tester: { model: "gpt-5.6-luna", variant: "max" },
          "silent-failure-hunter": { model: "gpt-5.6-sol", variant: "medium" },
        },
      });
    });
  });

  it("keeps a current Codex effort that is not in the curated list", async () => {
    await withTempHome(async (homeDir) => {
      const savedCodex = {
        strong: { model: "gpt-6-astra", variant: "ultra" },
        standard: { model: "gpt-5.6-sol", variant: "medium" },
        cheap: { model: "gpt-5.6-luna", variant: "medium" },
      };
      const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ codex: savedCodex }) + "\n");

      mocks.select.mockImplementation(async (question: { message: string; initialValue?: string }) => {
        if (question.message.includes("¿cómo asignar")) return "tier";
        if (question.message.endsWith("— modelo") || question.message.includes("reasoning effort")) {
          return question.initialValue!;
        }
        throw new Error(`Unexpected picker prompt: ${question.message}`);
      });

      const { runModelsPicker } = await import("../src/models-picker.js");
      await expect(runModelsPicker({ yes: false, runtimes: ["codex"] })).resolves.toBe(0);

      const strongEffortPrompt = requiredPickerQuestion(
        pickerQuestions(),
        (question) => question.message.includes("tier strong") && question.message.includes("reasoning effort"),
      );
      expect(strongEffortPrompt.initialValue).toBe("ultra");
      expect(strongEffortPrompt.options.map((option) => option.value)).toContain("ultra");

      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(stored.codex).toEqual(savedCodex);
    });
  });

  it("does not offer max or keep an unknown effort after changing to a legacy model", async () => {
    await withTempHome(async (homeDir) => {
      const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        codex: {
          strong: { model: "gpt-5.5", variant: "ultra" },
          standard: { model: "gpt-5.6-sol", variant: "medium" },
          cheap: { model: "gpt-5.6-luna", variant: "medium" },
        },
      }) + "\n");

      mocks.select.mockImplementation(async (question: { message: string; initialValue?: string }) => {
        if (question.message.includes("¿cómo asignar")) return "tier";
        if (question.message.includes("tier strong") && question.message.endsWith("— modelo")) return "gpt-5.4";
        if (question.message.includes("tier strong") && question.message.includes("reasoning effort")) return "medium";
        if (question.message.endsWith("— modelo") || question.message.includes("reasoning effort")) {
          return question.initialValue!;
        }
        throw new Error(`Unexpected picker prompt: ${question.message}`);
      });

      const { runModelsPicker } = await import("../src/models-picker.js");
      await expect(runModelsPicker({ yes: false, runtimes: ["codex"] })).resolves.toBe(0);

      const legacyEffortPrompt = requiredPickerQuestion(
        pickerQuestions(),
        (question) => question.message.includes("tier strong") && question.message.includes("reasoning effort"),
      );
      const effortValues = legacyEffortPrompt.options.map((option) => option.value);
      expect(legacyEffortPrompt.initialValue).toBe("medium");
      expect(effortValues).not.toContain("max");
      expect(effortValues).not.toContain("ultra");

      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(stored.codex.strong).toEqual({ model: "gpt-5.4", variant: "medium" });
    });
  });
});
