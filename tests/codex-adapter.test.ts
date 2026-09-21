import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { readTomlSection, removeTomlRootKeyIfExact, upsertTomlRootKeyIfMissing, upsertTomlSection } from "../src/lib/filemerge.js";
import { loadCanonicalAgents, loadCanonicalHooks, loadCanonicalMcp, type CanonicalAgent } from "../src/lib/canonical.js";
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

  it("projects the approved model and effort for every Codex subagent role", () => {
    const expected = [
      ["code-reviewer", "standard", "gpt-5.6-luna", "max"],
      ["security-auditor", "strong", "gpt-6-astra", "low"],
      ["codebase-analyst", "standard", "gpt-5.6-luna", "max"],
      ["silent-failure-hunter", "strong", "gpt-6-astra", "low"],
      ["implementer", "standard", "gpt-5.6-luna", "max"],
      ["tester", "standard", "gpt-5.6-luna", "max"],
      ["docs-maintainer", "cheap", "gpt-5.6-luna", "medium"],
    ] as const;

    for (const [name, tier, model, effort] of expected) {
      const canonical = loadCanonicalAgents(path.join(stackRoot(), "agents")).find((candidate) => candidate.name === name);
      expect(canonical?.tier).toBe(tier);
      const [rendered] = codexAdapter.renderAgent(canonical!, DEFAULT_MODEL_MAP.codex);
      expect(rendered!.content).toContain(`model = "${model}"`);
      expect(rendered!.content).toContain(`model_reasoning_effort = "${effort}"`);
    }
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

    const withoutModel = '[foreign]\r\nvalue = true\r\n';
    expect(upsertTomlRootKeyIfMissing(withoutModel, "model", '"gpt-5.6-sol"'))
      .toBe('model = "gpt-5.6-sol"\r\n[foreign]\r\nvalue = true\r\n');
  });

  it("preserva CRLF al retirar una sección MCP desde el adapter", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const mcp = loadCanonicalMcp(stackRoot());
    const required = Object.entries(mcp.servers).find(([, server]) => !server.optional)?.[0];
    expect(required).toBeDefined();
    const content = [
      'model = "gpt-5.6-sol"',
      "model_context_window = 872000",
      "",
      `[mcp_servers.${required}]`,
      'command = "managed"',
      "",
      "[foreign]",
      'value = "kept"',
      "",
    ].join("\r\n");
    fs.writeFileSync(configFile, content);

    const unmerged = writeActionContent(codexAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
      ...codexContext(configDir),
      ownedPrimaryModelFields: new Set(["model", "model_context_window"]),
    }), configFile);

    expect(unmerged).toContain('[foreign]\r\nvalue = "kept"\r\n');
    expect(unmerged).not.toMatch(/(?<!\r)\n/);
  });
});

