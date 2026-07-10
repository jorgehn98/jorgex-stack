import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { CODEX_MODELS } from "../src/models-picker.js";

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
