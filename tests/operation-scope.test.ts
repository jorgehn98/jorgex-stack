import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { runDoctor } from "../src/doctor.js";
import { readManifest } from "../src/lib/manifest.js";
import { readAgentModel } from "../src/lib/agent-model.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/var/tmp", "jx-t07-scope-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const scopeOptions = () => ({ runtimes: ["pi"] as ["pi"], targetDir: root, dryRun: false, yes: true });
const manifest = () => readManifest(path.join(root, ".jorgex-stack", "manifest.json"));

it("installing one agent has no native integration effects and preserves unrelated ownership on update", async () => {
  const execute = vi.fn(() => "");
  expect(await runInstall({ ...scopeOptions(), scope: { section: "agents", agent: "implementer" }, execute })).toBe(0);
  const file = path.join(root, "pi-agent", "agents", "implementer.md");
  expect(fs.readdirSync(path.dirname(file))).toEqual(["implementer.md"]);
  expect(fs.existsSync(path.join(root, ".agents", "skills"))).toBe(false);
  expect(fs.existsSync(path.join(root, "pi-agent", "mcp.json"))).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("---\n", '---\nmodel: "personal"\nthinking: "personal-effort"\n'));
  expect(await runInstall({ ...scopeOptions(), scope: { section: "skills" }, execute })).toBe(0);
  const before = manifest().runtimes.pi!.owned;
  expect(await runInstall({ ...scopeOptions(), scope: { section: "agents", agent: "implementer" }, execute, command: "update" })).toBe(0);
  expect(manifest().runtimes.pi!.owned).toEqual(before);
  expect(readAgentModel("pi", file).selection).toEqual({ model: "personal", variant: "personal-effort" });
  expect(await runDoctor({ ...scopeOptions(), scope: { section: "agents", agent: "implementer" } })).toBe(0);
});
it("Pi config removal preserves shared skills, agents and other runtime Browser Control", async () => {
  expect(await runInstall(scopeOptions())).toBe(0);
  expect(await runInstall({ ...scopeOptions(), runtimes: ["opencode"], opencodeTargetMajor: 2 })).toBe(0);
  const openCodeMcp = path.join(root, "opencode", "opencode.json");
  const raw = fs.readFileSync(openCodeMcp, "utf8");
  const before = manifest();
  const skills = before.runtimes.pi!.owned.filter((file) => file.includes(`${path.sep}.agents${path.sep}skills${path.sep}`));
  expect(skills.length).toBeGreaterThan(0);
  expect(await runUninstall({ ...scopeOptions(), scope: { section: "config" }, removeEngram: false })).toBe(0);
  expect(skills.every((file) => fs.existsSync(file))).toBe(true);
  expect(manifest().runtimes.pi!.owned).toContain(path.join(root, "pi-agent", "agents", "implementer.md"));
  expect(fs.readFileSync(openCodeMcp, "utf8")).toBe(raw);
  expect(manifest().runtimes.opencode).toEqual(before.runtimes.opencode);
});
it("shared skills removal clears only shared claims across consumers and backs up files", async () => {
  expect(await runInstall(scopeOptions())).toBe(0);
  expect(await runInstall({ ...scopeOptions(), runtimes: ["opencode"], opencodeTargetMajor: 2 })).toBe(0);
  expect(await runUninstall({ ...scopeOptions(), scope: { section: "skills" }, removeEngram: false })).toBe(0);
  expect(manifest().runtimes.opencode!.owned.some((file) => file.includes(`${path.sep}.agents${path.sep}skills${path.sep}`))).toBe(false);
  expect(manifest().runtimes.pi!.mcpOwned).toContain("browser-control");
  expect(fs.existsSync(path.join(root, "pi-agent", "agents", "implementer.md"))).toBe(true);
  expect(fs.existsSync(path.join(root, ".agents", "skills", "lean-code", "SKILL.md"))).toBe(false);
  expect(fs.readdirSync(path.join(root, ".jorgex-stack", "backups")).length).toBeGreaterThan(0);
});
it("Todo removal releases shared references so the last selected consumer can retire shared skills", async () => {
  expect(await runInstall(scopeOptions())).toBe(0);
  expect(await runInstall({ ...scopeOptions(), runtimes: ["opencode"], opencodeTargetMajor: 2 })).toBe(0);
  expect(await runUninstall({ ...scopeOptions(), scope: { section: "all" }, removeEngram: false })).toBe(0);
  expect(await runUninstall({ ...scopeOptions(), runtimes: ["opencode"], scope: { section: "all" }, removeEngram: false })).toBe(0);
  expect(fs.existsSync(path.join(root, ".agents", "skills", "lean-code", "SKILL.md"))).toBe(false);
  expect(manifest().runtimes).toEqual({});
});
it("removes an individual agent without removing its neighbors or config", async () => {
  expect(await runInstall(scopeOptions())).toBe(0);
  const before = manifest().runtimes.pi!;
  expect(await runUninstall({ ...scopeOptions(), scope: { section: "agents", agent: "implementer" }, removeEngram: false })).toBe(0);
  expect(fs.existsSync(path.join(root, "pi-agent", "agents", "implementer.md"))).toBe(false);
  expect(fs.existsSync(path.join(root, "pi-agent", "agents", "reviewer.md"))).toBe(true);
  expect(manifest().runtimes.pi!.mcpOwned).toEqual(before.mcpOwned);
});
