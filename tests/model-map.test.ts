import { afterEach, describe, expect, it, vi } from "vitest";

const modelMapStorage = vi.hoisted(() => ({
  raw: null as string | null,
  writeText: vi.fn(),
}));

vi.mock("../src/lib/fsx.js", () => ({
  readTextIfExists: () => modelMapStorage.raw,
  writeText: modelMapStorage.writeText,
}));

import { DEFAULT_MODEL_MAP, loadModelMap } from "../src/lib/model-map.js";
import { CODEX_MODELS } from "../src/models-picker.js";

const FRESH_CODEX_DEFAULTS = {
  strong: { model: "gpt-6-astra", variant: "max" },
  standard: { model: "gpt-5.6-sol", variant: "medium" },
  cheap: { model: "gpt-5.6-luna", variant: "medium" },
  overrides: {
    implementer: { model: "gpt-5.6-luna", variant: "max" },
    tester: { model: "gpt-5.6-luna", variant: "max" },
    "silent-failure-hunter": { model: "gpt-5.6-sol", variant: "medium" },
  },
};

afterEach(() => {
  modelMapStorage.raw = null;
  modelMapStorage.writeText.mockClear();
});

describe("DEFAULT_MODEL_MAP GPT-5.6 policy", () => {
  it("does not assume an OpenCode provider before the user selects models", () => {
    expect(DEFAULT_MODEL_MAP.opencode).toBeUndefined();
  });

  it("keeps the Codex orchestrator runtime-selected and assigns the approved defaults to fresh subagents", () => {
    expect(loadModelMap().codex).toEqual(FRESH_CODEX_DEFAULTS);
  });

  it("fills a missing Codex runtime with fresh defaults without changing saved Claude or OpenCode maps", () => {
    const savedClaude = {
      strong: { model: "user/claude-strong" },
      standard: { model: "user/claude-standard" },
      cheap: { model: "user/claude-cheap" },
    };
    const savedOpenCode = {
      strong: { model: "provider/strong", variant: "high" },
      standard: { model: "provider/standard", variant: "medium" },
      cheap: { model: "provider/cheap" },
    };
    modelMapStorage.raw = JSON.stringify({ "claude-code": savedClaude, opencode: savedOpenCode });

    const loaded = loadModelMap();
    expect(loaded.codex).toEqual(FRESH_CODEX_DEFAULTS);
    expect(loaded["claude-code"]).toEqual(savedClaude);
    expect(loaded.opencode).toEqual(savedOpenCode);
  });

  it("preserves a saved Codex selection without injecting new agent overrides", () => {
    const savedCodex = {
      strong: { model: "user/strong", variant: "high" },
      standard: { model: "user/standard", variant: "medium" },
      cheap: { model: "user/cheap", variant: "low" },
    };
    modelMapStorage.raw = JSON.stringify({ codex: savedCodex });

    expect(loadModelMap().codex).toEqual(savedCodex);
    expect(modelMapStorage.writeText).not.toHaveBeenCalled();
  });

  it("keeps explicit saved Codex overrides exact instead of adding fresh defaults", () => {
    const savedCodex = {
      strong: { model: "user/strong", variant: "high" },
      standard: { model: "user/standard", variant: "medium" },
      cheap: { model: "user/cheap", variant: "low" },
      overrides: {
        implementer: { model: "user/implementer", variant: "xhigh" },
        "custom-agent": { model: "user/custom" },
      },
    };
    modelMapStorage.raw = JSON.stringify({ codex: savedCodex });

    expect(loadModelMap().codex).toEqual(savedCodex);
  });

  it("fills only missing saved Codex tiers without adding fresh overrides", () => {
    const savedStrong = { model: "user/strong", variant: "high" };
    modelMapStorage.raw = JSON.stringify({ codex: { strong: savedStrong } });

    expect(loadModelMap().codex).toEqual({
      strong: savedStrong,
      standard: FRESH_CODEX_DEFAULTS.standard,
      cheap: FRESH_CODEX_DEFAULTS.cheap,
    });
  });

  it("offers Astra and the complete GPT-5.6 family in the curated Codex picker", () => {
    expect(CODEX_MODELS).toEqual(
      expect.arrayContaining(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    );
  });
});
