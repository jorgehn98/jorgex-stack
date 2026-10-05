import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runDoctor } from "../src/doctor.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@clack/prompts", () => ({ log: logs }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-writing-style-doctor-"); vi.clearAllMocks(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const options = () => ({ targetDir: root, runtimes: ["codex" as const], scope: { section: "config" as const } });
const output = () => [...logs.info.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls].flat().join("\n");
async function install() {
  expect(await runInstall({ ...options(), dryRun: false, yes: true })).toBe(0);
  vi.clearAllMocks();
}

describe("doctor de estilo en configuración nativa", () => {
  it("compara la fuente y proyección sin escribir ni mostrar notas personales", async () => {
    fs.writeFileSync(path.join(root, "writing-style.md"), "Nota privada sintética\n");
    await install();
    const files = [path.join(root, "writing-style.md"), path.join(root, "codex", "AGENTS.md")];
    const before = files.map((file) => fs.readFileSync(file, "utf8"));
    expect(await runDoctor(options())).toBe(0);
    expect(output()).not.toContain("Nota privada sintética");
    expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
  });

  it("informa fuente ausente sin instalarla", async () => {
    await install();
    const source = path.join(root, "writing-style.md");
    fs.unlinkSync(source);
    expect(await runDoctor(options())).toBe(1);
    expect(output()).toMatch(/estilo ausente|desactualizada/);
    expect(fs.existsSync(source)).toBe(false);
  });

  it("informa proyección desactualizada sin repararla ni mostrar su contenido", async () => {
    await install();
    const prompt = path.join(root, "codex", "AGENTS.md");
    const changed = fs.readFileSync(prompt, "utf8").replace(/(<!-- jorgex:writing-style -->)[\s\S]*?(<!-- \/jorgex:writing-style -->)/, "$1\nNota privada sintética\n$2");
    fs.writeFileSync(prompt, changed);
    expect(await runDoctor(options())).toBe(1);
    expect(output()).toContain("pendientes de reconciliación");
    expect(output()).not.toContain("Nota privada sintética");
    expect(fs.readFileSync(prompt, "utf8")).toBe(changed);
  });

  it.each(["source", "prompt"] as const)("rechaza %s ilegible sin reemplazarlo", async (kind) => {
    await install();
    const file = kind === "source" ? path.join(root, "writing-style.md") : path.join(root, "codex", "AGENTS.md");
    fs.unlinkSync(file); fs.mkdirSync(file);
    expect(await runDoctor(options())).toBe(1);
    expect(output()).toMatch(/archivo|leer|ilegible|directorio/);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });
});
