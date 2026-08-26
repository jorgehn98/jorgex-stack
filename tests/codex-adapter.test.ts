import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { readTomlSection, removeTomlRootKeyIfExact, upsertTomlRootKeyIfMissing, upsertTomlSection } from "../src/lib/filemerge.js";
import { loadCanonicalHooks, loadCanonicalMcp, type CanonicalAgent } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP, type RuntimeModelMap } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function codexContext(configDir: string) {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: DEFAULT_MODEL_MAP.codex,
    warnings: [],
  };
}

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-codex-sol-"));
  tempDirs.push(dir);
  return dir;
}

function writeActionContent(actions: ReturnType<typeof codexAdapter.planMainConfig>, target: string): string {
  const action = actions.find((candidate) => candidate.kind === "write" && candidate.target === target);
  if (action?.kind !== "write") throw new Error(`Missing write action for ${target}`);
  return action.content;
}

function primaryOwnership(actions: ReturnType<typeof codexAdapter.planMainConfig>, target: string): ReadonlySet<string> {
  const action = actions.find((candidate) => candidate.kind === "write" && candidate.target === target);
  if (action?.kind !== "write") throw new Error(`Missing write action for ${target}`);
  return new Set((action.primaryModelOwnership ?? []).filter((change) => change.owned).map((change) => change.field));
}

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

  it("defaults GPT-5.6: Terra/xhigh para standard y Luna/medium para cheap", () => {
    const [standard] = codexAdapter.renderAgent(agent({ name: "implementer", tier: "standard" }), DEFAULT_MODEL_MAP.codex);
    expect(standard!.content).toContain('model = "gpt-5.6-terra"');
    expect(standard!.content).toContain('model_reasoning_effort = "xhigh"');

    const [cheap] = codexAdapter.renderAgent(agent({ name: "docs-maintainer", tier: "cheap" }), DEFAULT_MODEL_MAP.codex);
    expect(cheap!.content).toContain('model = "gpt-5.6-luna"');
    expect(cheap!.content).toContain('model_reasoning_effort = "medium"');
  });

  it("el primary (orchestrator) → profile wrapper, sin skill duplicada, model ni effort", () => {
    const models: RuntimeModelMap = { ...MODELS, strong: { model: "gpt-5.4", variant: "high" } };
    const out = codexAdapter.renderAgent(agent({
      name: "orchestrator",
      mode: "primary",
      body: "Load and follow the `orchestrator` skill.",
    }), models);
    expect(out).toHaveLength(1);

    const profile = out[0]!;
    expect(profile.kind).toBe("profile");
    expect(profile.file).toBe("orchestrator.config.toml");
    expect(profile.content).toContain("developer_instructions = '''");
    expect(profile.content).toContain("codex --profile orchestrator");
    expect(profile.content).toContain("Load and follow the `orchestrator` skill");
    expect(profile.content).not.toContain("## Phases");
    expect(profile.content).not.toContain("model =");
    expect(profile.content).not.toContain("model_reasoning_effort");
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

describe("codexAdapter primary Sol defaults", () => {
  it("añade los defaults ausentes, es idempotente y limpia solo valores canónicos", () => {
    const freshDir = tempConfigDir();
    const freshFile = path.join(freshDir, "config.toml");
    const fresh = writeActionContent(
      codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), codexContext(freshDir)),
      freshFile,
    );
    expect(fresh).toContain('model = "gpt-5.6-sol"');
    expect(fresh).toContain("model_context_window = 872000");

    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const ctx = codexContext(configDir);
    const mcp = loadCanonicalMcp(stackRoot());

    fs.writeFileSync(configFile, '# user config\ninstructions = \'\'\'\nmodel = "inside multiline"\n\'\'\'\ncustom_flag = true\n\n[foreign]\nvalue = "kept"\n');
    const installActions = codexAdapter.planMainConfig(mcp, ctx);
    const installed = writeActionContent(installActions, configFile);

    expect(installed).toContain('model = "gpt-5.6-sol"');
    expect(installed).toContain("model_context_window = 872000");
    expect(installed).not.toContain("auto_compact");
    expect(installed).toContain("custom_flag = true");
    expect(installed).toContain('model = "inside multiline"');
    expect(installed).toContain('[foreign]\nvalue = "kept"');

    fs.writeFileSync(configFile, installed);
    expect(writeActionContent(codexAdapter.planMainConfig(mcp, ctx), configFile)).toBe(installed);

    const customized = installed.replace('model = "gpt-5.6-sol"', 'model = "user/model"');
    fs.writeFileSync(configFile, customized);
    const unmerged = writeActionContent(
      codexAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...ctx,
        ownedPrimaryModelFields: primaryOwnership(installActions, configFile),
      }),
      configFile,
    );

    expect(unmerged).toContain('model = "user/model"');
    expect(unmerged).not.toContain("model_context_window = 872000");
    expect(unmerged).toContain("custom_flag = true");
    expect(unmerged).toContain('model = "inside multiline"');
    expect(unmerged).toContain('[foreign]\nvalue = "kept"');

    const quotedDir = tempConfigDir();
    const quotedFile = path.join(quotedDir, "config.toml");
    const quoted = '"model" = "gpt-5.6-sol"\n\'model_context_window\' = 872000\n';
    fs.writeFileSync(quotedFile, quoted);
    const quotedActions = codexAdapter.planMainConfig(mcp, codexContext(quotedDir));
    expect(writeActionContent(quotedActions, quotedFile).match(/gpt-5\.6-sol/g)).toHaveLength(1);
    expect(primaryOwnership(quotedActions, quotedFile)).toEqual(new Set());
    fs.writeFileSync(quotedFile, writeActionContent(quotedActions, quotedFile));
    expect(writeActionContent(
      codexAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), codexContext(quotedDir)),
      quotedFile,
    )).toContain(quoted.trim());
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

  it("preserva CRLF byte a byte cuando la clave root ya existe", () => {
    const content = '"model" = "user/model"\r\n\r\n[foreign]\r\nvalue = true\r\n';
    expect(upsertTomlRootKeyIfMissing(content, "model", '"gpt-5.6-sol"')).toBe(content);
    expect(removeTomlRootKeyIfExact(content, "model", '"gpt-5.6-sol"')).toBe(content);
  });
});
