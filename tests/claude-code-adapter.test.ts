import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import type { CanonicalAgent } from "../src/lib/canonical.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

const MODELS: RuntimeModelMap = {
  strong: { model: "fable" },
  standard: { model: "sonnet" },
  cheap: { model: "haiku" },
};

function agent(overrides: Partial<CanonicalAgent>): CanonicalAgent {
  return {
    name: "demo",
    description: "Demo agent",
    mode: "subagent",
    tier: "strong",
    readonly: false,
    bash: "full",
    spawn: true,
    body: "\n# Demo\n\nBody.\n",
    ...overrides,
  };
}

describe("claudeCodeAdapter.renderAgent", () => {
  it("el primary (orchestrator) es un MODO del main agent: output style + skill de activación", () => {
    const out = claudeCodeAdapter.renderAgent(agent({ name: "orchestrator", mode: "primary" }), MODELS);
    expect(out).toHaveLength(2);

    const style = out.find((o) => o.kind === "output-style")!;
    expect(style.file).toBe("orchestrator.md");
    expect(style.content).toContain("name: Orchestrator");
    expect(style.content).toContain("keep-coding-instructions: true");

    const skill = out.find((o) => o.kind === "skill")!;
    expect(skill.file).toBe("orchestrator/SKILL.md");
    expect(skill.content).toContain("name: orchestrator");
    expect(skill.content).toContain("Invoke to switch into orchestrator mode");
    expect(skill.content).not.toContain("keep-coding-instructions");
  });

  it("subagente readonly con git-read: allowlist con Skill, Bash y tools de memoria", () => {
    const [out] = claudeCodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    expect(out!.kind).toBe("agent");
    expect(out!.content).toContain("tools: Read, Grep, Glob, Skill, Bash, mcp__engram__mem_save");
    expect(out!.content).toContain("model: fable");
  });

  it("subagente sin restricciones: hereda todo (sin clave tools)", () => {
    const [out] = claudeCodeAdapter.renderAgent(agent({ tier: "standard" }), MODELS);
    expect(out!.content).not.toContain("tools:");
    expect(out!.content).toContain("model: sonnet");
  });

  it("override por agente pisa el tier solo para ese agente", () => {
    const models: RuntimeModelMap = { ...MODELS, overrides: { demo: { model: "opus" } } };
    const [out] = claudeCodeAdapter.renderAgent(agent({}), models);
    expect(out!.content).toContain("model: opus");
    const [other] = claudeCodeAdapter.renderAgent(agent({ name: "otro" }), models);
    expect(other!.content).toContain("model: fable");
  });

  it("el agente engram recibe solo tools de lectura de memoria (sin mem_save)", () => {
    const [out] = claudeCodeAdapter.renderAgent(
      agent({ name: "engram", readonly: true, bash: "none", tier: "cheap" }),
      MODELS,
    );
    expect(out!.content).toContain("mcp__engram__mem_get_observation");
    expect(out!.content).not.toContain("mem_save");
    expect(out!.content).not.toContain("Bash");
  });

  it("subagente full-bash: hook PreToolUse que bloquea git destructivo (placeholder SCRIPTS_DIR)", () => {
    const [out] = claudeCodeAdapter.renderAgent(agent({ name: "implementer", bash: "full" }), MODELS);
    expect(out!.content).toContain("hooks:");
    expect(out!.content).toContain("PreToolUse:");
    expect(out!.content).toContain('matcher: "Bash|PowerShell"');
    expect(out!.content).toContain('command: "node \\"{{SCRIPTS_DIR}}/block-destructive-git.cjs\\""');
  });

  it("subagente que no es full-bash NO recibe el hook guard", () => {
    const [gitRead] = claudeCodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    expect(gitRead!.content).not.toContain("PreToolUse");
    const [none] = claudeCodeAdapter.renderAgent(agent({ readonly: true, bash: "none" }), MODELS);
    expect(none!.content).not.toContain("PreToolUse");
  });

  it("el primary (orchestrator) NO recibe el hook guard — es el main agent", () => {
    const out = claudeCodeAdapter.renderAgent(agent({ name: "orchestrator", mode: "primary" }), MODELS);
    for (const o of out) expect(o.content).not.toContain("PreToolUse");
  });
});

describe("claudeCodeAdapter.renderCommand", () => {
  it("traduce {{input}} a $ARGUMENTS", () => {
    const out = claudeCodeAdapter.renderCommand("demo.md", "Haz X.\n\nInput: {{input}}\n");
    expect(out.content).toContain("Input: $ARGUMENTS");
    expect(out.content).not.toContain("{{input}}");
  });
});

describe("claudeCodeAdapter.planMainConfig: forma de mcpServers", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cc-mcp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("registra el server stdio con type explícito y el http con type http", () => {
    // configDir vacío → sin plugin engram, así que el MCP stdio SÍ se registra.
    const ctx = {
      stackDir: stackRoot(),
      configDir: path.join(tmp, ".claude"),
      engramBin: "/opt/engram",
      models: MODELS,
      warnings: [] as string[],
    };
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const parsed = JSON.parse((action as { content: string }).content) as {
      mcpServers: Record<string, { type?: string; command?: string }>;
    };
    expect(parsed.mcpServers.engram).toMatchObject({ type: "stdio", command: "/opt/engram" });
    expect(parsed.mcpServers.context7!.type).toBe("http");
  });
});
