import { afterEach, describe, expect, it, vi } from "vitest";
const prompts = vi.hoisted(() => ({ select: vi.fn(), text: vi.fn(), log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@clack/prompts", () => ({ ...prompts, isCancel: (value: unknown) => typeof value === "symbol" }));
import { chooseAgentModel } from "../src/models-picker.js";
afterEach(() => vi.clearAllMocks());
function select(label: string) {
  prompts.select.mockImplementationOnce((question) => question.options.find((option: { label: string }) => option.label.startsWith(label)).value);
}
describe("native choices", () => {
  it("preserves an existing absent model and unknown effort when catalog is unavailable", async () => {
    select("Mantener"); select("Mantener");
    expect(await chooseAgentModel("codex", { model: "personal", variant: "personal-effort" }, { models: [], warning: "Catálogo inaccesible" })).toEqual({ model: "personal", variant: "personal-effort" });
    expect(prompts.log.warn).toHaveBeenCalledWith("Catálogo inaccesible");
    expect(prompts.select.mock.calls[1]![0].options).toHaveLength(2);
  });
  it("persists both exact model ID and accredited effort, without a generic scale", async () => {
    select("Model"); select("specific");
    expect(await chooseAgentModel("codex", {}, { models: [{ id: "exact-ID", name: "Model", efforts: ["specific"] }] })).toEqual({ model: "exact-ID", variant: "specific" });
    expect(prompts.select.mock.calls[1]![0].options.map((option: { label: string }) => option.label)).toEqual(["Mantener herencia", "Heredar — sin override de esfuerzo/variante", "specific"]);
  });
  it("represents inheritance as absence, not default/inherit aliases", async () => {
    select("Heredar"); select("Heredar");
    expect(await chooseAgentModel("pi", { model: "personal/model", variant: "unknown" }, { models: [] })).toEqual({});
  });
  it("keeps the casing of manually supplied IDs and never fabricates efforts", async () => {
    select("Introducir"); prompts.text.mockResolvedValueOnce(" Exact-ID "); select("Heredar");
    expect(await chooseAgentModel("claude-code", {}, { models: [] })).toEqual({ model: "Exact-ID" });
  });
});
