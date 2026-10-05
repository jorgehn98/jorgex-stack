import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", file: "" }));
const prompts = vi.hoisted(() => ({ select: vi.fn(), text: vi.fn(), log: { warn: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@clack/prompts", () => ({ ...prompts, isCancel: (value: unknown) => typeof value === "symbol" }));
vi.mock("../src/lib/native-model-catalog.js", () => ({ discoverModels: vi.fn(async () => ({ models: [{ id: "native", name: "Native", efforts: ["specific"] }] })) }));
vi.mock("../src/install.js", async () => {
  const actual = await vi.importActual<typeof import("../src/install.js")>("../src/install.js");
  return { ...actual,
    ADAPTERS: { pi: { ...actual.ADAPTERS.pi, detect: () => ({ installed: true, binPath: "synthetic", configDir: fixture.root }) } },
    makeContext: () => ({ ownedFiles: new Set([fixture.file]) }), stateDirectory: () => fixture.root,
  };
});
import { editAgent } from "../src/models-picker.js";
import { readAgentModel } from "../src/lib/agent-model.js";
import { discoverModels } from "../src/lib/native-model-catalog.js";

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/var/tmp", "jx-t07-picker-"));
  fixture.file = path.join(fixture.root, "agents", "implementer.md");
  fs.mkdirSync(path.dirname(fixture.file));
  fs.writeFileSync(fixture.file, '---\nname: implementer\n---\nbody\n');
});
afterEach(() => { fs.rmSync(fixture.root, { recursive: true, force: true }); vi.clearAllMocks(); });
function answers(labels: string[]) {
  prompts.select.mockImplementation((question) => {
    const label = labels.shift();
    const option = question.options.find((option: { label: string }) => option.label.startsWith(label!));
    if (!option) throw new Error(`Unexpected prompt: ${question.message} / ${label}`);
    return option.value;
  });
  return labels;
}
it("saves Pi implementer immediately and visiting another agent does not discover models", async () => {
  const neighbor = path.join(fixture.root, "agents", "reviewer.md");
  fs.writeFileSync(neighbor, "untouched");
  const labels = answers(["Modelo", "Native", "Esfuerzo", "specific", "Guardar", "Volver"]);
  await editAgent("pi", "implementer", "Subagentes › Pi › implementer");
  expect(readAgentModel("pi", fixture.file).selection).toEqual({ model: "native", variant: "specific" });
  expect(discoverModels).toHaveBeenCalledOnce();
  expect(fs.readdirSync(path.join(fixture.root, "backups"))).toHaveLength(1);
  fixture.file = neighbor; fs.writeFileSync(neighbor, '---\nname: reviewer\n---\nbody\n');
  answers(["Volver"]);
  await editAgent("pi", "reviewer", "Subagentes › Pi › reviewer");
  expect(discoverModels).toHaveBeenCalledOnce();
  expect(prompts.log.error).not.toHaveBeenCalled(); expect(labels).toHaveLength(0);
});
it("requires a pending-change decision and discards without writes", async () => {
  const original = fs.readFileSync(fixture.file, "utf8");
  answers(["Modelo", "Native", "Volver", "Continuar", "Volver", "Descartar"]);
  await editAgent("pi", "implementer", "Pi › implementer");
  expect(fs.readFileSync(fixture.file, "utf8")).toBe(original);
  expect(fs.existsSync(path.join(fixture.root, "backups"))).toBe(false);
});
it("retains the draft after a save conflict and does not repeat the operation automatically", async () => {
  answers(["Modelo", "Native", "Guardar", "Volver", "Descartar"]);
  const select = prompts.select.getMockImplementation()!;
  prompts.select.mockImplementation(async (question) => {
    const result = select(question);
    if (result === "save") fs.appendFileSync(fixture.file, "external change\n");
    return result;
  });
  await editAgent("pi", "implementer", "Pi › implementer");
  expect(prompts.log.error).toHaveBeenCalledOnce();
  expect(fs.readFileSync(fixture.file, "utf8")).toContain("external change");
  expect(readAgentModel("pi", fixture.file).selection).toEqual({});
  expect(fs.existsSync(path.join(fixture.root, "backups"))).toBe(false);
});
