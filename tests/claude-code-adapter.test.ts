import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import type { InstallContext } from "../src/adapters/types.js";
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

describe("claudeCodeAdapter.planMainConfig: mcpServers", () => {
  let tmp: string;
  let configDir: string;
  let mainFile: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cc-mcp-"));
    configDir = path.join(tmp, ".claude");
    // El adapter escribe el MCP de scope user en el hermano <configDir>.json.
    mainFile = path.join(tmp, ".claude.json");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  type Server = { type?: string; command?: string; url?: string; headers?: Record<string, string> };
  const makeCtx = (overrides: Partial<InstallContext> = {}): InstallContext => ({
    stackDir: stackRoot(),
    configDir,
    engramBin: "/opt/engram",
    models: MODELS,
    warnings: [],
    ...overrides,
  });
  const run = (ctx: InstallContext): { content: string; servers: Record<string, Server> } => {
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    const content = (action as { content: string }).content;
    return { content, servers: (JSON.parse(content) as { mcpServers: Record<string, Server> }).mcpServers };
  };

  it("registra el server stdio con type explícito y el http con type http", () => {
    // configDir vacío → sin plugin engram, así que el MCP stdio SÍ se registra.
    const { servers } = run(makeCtx());
    expect(servers.engram).toMatchObject({ type: "stdio", command: "/opt/engram" });
    expect(servers.context7!.type).toBe("http");
  });

  it("con el plugin engram presente NO registra el MCP, retira uno previo y avisa", () => {
    // installed_plugins.json con la clave del plugin: la vía de detección frágil.
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "engram@engram": [{ version: "0.1.0" }] } }),
    );
    // un engram registrado por un sync pre-plugin debe desaparecer.
    fs.writeFileSync(mainFile, JSON.stringify({ mcpServers: { engram: { type: "stdio", command: "old" } } }));
    const ctx = makeCtx();
    const { servers } = run(ctx);
    expect(servers.engram).toBeUndefined();
    expect(servers.context7!.type).toBe("http"); // el http no depende del plugin
    expect(ctx.warnings.join("\n")).toContain("plugin");
  });

  it("sin binario de Engram (engramBin null) NO registra el MCP y avisa", () => {
    const ctx = makeCtx({ engramBin: null });
    const { servers } = run(ctx);
    expect(servers.engram).toBeUndefined();
    expect(servers.context7!.type).toBe("http");
    expect(ctx.warnings.join("\n")).toContain("Engram no detectado");
  });

  it("http D5: una referencia ${VAR} se escribe vacía, nunca el literal", () => {
    const { content, servers } = run(makeCtx());
    expect(servers.context7!.headers!.CONTEXT7_API_KEY).toBe("");
    expect(content).not.toContain("${CONTEXT7_API_KEY}");
  });

  it("http D5: preserva el valor de header que el usuario ya tenía puesto", () => {
    fs.writeFileSync(
      mainFile,
      JSON.stringify({
        mcpServers: {
          context7: { type: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "real-key" } },
        },
      }),
    );
    const { servers } = run(makeCtx());
    expect(servers.context7!.headers!.CONTEXT7_API_KEY).toBe("real-key");
  });

  it("upsert quirúrgico: preserva servers MCP ajenos al stack", () => {
    fs.writeFileSync(mainFile, JSON.stringify({ mcpServers: { ajeno: { type: "http", url: "https://x" } } }));
    const { servers } = run(makeCtx());
    expect(servers.ajeno).toEqual({ type: "http", url: "https://x" });
    expect(servers.engram).toMatchObject({ type: "stdio" });
  });
});