describe("codexAdapter Context7 registration safety", () => {
  it("registra Context7 ausente y reclama ownership de la entrada creada", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), codexContext(configDir));

    expect(action).toMatchObject({
      kind: "write",
      target: configFile,
      mcpOwnership: [{ server: "context7", owned: true }],
    });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const context7 = readTomlSection(action.content, "mcp_servers.context7");
    expect(context7).toContain('url = "https://mcp.context7.com/mcp"');
  });

  it("conserva completa una entrada Context7 compatible sin reclamar ownership", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const previous = [
      'model = "user/model"',
      "model_context_window = 100",
      "",
      "[mcp_servers.context7]",
      'url = "https://mcp.context7.com/mcp"',
      'http_headers = { "X-User-Setting" = "preserve" }',
      'user_setting = "preserve"',
      "",
      "[mcp_servers.foreign]",
      'command = "foreign-server"',
      "",
    ].join("\n");
    fs.writeFileSync(configFile, previous);

    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), codexContext(configDir));
    expect(action).toMatchObject({ kind: "write", target: configFile });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const context7 = readTomlSection(action.content, "mcp_servers.context7");
    expect(context7).toContain('url = "https://mcp.context7.com/mcp"');
    expect(context7).toContain('http_headers = { "X-User-Setting" = "preserve" }');
    expect(context7).toContain('user_setting = "preserve"');
    expect(readTomlSection(action.content, "mcp_servers.foreign")).toContain('command = "foreign-server"');
    expect(action).not.toHaveProperty("mcpOwnership");
  });

  it("preserva la tabla Context7 y sus tablas hijas, liberando ownership explícito", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const previous = [
      'model = "user/model"',
      "model_context_window = 100",
      "",
      "[mcp_servers.context7]",
      'url = "https://mcp.context7.com/mcp"',
      'env_http_headers = { "CONTEXT7_API_KEY" = "CONTEXT7_API_KEY" }',
      "",
      "[mcp_servers.context7.http_headers]",
      '"X-Workspace" = "workspace"',
      "",
      "[mcp_servers.foreign]",
      'command = "foreign-server"',
      "",
    ].join("\n");
    fs.writeFileSync(configFile, previous);
    const mcp = loadCanonicalMcp(stackRoot());
    const ownedContext = { ...codexContext(configDir), ownedMcpServers: new Set(["context7"]) };

    const [syncAction] = codexAdapter.planMainConfig(mcp, ownedContext);
    expect(syncAction).toMatchObject({
      kind: "write",
      mcpOwnership: [{ server: "context7", owned: false }],
    });
    if (syncAction?.kind !== "write") throw new Error("Expected a Context7 sync write");
    expect(syncAction.content).toContain('[mcp_servers.context7]\n');
    expect(syncAction.content).toContain('url = "https://mcp.context7.com/mcp"');
    expect(syncAction.content).toContain('[mcp_servers.context7.http_headers]\n');
    expect(syncAction.content).toContain('"X-Workspace" = "workspace"');

    const uninstallAction = codexAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), ownedContext)
      .find((candidate) => candidate.target === configFile);
    expect(uninstallAction).toMatchObject({
      kind: "write",
      mcpOwnership: [{ server: "context7", owned: false }],
    });
    if (uninstallAction?.kind !== "write") throw new Error("Expected a Context7 uninstall write");
    expect(uninstallAction.content).toContain('[mcp_servers.context7]\n');
    expect(uninstallAction.content).toContain('url = "https://mcp.context7.com/mcp"');
    expect(uninstallAction.content).toContain('[mcp_servers.context7.http_headers]\n');
    expect(uninstallAction.content).toContain('"X-Workspace" = "workspace"');
  });

  it("bloquea una tabla hija Context7 sin su tabla padre", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const previous = [
      'model = "user/model"',
      "model_context_window = 100",
      "",
      "[mcp_servers.context7.http_headers]",
      '"X-Workspace" = "workspace"',
      "",
    ].join("\n");
    fs.writeFileSync(configFile, previous);

    expect(() => codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), codexContext(configDir)))
      .toThrow(/context7|parent|table|header|conflict/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(previous);
  });

  it.each([
    {
      label: "sin URL real",
      section: [
        "[mcp_servers.context7]",
        "note = '''",
        'url = "https://mcp.context7.com/mcp"',
        "'''",
      ].join("\n"),
    },
    {
      label: "URL falsa antes del endpoint incompatible",
      section: [
        "[mcp_servers.context7]",
        "note = '''",
        'url = "https://mcp.context7.com/mcp"',
        "'''",
        'url = "https://example.invalid/foreign-context7"',
      ].join("\n"),
    },
  ])("no trata una URL en una nota multilínea como registro real ($label)", ({ section }) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const previous = [
      'model = "user/model"',
      "model_context_window = 100",
      "",
      section,
      "",
    ].join("\n");
    fs.writeFileSync(configFile, previous);

    expect(() => codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), codexContext(configDir)))
      .toThrow(/context7|endpoint|url|conflict|collision/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(previous);
  });

  it.each([
    {
      label: "otro endpoint",
      section: [
        "[mcp_servers.context7]",
        'url = "https://example.invalid/user-context7"',
        'user_setting = "preserve"',
      ].join("\n"),
    },
    {
      label: "deshabilitación nativa",
      section: [
        "[mcp_servers.context7]",
        'url = "https://mcp.context7.com/mcp"',
        "enabled = false",
      ].join("\n"),
    },
    {
      label: "deshabilitación nativa con tipo inválido",
      section: [
        "[mcp_servers.context7]",
        'url = "https://mcp.context7.com/mcp"',
        'enabled = "false"',
      ].join("\n"),
    },
    {
      label: "otro tipo",
      section: [
        "[mcp_servers.context7]",
        'command = "foreign-context7"',
      ].join("\n"),
    },
  ])("bloquea la colisión Context7 por $label sin mutar la configuración", ({ section }) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    const previous = [
      'model = "user/model"',
      "model_context_window = 100",
      "",
      section,
      "",
      "[mcp_servers.foreign]",
      'command = "foreign-server"',
      "",
    ].join("\n");
    fs.writeFileSync(configFile, previous);

    expect(() => codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), codexContext(configDir)))
      .toThrow(/context7|endpoint|enabled|conflict|collision/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(previous);
  });
});

