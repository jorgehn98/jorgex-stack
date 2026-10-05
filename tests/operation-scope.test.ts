import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { runDoctor } from "../src/doctor.js";
import { createBackup, listBackups, restoreBackup } from "../src/lib/backup.js";
import { readManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { readAgentModel } from "../src/lib/agent-model.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/var/tmp", "jx-t07-scope-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
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

it.each(["install", "update"] as const)("%s preserves indented Codex model/effort without reading instruction-body fields", async (command) => {
  const opts = { ...scopeOptions(), runtimes: ["codex" as const], scope: { section: "agents" as const, agent: "implementer" } };
  expect(await runInstall(opts)).toBe(0);
  const file = path.join(root, "codex", "agents", "implementer.toml");
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, '  model = "personal"\n\tmodel_reasoning_effort = "personal-effort"\n' + before.replace("developer_instructions = '''", "developer_instructions = '''\nmodel = \"body-only\"\nmodel_reasoning_effort = \"body-effort\""));
  expect(readAgentModel("codex", file).selection).toEqual({ model: "personal", variant: "personal-effort" });
  expect(await runInstall({ ...opts, command })).toBe(0);
  expect(readAgentModel("codex", file).selection).toEqual({ model: "personal", variant: "personal-effort" });
});

it("removing Claude Todo cleans its shared prompt despite Pi's separate prompt and preserves foreign notes/shared skills", async () => {
  const claude = { ...scopeOptions(), runtimes: ["claude-code" as const] };
  expect(await runInstall(claude)).toBe(0);
  expect(await runInstall(scopeOptions())).toBe(0);
  const sharedPrompt = path.join(root, ".agents", "AGENTS.md");
  fs.appendFileSync(sharedPrompt, "\nForeign global notes\n");
  const piPrompt = path.join(root, "pi-agent", "AGENTS.md");
  const piBefore = fs.readFileSync(piPrompt, "utf8");
  const skill = path.join(root, ".agents", "skills", "lean-code", "SKILL.md");
  const skillBefore = fs.readFileSync(skill, "utf8");
  expect(await runUninstall({ ...claude, removeEngram: false })).toBe(0);
  const sharedAfter = fs.readFileSync(sharedPrompt, "utf8");
  expect(sharedAfter).toContain("Foreign global notes");
  expect(sharedAfter).not.toContain("<!-- jorgex:");
  expect(fs.readFileSync(piPrompt, "utf8")).toBe(piBefore);
  expect(fs.readFileSync(skill, "utf8")).toBe(skillBefore);
  expect(manifest().runtimes.pi).toBeDefined();
  expect(manifest().runtimes["claude-code"]).toBeUndefined();
});

it.each([false, true])("retains original backups and persists partial ownership during many projections (failure=%s)", async (fail) => {
  const state = path.join(root, ".jorgex-stack");
  const backups = path.join(state, "backups");
  const manifestFile = path.join(state, "manifest.json");
  const configDir = path.join(root, "pi-agent");
  fs.mkdirSync(configDir);
  const config = path.join(configDir, "mcp.json");
  const originalConfig = '{"mcpServers":{"foreign":{"url":"https://example.invalid"}}}\n';
  fs.writeFileSync(config, originalConfig);
  writeRuntimeManifest("pi", { configDir, owned: [], updatedAt: "original" }, manifestFile);
  const originalManifest = fs.readFileSync(manifestFile, "utf8");
  const bin = path.join(root, "engram-fixture");
  fs.writeFileSync(bin, "original binary fixture");
  const binaryBackup = createBackup([bin], "engram-binary", backups)!;
  fs.writeFileSync(bin, "candidate binary fixture");
  const failedTarget = path.join(root, ".agents", "skills", "to-spec", "SKILL.md");
  const copy = fs.copyFileSync;
  vi.spyOn(fs, "copyFileSync").mockImplementation((source, target, mode) => {
    if (fail && String(target) === failedTarget) throw new Error("owned projection failure");
    return copy(source, target, mode);
  });
  expect(await runInstall(scopeOptions())).toBe(fail ? 1 : 0);
  const applied = readManifest(manifestFile).runtimes.pi!;
  expect(applied.owned.length).toBeGreaterThan(10);
  expect(applied.owned).toContain(path.join(configDir, "agents", "implementer.md"));
  if (fail) { expect(applied.owned).not.toContain(failedTarget); expect(fs.existsSync(failedTarget)).toBe(false); }
  // Initial config and binary snapshots must survive ownership checkpoints in this operation.
  expect(listBackups(backups).some((info) => info.id === binaryBackup.id)).toBe(true);
  const manifestBackups = listBackups(backups).filter((info) => info.label === "manifest");
  expect(manifestBackups).toHaveLength(1);
  expect(fs.readFileSync(manifestBackups[0]!.files[0]!.stored, "utf8")).toBe(originalManifest);
  const configBackup = listBackups(backups).find((info) => info.files.some((file) => file.original === config))!;
  expect(configBackup).toBeDefined();
  // Subsequent legitimate snapshots must not silently evict earlier restore points either.
  const later = path.join(root, "later-config");
  for (let n = 0; n < 12; n++) { fs.writeFileSync(later, `configuration ${n}`); createBackup([later], "later", backups); }
  expect(listBackups(backups).filter((info) => info.label === "later")).toHaveLength(12);
  expect(restoreBackup(binaryBackup.id, backups, root)).toBe(1);
  expect(fs.readFileSync(bin, "utf8")).toBe("original binary fixture");
  expect(restoreBackup(configBackup.id, backups, root)).toBe(1);
  expect(fs.readFileSync(config, "utf8")).toBe(originalConfig);
  expect(restoreBackup(manifestBackups[0]!.id, backups, root)).toBe(1);
  expect(fs.readFileSync(manifestFile, "utf8")).toBe(originalManifest);
});
