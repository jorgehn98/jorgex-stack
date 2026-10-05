import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { piAdapter } from "../src/adapters/pi.js";
import { planAgents } from "../src/components/agents.js";
import { planSkills } from "../src/components/skills.js";
import { planSystemPrompt } from "../src/components/system-prompt.js";
import { applyChanges, diffPlan } from "../src/install.js";
import { createBackup, restoreBackup } from "../src/lib/backup.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { readTextIfExists } from "../src/lib/fsx.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import type { FileAction, InstallContext } from "../src/adapters/types.js";

let root: string;
let ctx: InstallContext;
const owned = new Set<string>();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-native-files-"));
  owned.clear();
  const stackDir = path.join(root, "stack");
  fs.mkdirSync(path.join(stackDir, "skills", "one"), { recursive: true });
  fs.writeFileSync(path.join(stackDir, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: One skill\n---\nSkill body\n");
  fs.mkdirSync(path.join(stackDir, "agents"));
  fs.copyFileSync(path.resolve("stack/agents/implementer.md"), path.join(stackDir, "agents", "implementer.md"));
  ctx = { stackDir, configDir: path.join(root, ".claude"), ownedFiles: owned, engramBin: null, models: DEFAULT_MODEL_MAP["claude-code"], warnings: [] };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function apply(plan: FileAction[]) {
  const changes = diffPlan(plan).filter((change) => change.status !== "unchanged");
  const backup = createBackup(changes.filter((change) => change.status === "update").map((change) => change.action.target), "test", path.join(root, "backups"));
  applyChanges(changes, (action) => owned.add(path.resolve(action.target)));
  return backup;
}

describe("native projection filesystem boundaries", () => {
  it("copies a skill once and creates only a per-skill Claude link, idempotently", () => {
    const plan = planSkills(claudeCodeAdapter, ctx);
    apply(plan);
    const shared = path.join(root, ".agents", "skills", "one");
    const link = path.join(ctx.configDir, "skills", "one");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(shared));
    expect(diffPlan(planSkills(claudeCodeAdapter, ctx)).every((change) => change.status === "unchanged")).toBe(true);
    for (const adapter of [codexAdapter, opencodeAdapter]) {
      const configDir = path.join(root, adapter.id);
      const other = planSkills(adapter, { ...ctx, configDir });
      expect(other.every((action) => action.target.startsWith(shared))).toBe(true);
      expect(diffPlan(other).every((change) => change.status === "unchanged")).toBe(true);
    }
    const info = createBackup([link], "link", path.join(root, "backups"))!;
    fs.unlinkSync(link);
    expect(restoreBackup(info.id, path.join(root, "backups"), root)).toBe(1);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(shared));
  });

  it("preserves foreign skill directories and identical links without claiming them", () => {
    const shared = path.join(root, ".agents", "skills", "one");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "SKILL.md"), fs.readFileSync(path.join(ctx.stackDir, "skills", "one", "SKILL.md")));
    expect(owned.size).toBe(0);
    expect(planSkills(claudeCodeAdapter, ctx)).toEqual([]);
    fs.rmSync(shared, { recursive: true });
    apply(planSkills(claudeCodeAdapter, ctx));
    const link = path.join(ctx.configDir, "skills", "one");
    owned.delete(link);
    expect(planSkills(claudeCodeAdapter, ctx).some((action) => action.target === link)).toBe(false);
    expect(owned.has(link)).toBe(false);
  });

  it.each([claudeCodeAdapter, codexAdapter, opencodeAdapter, piAdapter])("preserves native model choices in managed agents (%s)", (adapter) => {
    ctx.configDir = path.join(root, adapter.id);
    apply(planAgents(adapter, ctx));
    const target = [...owned][0]!;
    const previous = fs.readFileSync(target, "utf8");
    const choices = target.endsWith(".toml") ? 'model = "user/chosen"\nmodel_reasoning_effort = "high"\n' : 'model: "user/chosen"\nthinking: high\n';
    fs.writeFileSync(target, target.endsWith(".toml") ? choices + previous : previous.replace(/^---\n/, `---\n${choices}`));
    const before = fs.readFileSync(target, "utf8");
    const bodyExample = target.endsWith(".toml") ? 'model = "documentation-only"' : 'model: documentation-only';
    fs.appendFileSync(path.join(ctx.stackDir, "agents", "implementer.md"), `\nUpdated instruction\n${bodyExample}\n`);
    const info = apply(planAgents(adapter, ctx))!;
    expect(fs.readFileSync(info.files[0]!.stored, "utf8")).toBe(before);
    expect(fs.readFileSync(target, "utf8")).toContain(choices.trim());
    expect(fs.readFileSync(target, "utf8")).toContain(bodyExample);
    expect(diffPlan(planAgents(adapter, ctx)).every((change) => change.status === "unchanged")).toBe(true);
    owned.clear();
    expect(planAgents(adapter, ctx)).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toContain("user/chosen");
  });

  it("does not overwrite a foreign file created after planning", () => {
    const plan = diffPlan(planAgents(claudeCodeAdapter, ctx));
    const target = plan[0]!.action.target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "User raced creation");
    expect(() => applyChanges(plan, (action) => owned.add(action.target))).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("User raced creation");
    expect(owned.size).toBe(0);
  });

  it("blocks unreadable/non-file inputs instead of treating them as absence", () => {
    fs.mkdirSync(path.join(root, "not-a-file"));
    expect(() => readTextIfExists(path.join(root, "not-a-file"))).toThrow();
    const target = path.join(ctx.configDir, "agents", "implementer.md");
    fs.mkdirSync(target, { recursive: true });
    owned.add(target);
    expect(() => planAgents(claudeCodeAdapter, ctx)).toThrow(/regular/);
  });

  it("writes only a relative Claude import, escaping spaces and preserving user instructions", () => {
    ctx.stackDir = path.resolve("stack");
    ctx.configDir = path.join(root, "config with spaces", ".claude");
    fs.mkdirSync(ctx.configDir, { recursive: true });
    const bridgeFile = path.join(ctx.configDir, "CLAUDE.md");
    fs.writeFileSync(bridgeFile, "User policy\n");
    apply(planSystemPrompt(claudeCodeAdapter, ctx));
    const bridge = fs.readFileSync(bridgeFile, "utf8");
    expect(bridge).toContain("User policy");
    expect(bridge).toContain("@../.agents/AGENTS.md");
    expect(path.resolve(path.dirname(bridgeFile), bridge.split("\n").find((line) => line.startsWith("@"))!.slice(1))).toBe(claudeCodeAdapter.paths(ctx.configDir).sharedPromptFile);
    const adapter = { ...claudeCodeAdapter, paths: (configDir: string) => ({ ...claudeCodeAdapter.paths(configDir), sharedPromptFile: path.join(root, "shared with spaces", "AGENTS.md") }) };
    const spaced = planSystemPrompt(adapter, ctx).find((action) => action.target === bridgeFile)!;
    expect(spaced.kind === "write" && spaced.content).toContain("@../../shared\\ with\\ spaces/AGENTS.md");
    expect(bridge).not.toContain("## Role");
    expect(diffPlan(planSystemPrompt(claudeCodeAdapter, ctx)).every((change) => change.status === "unchanged")).toBe(true);
  });

  it("Pi Context7 preserves user entries and claims only a newly created entry", () => {
    ctx.stackDir = path.resolve("stack");
    ctx.configDir = path.join(root, "pi-agent");
    fs.mkdirSync(ctx.configDir);
    const target = path.join(ctx.configDir, "mcp.json");
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { foreign: { url: "https://example.invalid" } }, user: true }));
    const plan = piAdapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx);
    expect(plan[0]).toMatchObject({ mcpOwnership: [{ server: "context7", owned: true }] });
    apply(plan);
    const after = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(after.user).toBe(true);
    expect(after.mcpServers.foreign).toEqual({ url: "https://example.invalid" });
    after.mcpServers.context7.headers.CONTEXT7_API_KEY = "user-selected-placeholder";
    fs.writeFileSync(target, JSON.stringify(after, null, 2) + "\n");
    const next = piAdapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx);
    expect(next[0]).toMatchObject({ mcpOwnership: [] });
    expect(diffPlan(next)[0]!.status).toBe("unchanged");
    fs.writeFileSync(target, "invalid-json");
    expect(() => piAdapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx)).toThrow();
  });
});
