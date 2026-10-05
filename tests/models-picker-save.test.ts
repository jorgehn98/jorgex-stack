import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ root: "", file: "" }));
const prompts = vi.hoisted(() => ({ select: vi.fn(), text: vi.fn(), intro: vi.fn(), log: { warn: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@clack/prompts", () => ({ ...prompts, isCancel: (value: unknown) => typeof value === "symbol" }));
vi.mock("../src/lib/native-model-catalog.js", () => ({ discoverModels: vi.fn(async () => ({ models: [{ id: "native", name: "Native", efforts: ["specific"] }] })) }));
vi.mock("../src/install.js", async () => {
  const actual = await vi.importActual<typeof import("../src/install.js")>("../src/install.js");
  return { ...actual,
    ADAPTERS: { codex: { ...actual.ADAPTERS.codex, detect: () => ({ installed: true, binPath: "synthetic", configDir: fixture.root }) } },
    makeContext: () => ({ ownedFiles: new Set([fixture.file]) }), stateDirectory: () => fixture.root,
  };
});
import { runModelsPicker } from "../src/models-picker.js";
import { readAgentModel } from "../src/lib/agent-model.js";
import { discoverModels } from "../src/lib/native-model-catalog.js";

it("saves one agent immediately, then returns through both lists without undo or another discovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-picker-save-"));
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    fixture.root = root; fixture.file = path.join(root, "agents", "implementer.toml");
    fs.mkdirSync(path.dirname(fixture.file));
    fs.writeFileSync(fixture.file, 'name = "implementer"\ndeveloper_instructions = "body"\n');
    const neighbor = path.join(root, "agents", "reviewer.toml"); fs.writeFileSync(neighbor, "untouched");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const labels = ["Codex", "implementer", "Native", "specific", "Guardar", "Volver", "Volver"];
    prompts.select.mockImplementation((question) => {
      const label = labels.shift();
      return question.options.find((option: { label: string }) => option.label.startsWith(label!)).value;
    });
    expect(await runModelsPicker({ yes: false, runtimes: ["codex"] })).toBe(0);
    expect(readAgentModel("codex", fixture.file).selection).toEqual({ model: "native", variant: "specific" });
    expect(fs.readFileSync(neighbor, "utf8")).toBe("untouched");
    expect(discoverModels).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(root, "backups"))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "model-map.json"))).toBe(false);
    expect(prompts.log.error).not.toHaveBeenCalled();
    expect(labels).toHaveLength(0);
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
