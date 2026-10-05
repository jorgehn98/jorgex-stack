import { describe, expect, it } from "vitest";
import { normalizeModels, listCodexModels, listPiModels } from "../src/lib/native-model-catalog.js";

describe("native catalog boundaries", () => {
  it("only exposes model IDs and accredited variants, never response metadata", () => {
    expect(normalizeModels("opencode", { data: [{ providerID: "provider", id: "model", name: "Model", variants: [{ id: "fast", headers: { private: "hidden" } }], body: { private: "hidden" } }] })).toEqual([{ id: "provider/model", name: "Model", efforts: ["fast"] }]);
    expect(normalizeModels("claude-code", [{ value: "model", displayName: "Model", supportsEffort: true }])).toEqual([{ id: "model", name: "Model" }]);
    expect(() => normalizeModels("codex", { data: "invalid" })).toThrow(/catálogo/i);
  });
  it("credits Pi thinking levels only to the active model, without probing a model switch", async () => {
    const methods: string[] = [];
    const models = await listPiModels(async (method) => {
      methods.push(method);
      if (method === "get_available_models") return { models: [{ provider: "p", id: "active", name: "Active" }, { provider: "p", id: "other", name: "Other" }] };
      if (method === "get_state") return { model: { provider: "p", id: "active" } };
      return { levels: ["off", "specific"] };
    });
    expect(models).toEqual([{ id: "p/active", name: "Active", efforts: ["off", "specific"] }, { id: "p/other", name: "Other" }]);
    expect(methods).toEqual(["get_available_models", "get_state", "get_available_thinking_levels"]);
  });
  it("paginates Codex using effective model/list, rejecting repeated cursors", async () => {
    const cursors: unknown[] = [];
    const models = await listCodexModels(async (method, params) => {
      expect(method).toBe("model/list"); cursors.push(params.cursor);
      return params.cursor ? { data: [{ model: "second", displayName: "Second", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null } : { data: [{ model: "first", displayName: "First", supportedReasoningEfforts: [] }], nextCursor: "next" };
    });
    expect(cursors).toEqual([null, "next"]);
    expect(models.map(m => m.id)).toEqual(["first", "second"]);
    await expect(listCodexModels(async () => ({ data: [], nextCursor: "same" }))).rejects.toThrow(/paginación/i);
  });
});