describe("codexAdapter official Engram MCP preservation", () => {
  const ENGRAM_BIN = "/opt/engram";

  function writeOfficialConfig(configFile: string, engramSection: string | null): void {
    // Plugin oficial activo ([plugins."engram@main"] sin enabled=false) +
    // bloque ajeno que debe preservarse. El plugin NO trae MCP bundled:
    // `engram setup codex` registra un MCP user separado.
    const parts = [
      'model = "user/model"',
      "model_context_window = 100",
      "",
      '[plugins."engram@main"]',
      "",
    ];
    if (engramSection !== null) {
      parts.push("[mcp_servers.engram]", engramSection, "");
    }
    parts.push('[mcp_servers.ajeno]', 'command = "x"', "");
    fs.writeFileSync(configFile, parts.join("\n"));
  }

  function officialCtx(configDir: string, owned: string[] = []) {
    return {
      ...codexContext(configDir),
      engramBin: ENGRAM_BIN,
      ownedMcpServers: new Set(owned),
    };
  }

  it("con plugin activo y MCP oficial exacto preserva sección y libera ownership (idempotente)", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    writeOfficialConfig(configFile, `command = ${JSON.stringify(ENGRAM_BIN)}\nargs = ["mcp", "--tools=agent"]`);

    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), officialCtx(configDir, ["engram"]));
    if (action?.kind !== "write") throw new Error("Expected a config write");
    const section = readTomlSection(action.content, "mcp_servers.engram");
    // Preserva, no borra; libera el ownership previo del Stack.
    expect(section).not.toBeNull();
    expect(section).toContain(JSON.stringify(ENGRAM_BIN));
    expect(section).toContain('"mcp"');
    expect(section).toContain('"--tools=agent"');
    expect(readTomlSection(action.content, "mcp_servers.ajeno")).toContain('command = "x"');
    expect(action.mcpOwnership).toEqual(expect.arrayContaining([{ server: "engram", owned: false }]));

    // Idempotente tras el setup oficial real: el siguiente sync no muta.
    fs.writeFileSync(configFile, action.content);
    const [action2] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), officialCtx(configDir, []));
    if (action2?.kind !== "write") throw new Error("Expected a config write");
    expect(action2.content).toBe(action.content);
    expect(readTomlSection(action2.content, "mcp_servers.engram")).toContain(JSON.stringify(ENGRAM_BIN));
  });

  it("con plugin activo y MCP ausente no lo recrea (setup incompleto lo cubre doctor/install)", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    writeOfficialConfig(configFile, null);

    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), officialCtx(configDir, []));
    if (action?.kind !== "write") throw new Error("Expected a config write");
    expect(readTomlSection(action.content, "mcp_servers.engram")).toBeNull();
    expect(readTomlSection(action.content, "mcp_servers.ajeno")).toContain('command = "x"');
  });

  it("con plugin activo y MCP foráneo lo preserva", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "config.toml");
    writeOfficialConfig(configFile, 'command = "/foreign/bin"\nargs = ["mcp", "--tools=agent"]');

    const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), officialCtx(configDir, ["engram"]));
    if (action?.kind !== "write") throw new Error("Expected a config write");
    const section = readTomlSection(action.content, "mcp_servers.engram");
    expect(section).not.toBeNull();
    expect(section).toContain('"/foreign/bin"');
    expect(readTomlSection(action.content, "mcp_servers.ajeno")).toContain('command = "x"');
  });
});
