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
});
