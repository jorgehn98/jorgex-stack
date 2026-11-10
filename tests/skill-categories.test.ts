import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { listSkills, planSkills, resolveSkillCategories } from "../src/components/skills.js";
import { runInstall } from "../src/install.js";
import { readManifest } from "../src/lib/manifest.js";
import { stackRoot } from "../src/lib/paths.js";
import type { InstallContext } from "../src/adapters/types.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-skill-categories-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeStack(skills: Record<string, string[]>): string {
  const stackDir = path.join(root, "stack");
  for (const [category, names] of Object.entries(skills)) for (const name of names) {
    const dir = path.join(stackDir, "skills", category, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  }
  return stackDir;
}
function context(stackDir: string): InstallContext {
  return { stackDir, configDir: path.join(root, ".claude"), ownedFiles: new Set(), engramBin: null, warnings: [] };
}
const sharedSkill = (name: string) => path.join(root, ".agents", "skills", name, "SKILL.md");
const install = (scope: { section: "skills"; skillCategories?: string[] }, command: "install" | "update" = "install") =>
  runInstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true, scope, command });

describe("skill categories", () => {
  it("discovers two origin levels and projects them flat, only for the selected categories", () => {
    const stackDir = writeStack({ engineering: ["alpha"], marketing: ["gamma"], productivity: ["beta"] });
    expect(listSkills(stackDir).map((skill) => [skill.category, skill.name])).toEqual([["engineering", "alpha"], ["marketing", "gamma"], ["productivity", "beta"]]);
    const all = planSkills(claudeCodeAdapter, context(stackDir));
    expect(all.filter((action) => action.kind === "copy" && !action.symlink).map((action) => action.target)).toEqual([
      path.join(root, ".agents", "skills", "alpha", "SKILL.md"),
      path.join(root, ".agents", "skills", "gamma", "SKILL.md"),
      path.join(root, ".agents", "skills", "beta", "SKILL.md"),
    ]);
    const selected = planSkills(claudeCodeAdapter, { ...context(stackDir), skillCategories: new Set(["marketing"]) });
    expect(selected.map((action) => action.target)).toEqual([
      path.join(root, ".agents", "skills", "gamma", "SKILL.md"),
      path.join(root, ".claude", "skills", "gamma"),
    ]);
  });

  it("rejects a skill name repeated across categories because the destination is flat", () => {
    const stackDir = writeStack({ engineering: ["one"], marketing: ["one"] });
    expect(() => planSkills(claudeCodeAdapter, context(stackDir))).toThrow(/duplicada/);
  });

  it("adds productivity when engineering is selected, without duplicates or invented categories", () => {
    const available = ["agent-tooling", "engineering", "marketing", "productivity"];
    expect(resolveSkillCategories(["engineering"], available)).toEqual({ categories: ["engineering", "productivity"], added: ["productivity"] });
    expect(resolveSkillCategories(["productivity", "engineering"], available)).toEqual({ categories: ["engineering", "productivity"], added: [] });
    expect(resolveSkillCategories(["marketing"], available)).toEqual({ categories: ["marketing"], added: [] });
    expect(() => planSkills(claudeCodeAdapter, { ...context(writeStack({ marketing: ["gamma"] })), skillCategories: new Set(["unknown"]) })).toThrow(/desconocida/);
  });

  it("installs only the marked categories", async () => {
    expect(await install({ section: "skills", skillCategories: ["engineering"] })).toBe(0);
    expect(fs.existsSync(sharedSkill("implementer"))).toBe(true);
    expect(fs.existsSync(sharedSkill("to-spec"))).toBe(false);
    expect(fs.existsSync(sharedSkill("landing-launch"))).toBe(false);
  });

  it("leaves a category unmarked after installing it: deselecting never removes or retires", async () => {
    expect(await install({ section: "skills", skillCategories: ["engineering", "productivity"] })).toBe(0);
    const owned = readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes.pi!.owned;
    expect(await install({ section: "skills", skillCategories: ["engineering"] })).toBe(0);
    expect(fs.existsSync(sharedSkill("to-spec"))).toBe(true);
    expect(readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes.pi!.owned).toEqual(owned);
  });

  it("updates owned categories from the origin and does not install an unowned one", async () => {
    expect(await install({ section: "skills", skillCategories: ["engineering"] })).toBe(0);
    const target = sharedSkill("implementer");
    const origin = fs.readFileSync(path.join(stackRoot(), "skills", "engineering", "implementer", "SKILL.md"), "utf8");
    fs.writeFileSync(target, "modificado\n");
    expect(await install({ section: "skills" }, "update")).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(origin);
    expect(fs.existsSync(sharedSkill("to-spec"))).toBe(false);
  });

  it("keeps the Claude Code link and ownership of an unmarked category", async () => {
    const claude = (skillCategories: string[]) =>
      runInstall({ runtimes: ["claude-code"], targetDir: root, dryRun: false, yes: true, scope: { section: "skills", skillCategories } });
    const owned = () => readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes["claude-code"]!.owned;
    const link = path.join(root, "claude-code", "skills", "landing-launch");
    expect(await claude(["engineering", "marketing"])).toBe(0);
    const before = owned();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await claude(["engineering"])).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(sharedSkill("landing-launch"))).toBe(true);
    expect(owned()).toEqual(before);
  });
});
