import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, FileAction, InstallContext, InstallMode, SubagentConcurrency } from "../src/adapters/types.js";
import { buildPlan } from "../src/install.js";
import { loadCanonicalAgents } from "../src/lib/canonical.js";
import { stackRoot } from "../src/lib/paths.js";
import { testModelsForRuntime } from "./fixtures/model-map.js";

const RUNTIMES = [
  ["OpenCode", opencodeAdapter],
  ["Codex", codexAdapter],
  ["Claude Code", claudeCodeAdapter],
] as const;

const canonicalAgents = loadCanonicalAgents(path.join(stackRoot(), "agents"));
const primaryAgent = canonicalAgents.find((agent) => agent.mode === "primary")!;
const sampleSubagent = canonicalAgents.find((agent) => agent.mode === "subagent")!;
const legacyProgrammaticContractPattern = /\bResult contract\b|Status \/ Delegations \/ Risks/;

type RenderedArtifact = { file: string; kind: "agent" | "command" | "output-style" | "skill" | "profile"; content: string; target: string };

function makeContext(adapter: Adapter, configDir: string, mode: InstallMode, subagentConcurrency: SubagentConcurrency): InstallContext {
  return {
    stackDir: stackRoot(),
    configDir,
    mode,
    subagentConcurrency,
    engramBin: path.join(configDir, "engram"),
    models: testModelsForRuntime(adapter.id),
    warnings: [],
  };
}

function targetFor(adapter: Adapter, ctx: InstallContext, artifact: { file: string; kind: RenderedArtifact["kind"] }): string {
  const paths = adapter.paths(ctx.configDir);
  switch (artifact.kind) {
    case "agent":
      return path.join(paths.agentsDir, artifact.file);
    case "command":
      return path.join(paths.commandsDir, artifact.file);
    case "output-style":
      return path.join(paths.outputStylesDir!, artifact.file);
    case "skill":
      return path.join(paths.skillsDir, artifact.file);
    case "profile":
      return path.join(paths.profilesDir!, artifact.file);
  }
}

function renderedArtifacts(adapter: Adapter, ctx: InstallContext, agent = primaryAgent): RenderedArtifact[] {
  return adapter.renderAgent(agent, ctx.models).map((artifact) => ({
    ...artifact,
    target: targetFor(adapter, ctx, artifact),
  }));
}

function findWrite(plan: FileAction[], target: string): { content: string } {
  const action = plan.find((entry) => entry.kind === "write" && entry.target === target);
  expect(action, `No se generó ${target}`).toBeDefined();
  return action as { content: string };
}

function plannedContent(plan: FileAction[], target: string): string {
  const action = plan.find((entry) => entry.target === target);
  expect(action, `No se generó ${target}`).toBeDefined();
  return action!.kind === "write" ? action!.content : fs.readFileSync(action!.source, "utf8");
}

function orchestratorSkillTarget(adapter: Adapter, ctx: InstallContext): string {
  return path.join(adapter.paths(ctx.configDir).skillsDir, "orchestrator", "SKILL.md");
}

function expectProgrammaticSystemPrompt(content: string): void {
  expect(content).toContain("PROGRAMMATIC MODE");
  expect(content).toContain("strict JSON object");
}

function expectProgrammaticOrchestrator(content: string, concurrency: SubagentConcurrency): void {
  expect(content).not.toMatch(legacyProgrammaticContractPattern);
  expect(content).toContain("strict JSON object");
  expect(content).toContain("status");
  expect(content).toContain("decision");
  expect(content).toContain("confidence");
  expect(content).toContain("summary");
  expect(content).toContain("risks");
  expect(content).toContain("next_steps");
  expect(content).toContain("delegations");
  expect(content).toMatch(/English[- ]only/i);
  expect(content).toContain("Do not wrap the final JSON in Markdown");
  expect(content).toContain("If a subagent reports `partial`");
  expect(content).toContain("keep the safe work and relaunch only what still needs guidance");
  expect(content).toContain("If a subagent reports `blocked`");
  expect(content).toContain("one concrete question");
  expect(content).toContain("explicit guidance");
  if (concurrency === "serial") {
    expect(content).toMatch(/one subagent at a time|no parallel delegation/i);
  } else {
    expect(content).toMatch(/max_parallel_subagents|parallel delegation/i);
  }
}

