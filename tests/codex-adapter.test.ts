import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { readTomlSection, upsertTomlSection } from "../src/lib/filemerge.js";
import type { CanonicalAgent } from "../src/lib/canonical.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";

const MODELS: RuntimeModelMap = {
  strong: { model: "default", variant: "high" },
  standard: { model: "default", variant: "medium" },
  cheap: { model: "default", variant: "low" },
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
    body: "\n# Demo\n\nUse `git diff` and C:\\paths\\with\\backslashes.\n",
    ...overrides,
  };
}

describe("codexAdapter.renderAgent", () => {
  it("subagente → TOML con sandbox, effort por tier y sin model cuando es default", () => {
    const [out] = codexAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    expect(out!.kind).toBe("agent");
    expect(out!.file).toBe("demo.toml");
    expect(out!.content).toContain('name = "demo"');
    expect(out!.content).toContain('sandbox_mode = "read-only"');
    expect(out!.content).toContain('model_reasoning_effort = "high"');
    expect(out!.content).not.toContain("model =");
    // literal multiline: los backslashes del body viajan intactos
    expect(out!.content).toContain("C:\\paths\\with\\backslashes");
  });

  it("subagente con escritura → workspace-write y effort medium", () => {
    const [out] = codexAdapter.renderAgent(agent({ tier: "standard" }), MODELS);
    expect(out!.content).toContain('sandbox_mode = "workspace-write"');
    expect(out!.content).toContain('model_reasoning_effort = "medium"');
  });

  it("emite model cuando el model-map fija uno concreto", () => {
    const models: RuntimeModelMap = { ...MODELS, strong: { model: "gpt-5.4", variant: "high" } };
    const [out] = codexAdapter.renderAgent(agent({}), models);
    expect(out!.content).toContain('model = "gpt-5.4"');
  });

  it("override por agente: modelo propio y variant vacío limpia el effort del tier", () => {
    const models: RuntimeModelMap = {
      ...MODELS,
      overrides: { demo: { model: "gpt-5.4-mini", variant: "" } },
    };
    const [out] = codexAdapter.renderAgent(agent({}), models);
    expect(out!.content).toContain('model = "gpt-5.4-mini"');
    expect(out!.content).not.toContain("model_reasoning_effort");
  });

  it("el primary (orchestrator) → profile + skill, sin model ni effort (usa el del usuario)", () => {
    const models: RuntimeModelMap = { ...MODELS, strong: { model: "gpt-5.4", variant: "high" } };
    const out = codexAdapter.renderAgent(agent({ name: "orchestrator", mode: "primary" }), models);
    expect(out).toHaveLength(2);

    const profile = out.find((o) => o.kind === "profile")!;
    expect(profile.file).toBe("orchestrator.config.toml");
    expect(profile.content).toContain("developer_instructions = '''");
    expect(profile.content).toContain("codex --profile orchestrator");
    expect(profile.content).not.toContain("model =");
    expect(profile.content).not.toContain("model_reasoning_effort");

    const skill = out.find((o) => o.kind === "skill")!;
    expect(skill.file).toBe("orchestrator/SKILL.md");
    expect(skill.content).toContain("Invoke to switch into orchestrator mode");
  });
});

describe("codexAdapter.renderCommand", () => {
  it("convierte un command canónico en skill con name/description", () => {
    const out = codexAdapter.renderCommand("demo.md", "---\ndescription: Launch the hub\n---\nDo it.\n\nInput: {{input}}\n");
    expect(out.file).toBe("demo/SKILL.md");
    expect(out.content).toContain("name: demo");
    expect(out.content).toContain('"Launch the hub"');
    expect(out.content).toContain("Input: the user's request in this conversation");
  });
});

describe("upsertTomlSection", () => {
  const BASE = `# config del usuario\nmodel = "gpt-5.4"\n\n[mcp_servers.propio]\ncommand = "mi-server"\n\n[otra_seccion]\nkey = "value"\n`;

  it("crea la sección al final cuando no existe", () => {
    const out = upsertTomlSection(BASE, "mcp_servers.engram", 'command = "engram"\nargs = ["mcp"]');
    expect(out).toContain("[mcp_servers.engram]");
    expect(out).toContain("# config del usuario");
    expect(out).toContain("[mcp_servers.propio]");
    expect(out.indexOf("[mcp_servers.engram]")).toBeGreaterThan(out.indexOf("[otra_seccion]"));
  });

  it("reemplaza solo la sección existente, preservando el resto byte a byte", () => {
    const v1 = upsertTomlSection(BASE, "mcp_servers.engram", 'command = "v1"');
    const v2 = upsertTomlSection(v1, "mcp_servers.engram", 'command = "v2"');
    expect(v2).toContain('command = "v2"');
    expect(v2).not.toContain('command = "v1"');
    expect(v2).toContain('model = "gpt-5.4"');
    expect(v2).toContain("[mcp_servers.propio]");
    expect(v2).toContain('key = "value"');
  });

  it("es idempotente", () => {
    const once = upsertTomlSection(BASE, "mcp_servers.engram", 'command = "x"');
    const twice = upsertTomlSection(once, "mcp_servers.engram", 'command = "x"');
    expect(twice).toBe(once);
  });

  it("es idempotente con varias secciones consecutivas (ciclo del install)", () => {
    const apply = (content: string | null): string => {
      let out = upsertTomlSection(content, "mcp_servers.engram", 'command = "engram"\nargs = ["mcp"]');
      out = upsertTomlSection(out, "mcp_servers.context7", 'url = "https://mcp.context7.com/mcp"');
      return out;
    };
    const first = apply(null);
    expect(apply(first)).toBe(first);

    const onUserConfig = apply(BASE);
    expect(apply(onUserConfig)).toBe(onUserConfig);
  });

  it("readTomlSection extrae el cuerpo de una sección", () => {
    expect(readTomlSection(BASE, "mcp_servers.propio")).toContain('command = "mi-server"');
    expect(readTomlSection(BASE, "mcp_servers.inexistente")).toBeNull();
  });
});
