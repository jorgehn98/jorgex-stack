import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext } from "../src/adapters/types.js";
import { buildPlan } from "../src/install.js";
import { stackRoot } from "../src/lib/paths.js";
import { testModelsForRuntime } from "./fixtures/model-map.js";

const RUNTIMES = [
  ["OpenCode", opencodeAdapter],
  ["Codex", codexAdapter],
  ["Claude Code", claudeCodeAdapter],
] as const;

const stackDir = stackRoot();

function makeContext(
  adapter: Adapter,
  configDir: string,
  mode: "human" | "programmatic",
): InstallContext {
  return {
    stackDir,
    configDir,
    mode,
    subagentConcurrency: "serial",
    engramBin: path.join(configDir, "engram"),
    models: testModelsForRuntime(adapter.id),
    warnings: [],
  };
}

function plannedContent(plan: ReturnType<typeof buildPlan>, target: string): string {
  const actions = plan.filter((action) => action.target === target);
  expect(actions).toHaveLength(1);
  const action = actions[0]!;
  return action.kind === "write" ? action.content : fs.readFileSync(action.source, "utf8");
}

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

describe("orchestrator canonical source", () => {
  it("la skill posee el workflow completo y el agent canónico es solo un wrapper", () => {
    const skillFile = path.join(stackDir, "skills", "orchestrator", "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);

    const skill = fs.readFileSync(skillFile, "utf8");
    const wrapper = fs.readFileSync(path.join(stackDir, "agents", "orchestrator.md"), "utf8");

    expect(skill).toContain("name: orchestrator");
    expect(skill).toContain("## Phases");
    expect(skill).toContain("INIT → EXPLORE → SPEC → PLAN → EXECUTE → VERIFY → SHIP → CLOSE");
    expect(wrapper).toContain("Load and follow the `orchestrator` skill");
    expect(wrapper).not.toContain("## Phases");
  });

  it("carga work-audit en modo PRE durante PLAN y en modo POST durante VERIFY", () => {
    const content = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const planSection = sectionBetween(content, "## 4. PLAN", "## Work state");
    const verifySection = sectionBetween(content, "## 6. VERIFY", "## 7. SHIP");

    expect(planSection).toContain("Load and run the `work-audit` skill in **PRE** mode");
    expect(verifySection).toContain("Load and run the `work-audit` skill in **POST** mode");
    expect(planSection).toMatch(/exact active `work\/\{name\}` path/i);
    expect(verifySection).toMatch(/exact active `work\/\{name\}` path[\s\S]*checkpoint scope/i);

    const postIndex = verifySection.indexOf("Load and run the `work-audit` skill in **POST** mode");
    const markIndex = verifySection.indexOf("mark the success criteria complete");
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(markIndex).toBeGreaterThan(postIndex);
  });

  it("repite PRE cuando la revisión humana cambia artefactos aprobables", () => {
    const content = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const planSection = sectionBetween(content, "## 4. PLAN", "## Work state");

    expect(planSection).toMatch(/human review[\s\S]{0,220}(?:changes|modifies)[\s\S]{0,220}rerun PRE/i);
  });

  it("ordena change-first antes de EXECUTE para cambios intencionales de contrato", () => {
    const content = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const planSection = sectionBetween(content, "## 4. PLAN", "## Work state");

    expect(planSection).toMatch(
      /intentional[\s\S]{0,220}contract(?:-| )changes?[\s\S]{0,220}PRD[\s\S]{0,220}plan[\s\S]{0,220}(?:tasks?|task specs?)[\s\S]{0,220}(?:SC-\*|success criteria)[\s\S]{0,220}testing decisions?[\s\S]{0,220}PRE[\s\S]{0,220}clean[\s\S]{0,220}human approval[\s\S]{0,220}EXECUTE/i,
    );
  });
});

describe.each(RUNTIMES)("%s orchestrator ownership", (_runtime, adapter) => {
  let tempRoot = "";

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  function plan(mode: "human" | "programmatic") {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-orchestrator-source-"));
    const ctx = makeContext(adapter, path.join(tempRoot, adapter.id), mode);
    return { ctx, actions: buildPlan(adapter, ctx) };
  }

  it("planSkills instala exactamente una skill canónica", () => {
    const { ctx, actions } = plan("human");
    const skillTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "orchestrator", "SKILL.md");

    expect(actions.filter((action) => action.target === skillTarget)).toHaveLength(1);
    expect(plannedContent(actions, skillTarget)).toContain("## Phases");
  });

  it("planSkills proyecta work-audit exactamente una vez desde el canon", () => {
    const canonicalSkill = path.join(stackDir, "skills", "work-audit", "SKILL.md");
    expect(fs.existsSync(canonicalSkill), "falta el canon stack/skills/work-audit/SKILL.md").toBe(true);
    if (!fs.existsSync(canonicalSkill)) return;

    const { ctx, actions } = plan("human");
    const skillTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "work-audit", "SKILL.md");

    expect(actions.filter((action) => action.target === skillTarget)).toHaveLength(1);
    expect(plannedContent(actions, skillTarget)).toBe(fs.readFileSync(canonicalSkill, "utf8"));
  });
});
