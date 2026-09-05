import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { CODEX_MODELS } from "../src/models-picker.js";

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

describe("DEFAULT_MODEL_MAP GPT-5.6 policy", () => {
  it("does not assume an OpenCode provider before the user selects models", () => {
    expect(DEFAULT_MODEL_MAP.opencode).toBeUndefined();
  });

  it("keeps the Codex orchestrator runtime-selected and assigns Terra/Luna to subagents", () => {
    expect(DEFAULT_MODEL_MAP.codex).toEqual({
      strong: { model: "gpt-5.6-terra", variant: "xhigh" },
      standard: { model: "gpt-5.6-terra", variant: "xhigh" },
      cheap: { model: "gpt-5.6-luna", variant: "medium" },
    });
    expect(DEFAULT_MODEL_MAP.codex.overrides).toBeUndefined();
  });

  it("offers the complete GPT-5.6 family in the curated Codex picker", () => {
    expect(CODEX_MODELS).toEqual(
      expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    );
  });
});

describe("model-map persisted state", () => {
  it("fails closed for malformed JSON without rewriting or exposing its contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-map-corrupt-"));
    const homeDir = path.join(root, "home");
    const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
    const malformed = '{"codex":\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, malformed);

    try {
      await withTempHome(homeDir, async () => {
        const { loadModelMap } = await import("../src/lib/model-map.js");
        let thrown: unknown;

        try {
          loadModelMap();
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        expect(message).toContain(file);
        expect(message).toMatch(/corrige|restaura/i);
        expect(message).not.toContain(malformed);
        expect(message).not.toMatch(/unexpected token|json\.parse/i);
        expect(fs.readFileSync(file, "utf8")).toBe(malformed);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps defaults when the file is absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-map-absent-"));
    const homeDir = path.join(root, "home");

    try {
      await withTempHome(homeDir, async () => {
        const { DEFAULT_MODEL_MAP: defaults, loadModelMap } = await import("../src/lib/model-map.js");

        expect(loadModelMap()).toEqual(defaults);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges a valid partial map and preserves named overrides", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-model-map-partial-"));
    const homeDir = path.join(root, "home");
    const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      codex: {
        strong: { model: "custom/strong", variant: "high" },
        overrides: {
          tester: { model: "custom/tester" },
          "code-reviewer": { variant: "" },
        },
      },
    }) + "\n");

    try {
      await withTempHome(homeDir, async () => {
        const { DEFAULT_MODEL_MAP: defaults, loadModelMap, resolveAgentModel } = await import("../src/lib/model-map.js");
        const models = loadModelMap().codex!;

        expect(models.standard).toEqual(defaults.codex.standard);
        expect(models.cheap).toEqual(defaults.codex.cheap);
        expect(resolveAgentModel(models, "tester", "strong")).toEqual({ model: "custom/tester", variant: "high" });
        expect(resolveAgentModel(models, "code-reviewer", "strong")).toEqual({ model: "custom/strong", variant: undefined });
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
