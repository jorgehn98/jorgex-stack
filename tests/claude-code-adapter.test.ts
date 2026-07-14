import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import type { InstallContext } from "../src/adapters/types.js";
import type { CanonicalAgent } from "../src/lib/canonical.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "../src/lib/canonical.js";
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
  it("el primary (orchestrator) es un output style wrapper; la skill canónica la instala planSkills", () => {
    const out = claudeCodeAdapter.renderAgent(agent({
      name: "orchestrator",
      mode: "primary",
      body: "Load and follow the `orchestrator` skill.",
    }), MODELS);
    expect(out).toHaveLength(1);

    const style = out[0]!;
    expect(style.kind).toBe("output-style");
    expect(style.file).toBe("orchestrator.md");
    expect(style.content).toContain("name: Orchestrator");
    expect(style.content).toContain("keep-coding-instructions: true");
    expect(style.content).toContain("Load and follow the `orchestrator` skill");
    expect(style.content).not.toContain("## Phases");
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

describe("claudeCodeAdapter.planHooks: permissions por defecto", () => {
  let tmp: string;
  let configDir: string;
  let settingsFile: string;

  const makeCtx = (overrides: Partial<InstallContext> = {}): InstallContext => ({
    stackDir: stackRoot(),
    configDir,
    engramBin: "/opt/engram",
    models: MODELS,
    warnings: [],
    ...overrides,
  });

  const run = (ctx: InstallContext): { content: string; settings: Record<string, unknown>; warnings: string[] } => {
    const [action] = claudeCodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), ctx);
    const content = (action as { content: string }).content;
    return { content, settings: JSON.parse(content) as Record<string, unknown>, warnings: [...ctx.warnings] };
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cc-perm-"));
    configDir = path.join(tmp, ".claude");
    settingsFile = path.join(configDir, "settings.json");
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("la config fresca mezcla hooks con permissions read-anywhere y denies de .env", () => {
    const { settings, content } = run(makeCtx());
    expect(settings).toHaveProperty("hooks");
    expect(settings).toHaveProperty("permissions");

    const permissions = settings.permissions as { allow?: string[]; ask?: string[]; deny?: string[] };
    expect(permissions.allow).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(permissions.allow).not.toContain(tool);
    }
    expect(permissions.ask).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "WebSearch"]));
    expect(permissions.deny).toEqual(
      expect.arrayContaining(["Read(//**/.env)", "Read(//**/.env.*)", "Bash(format:*)", "Bash(mkfs:*)"]),
    );
    expect(content).not.toContain("disableBypassPermissionsMode");
  });

  it("la config fresca también avisa y endurece secretos más allá de .env", () => {
    const { settings, warnings } = run(makeCtx());
    const permissions = settings.permissions as { deny?: string[] };

    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(//**/.ssh/**)",
        "Read(//**/.aws/credentials)",
        "Read(//**/.npmrc)",
        "Read(//**/.git-credentials)",
        "Read(//**/id_rsa)",
        "Read(//**/id_ed25519)",
        "Read(//**/*.pem)",
        "Read(//**/*.key)",
      ]),
    );
    expect(warnings.join("\n")).toMatch(/read-anywhere|broad/i);
  });

  it("la config fresca ya no concede escritura, shell ni egress web; las manda a ask", () => {
    const { settings } = run(makeCtx());
    const permissions = settings.permissions as { allow?: string[]; ask?: string[] };

    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(permissions.allow).not.toContain(tool);
    }
    expect(permissions.ask).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "WebSearch"]));
  });

  it("la config no vacía sin permissions no recibe permissions", () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ other: true }));

    const { settings } = run(makeCtx());

    expect(settings.other).toBe(true);
    expect(settings).not.toHaveProperty("permissions");
  });

  it("preserva permisos custom y no auto-migra el legacy exacto", () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        permissions: {
          allow: ["Bash", "Edit"],
          deny: ["Bash(shred:*)"],
        },
        hooks: { existing: [] },
      }),
    );

    const custom = run(makeCtx());
    expect(custom.settings.permissions).toEqual({ allow: ["Bash", "Edit"], deny: ["Bash(shred:*)"] });
    expect(custom.settings).toHaveProperty("hooks");

    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        permissions: {
          allow: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
          ask: ["Bash(rm:*)", "Bash(rmdir:*)", "Bash(del:*)", "Bash(git push --force:*)"],
          deny: ["Bash(format:*)", "Bash(mkfs:*)", "Bash(dd:*)", "Bash(shred:*)", "Read(./.env)", "Read(./.env.*)"],
        },
      }),
    );

    const legacy = run(makeCtx());
    expect(legacy.settings.permissions).toEqual({
      allow: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
      ask: ["Bash(rm:*)", "Bash(rmdir:*)", "Bash(del:*)", "Bash(git push --force:*)"],
      deny: ["Bash(format:*)", "Bash(mkfs:*)", "Bash(dd:*)", "Bash(shred:*)", "Read(./.env)", "Read(./.env.*)"],
    });
  });
});
