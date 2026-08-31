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
const deliveryAgentNames = ["tester", "test-analyzer"] as const;
const legacyProgrammaticContractPattern = /\bResult contract\b|Status \/ Delegations \/ Risks/;

type RenderedArtifact = { file: string; kind: "agent" | "command" | "output-style" | "profile"; content: string; target: string };

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

function frontmatter(content: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content.replace(/\r\n/g, "\n"));
  expect(match, "El artefacto no tiene frontmatter YAML").not.toBeNull();
  return match![1]!;
}

function operationalBody(agent: (typeof canonicalAgents)[number]): string {
  const body = agent.body.replace(/\r\n/g, "\n").trim();
  const resultContract = body.search(/\n## Result contract\b/);
  const withoutFooter = resultContract === -1 ? body : body.slice(0, resultContract);
  // composeProgrammaticAgentBody only rewrites this documented handoff
  // reference before appending the runtime addendum.
  const composed = withoutFooter.replace(/\bResult contract\b/g, "strict JSON handoff").trim();
  expect(composed.length, `${agent.name}: cuerpo operativo vacío`).toBeGreaterThan(0);
  return composed;
}

function deliveryArtifact(adapter: Adapter, ctx: InstallContext, fileActions: FileAction[], name: string): {
  agent: (typeof canonicalAgents)[number];
  artifact: RenderedArtifact;
  content: string;
} {
  const agent = canonicalAgents.find((candidate) => candidate.name === name);
  expect(agent, `No existe el agente canónico ${name}`).toBeDefined();
  const rendered = renderedArtifacts(adapter, ctx, agent!);
  expect(rendered, `${name}: debe producir un artefacto`).toHaveLength(1);
  const artifact = rendered[0]!;
  expect(artifact.kind, `${name}: los roles de apoyo son agentes nativos`).toBe("agent");
  const action = findWrite(fileActions, artifact.target);
  return { agent: agent!, artifact, content: action.content };
}

function expectDeliveryAgentContract(adapter: Adapter, ctx: InstallContext, fileActions: FileAction[], name: string): string {
  const { agent, artifact, content } = deliveryArtifact(adapter, ctx, fileActions, name);

  // The adapter preserves the complete canonical body; the programmatic plan
  // may deliberately rewrite only its documented handoff footer.
  expect(artifact.content).toContain(agent.body.trim());
  expect(content).toContain(operationalBody(agent));
  expect(content).not.toContain("{{SCRIPTS_DIR}}");
  expect(artifact.file).toBe(adapter.id === "codex" ? `${name}.toml` : `${name}.md`);
  expect(artifact.target).toBe(path.join(adapter.paths(ctx.configDir).agentsDir, artifact.file));

  if (adapter.id === "opencode") {
    const header = frontmatter(content);
    expect(header).toContain(`mode: ${agent.mode}`);
    expect(header).toContain("permission:");
    expect(header).toContain(`edit: ${agent.readonly ? "deny" : "allow"}`);
    if (agent.bash === "git-read") {
      expect(header).toContain('"git diff*": allow');
      expect(header).toContain('"git log*": allow');
      expect(header).not.toMatch(/"\*": allow/);
    } else if (agent.bash === "full") {
      expect(header).toMatch(/bash:\n\s+"\*": allow/);
    }
  } else if (adapter.id === "claude-code") {
    const header = frontmatter(content);
    expect(header).toContain(`description: `);
    if (agent.readonly) {
      expect(header).toContain("tools: Read, Grep, Glob, Skill, Bash");
      expect(header).toContain("mcp__engram__mem_save");
    } else {
      expect(header).not.toMatch(/^tools:/m);
    }
    expect(header).toContain(agent.bash === "full" ? "PreToolUse:" : `model: `);
  } else {
    expect(content).toMatch(new RegExp(`(?:^|\\n)name = "${name}"(?:\\n|$)`));
    expect(content).toContain(`sandbox_mode = "${agent.readonly ? "read-only" : "workspace-write"}"`);
    expect(content).toContain("developer_instructions = '''");
  }
  return content;
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

  it("programmatic/serial compone el contrato en el wrapper primary, no en la skill compartida", () => {
    const { ctx, plan: fileActions } = plan("programmatic", "serial");

    expectProgrammaticSystemPrompt(findWrite(fileActions, adapter.paths(ctx.configDir).systemPromptFile).content);

    for (const artifact of renderedArtifacts(adapter, ctx, primaryAgent)) {
      const content = findWrite(fileActions, artifact.target).content;
      expectPrimaryWrapper(content);
      expectProgrammaticOrchestrator(content, "serial");
    }
    const subagent = renderedArtifacts(adapter, ctx, sampleSubagent)[0]!;
    expectProgrammaticSubagent(findWrite(fileActions, subagent.target).content);
    for (const name of deliveryAgentNames) {
      expectProgrammaticSubagent(expectDeliveryAgentContract(adapter, ctx, fileActions, name));
    }
  });

  it("programmatic/parallel cambia la concurrencia sin perder el contrato JSON", () => {
    const { ctx, plan: fileActions } = plan("programmatic", "parallel");

    expectProgrammaticSystemPrompt(findWrite(fileActions, adapter.paths(ctx.configDir).systemPromptFile).content);

    for (const artifact of renderedArtifacts(adapter, ctx, primaryAgent)) {
      const content = findWrite(fileActions, artifact.target).content;
      expectPrimaryWrapper(content);
      expectProgrammaticOrchestrator(content, "parallel");
    }
    const subagent = renderedArtifacts(adapter, ctx, sampleSubagent)[0]!;
    expectProgrammaticSubagent(findWrite(fileActions, subagent.target).content);
    for (const name of deliveryAgentNames) {
      expectProgrammaticSubagent(expectDeliveryAgentContract(adapter, ctx, fileActions, name));
    }
  });

  it("human mode no queda contaminado por los marcadores de programmatic", () => {
    const { ctx, plan: fileActions } = plan("human", "serial");

    expectHumanSafe(findWrite(fileActions, adapter.paths(ctx.configDir).systemPromptFile).content);

    for (const artifact of renderedArtifacts(adapter, ctx, primaryAgent)) {
      const content = findWrite(fileActions, artifact.target).content;
      expectPrimaryWrapper(content);
      expectHumanSafe(content);
    }
    const subagent = renderedArtifacts(adapter, ctx, sampleSubagent)[0]!;
    expectHumanSafe(findWrite(fileActions, subagent.target).content);
    for (const name of deliveryAgentNames) {
      const { agent, content } = deliveryArtifact(adapter, ctx, fileActions, name);
      expect(content).toContain(agent.body.trim());
      expectHumanSafe(content);
    }
  });
});