function expectProgrammaticSubagent(content: string): void {
  expect(content).not.toMatch(legacyProgrammaticContractPattern);
  expect(content).toMatch(/English[- ]only/i);
  expect(content).toMatch(/compact/i);
  expect(content).toMatch(/long Markdown reports/i);
  expect(content).toContain("task-critical uncertainty");
  expect(content).toContain("set `status` to `blocked`");
  expect(content).toContain("one concrete question");
  expect(content).toContain("main agent/orchestrator");
  expect(content).toContain("report the remainder as `partial`");
}

function expectHumanSafe(content: string): void {
  expect(content).not.toContain("PROGRAMMATIC MODE");
  expect(content).not.toContain("strict JSON object");
  expect(content).not.toContain("max_parallel_subagents");
  expect(content).not.toContain("Do not wrap the final JSON in Markdown");
}

function expectPrimaryWrapper(content: string): void {
  expect(content).toContain("Load and follow the `orchestrator` skill");
  expect(content).not.toContain("## Phases");
}

describe.each(RUNTIMES)("%s", (_name, adapter) => {
  let tempRoot = "";

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  function plan(mode: InstallMode, subagentConcurrency: SubagentConcurrency): { ctx: InstallContext; plan: FileAction[] } {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-programmatic-rendering-"));
    const ctx = makeContext(adapter, path.join(tempRoot, "config"), mode, subagentConcurrency);
    return { ctx, plan: buildPlan(adapter, ctx) };
  }

  it("programmatic/serial compone el contrato en la skill canónica, no en el wrapper primary", () => {
    const { ctx, plan: fileActions } = plan("programmatic", "serial");

    expectProgrammaticSystemPrompt(findWrite(fileActions, adapter.paths(ctx.configDir).systemPromptFile).content);

    for (const artifact of renderedArtifacts(adapter, ctx, primaryAgent)) {
      const content = findWrite(fileActions, artifact.target).content;
      expectPrimaryWrapper(content);
      expectHumanSafe(content);
    }
    expectProgrammaticOrchestrator(plannedContent(fileActions, orchestratorSkillTarget(adapter, ctx)), "serial");

    const subagent = renderedArtifacts(adapter, ctx, sampleSubagent)[0]!;
    expectProgrammaticSubagent(findWrite(fileActions, subagent.target).content);
  });

  it("programmatic/parallel cambia la concurrencia sin perder el contrato JSON", () => {
    const { ctx, plan: fileActions } = plan("programmatic", "parallel");

    expectProgrammaticSystemPrompt(findWrite(fileActions, adapter.paths(ctx.configDir).systemPromptFile).content);

    for (const artifact of renderedArtifacts(adapter, ctx, primaryAgent)) {
      const content = findWrite(fileActions, artifact.target).content;
      expectPrimaryWrapper(content);
      expectHumanSafe(content);
    }
    expectProgrammaticOrchestrator(plannedContent(fileActions, orchestratorSkillTarget(adapter, ctx)), "parallel");

    const subagent = renderedArtifacts(adapter, ctx, sampleSubagent)[0]!;
    expectProgrammaticSubagent(findWrite(fileActions, subagent.target).content);
  });

  it("human mode no queda contaminado por los marcadores de programmatic", () => {
    const { ctx, plan: fileActions } = plan("human", "serial");

    expectHumanSafe(findWrite(fileActions, adapter.paths(ctx.configDir).systemPromptFile).content);

    for (const artifact of renderedArtifacts(adapter, ctx, primaryAgent)) {
      const content = findWrite(fileActions, artifact.target).content;
      expectPrimaryWrapper(content);
      expectHumanSafe(content);
    }
    expectHumanSafe(plannedContent(fileActions, orchestratorSkillTarget(adapter, ctx)));

    const subagent = renderedArtifacts(adapter, ctx, sampleSubagent)[0]!;
    expectHumanSafe(findWrite(fileActions, subagent.target).content);
  });
});
