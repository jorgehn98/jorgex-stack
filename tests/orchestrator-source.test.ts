import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext, SubagentConcurrency } from "../src/adapters/types.js";
import { buildPlan } from "../src/install.js";
import { loadCanonicalAgents } from "../src/lib/canonical.js";
import { stackRoot } from "../src/lib/paths.js";
import { testModelsForRuntime } from "./fixtures/model-map.js";

const RUNTIMES = [
  ["OpenCode", opencodeAdapter],
  ["Codex", codexAdapter],
  ["Claude Code", claudeCodeAdapter],
] as const;

const stackDir = stackRoot();
const orchestratorAgent = loadCanonicalAgents(path.join(stackDir, "agents"))
  .find((agent) => agent.mode === "primary")!;

function makeContext(
  adapter: Adapter,
  configDir: string,
  mode: "human" | "programmatic",
  subagentConcurrency: SubagentConcurrency = "serial",
): InstallContext {
  return {
    stackDir,
    configDir,
    mode,
    subagentConcurrency,
    engramBin: path.join(configDir, "engram"),
    models: testModelsForRuntime(adapter.id),
    warnings: [],
  };
}

function primaryTarget(adapter: Adapter, ctx: InstallContext): string {
  const [artifact] = adapter.renderAgent(orchestratorAgent, ctx.models);
  expect(artifact).toBeDefined();
  const paths = adapter.paths(ctx.configDir);
  if (artifact!.kind === "agent") return path.join(paths.agentsDir, artifact!.file);
  if (artifact!.kind === "output-style") return path.join(paths.outputStylesDir!, artifact!.file);
  if (artifact!.kind === "profile") return path.join(paths.profilesDir!, artifact!.file);
  throw new Error(`Primary inesperado: ${artifact!.kind}`);
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

  function plan(mode: "human" | "programmatic", concurrency: SubagentConcurrency = "serial") {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-orchestrator-source-"));
    const ctx = makeContext(adapter, path.join(tempRoot, adapter.id), mode, concurrency);
    return { ctx, actions: buildPlan(adapter, ctx) };
  }

  it("planSkills instala exactamente una skill canónica y el adapter solo genera el wrapper", () => {
    const { ctx, actions } = plan("human");
    const skillTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "orchestrator", "SKILL.md");
    const wrapperTarget = primaryTarget(adapter, ctx);

    expect(actions.filter((action) => action.target === skillTarget)).toHaveLength(1);
    expect(plannedContent(actions, skillTarget)).toContain("## Phases");
    expect(plannedContent(actions, wrapperTarget)).toContain("Load and follow the `orchestrator` skill");
    expect(plannedContent(actions, wrapperTarget)).not.toContain("## Phases");
    expect(adapter.renderAgent(orchestratorAgent, ctx.models).some((artifact) => artifact.kind === "skill")).toBe(false);
  });

  it("programmatic compone su addendum solo sobre la skill instalada", () => {
    const { ctx, actions } = plan("programmatic", "parallel");
    const skillTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "orchestrator", "SKILL.md");
    const skill = plannedContent(actions, skillTarget);
    const wrapper = plannedContent(actions, primaryTarget(adapter, ctx));

    expect(skill).toContain("strict JSON object");
    expect(skill).toMatch(/max_parallel_subagents|parallel delegation/i);
    expect(wrapper).toContain("Load and follow the `orchestrator` skill");
    expect(wrapper).not.toContain("strict JSON object");
    expect(wrapper).not.toContain("PROGRAMMATIC MODE");
  });
});
