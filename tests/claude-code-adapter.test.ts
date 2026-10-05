import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import type { InstallContext } from "../src/adapters/types.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "../src/lib/canonical.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

const MODELS: RuntimeModelMap = {
  strong: { model: "fable" },
  standard: { model: "sonnet" },
  cheap: { model: "haiku" },
};


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

  it("proyecta Context7 HTTP y deja Engram íntegramente al setup oficial", () => {
    const { servers } = run(makeCtx());
    expect(servers.engram).toBeUndefined();
    expect(servers.context7!.type).toBe("http");
  });

  it("con plugin oficial activo y MCP oficial exacto preserva bytes sin reclamar ownership (idempotente)", () => {
    // Plugin oficial presente (registry v2 engram@engram) + MCP exacto de
    // `engram setup claude-code`. El plugin NO trae MCP bundled: el setup
    // registra un MCP user separado que el sync debe preservar.
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "engram@engram": [{ scope: "user", version: "0.1.3" }] } }),
    );
    const engramBin = "/opt/engram";
    const previous = {
      mcpServers: {
        engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"] },
        ajeno: { type: "http", url: "https://x" },
      },
    };
    fs.writeFileSync(mainFile, JSON.stringify(previous));
    const ctx = makeCtx({ engramBin, ownedMcpServers: new Set(["engram"]) });
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    if (action?.kind !== "write") throw new Error("Expected a config write");
    const servers = (JSON.parse(action.content) as { mcpServers: Record<string, unknown> }).mcpServers;
    // La proyección no posee ni reescribe el registro oficial.
    expect(servers["engram"]).toEqual(previous.mcpServers.engram);
    expect(servers["ajeno"]).toEqual(previous.mcpServers.ajeno);
    expect(action.mcpOwnership?.some((change) => change.server === "engram")).not.toBe(true);
    // Idempotente tras el setup oficial real: el siguiente sync no muta.
    fs.writeFileSync(mainFile, action.content);
    const ctx2 = makeCtx({ engramBin, ownedMcpServers: new Set() });
    const [action2] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx2);
    if (action2?.kind !== "write") throw new Error("Expected a config write");
    expect(action2.content).toBe(action.content);
    expect((JSON.parse(action2.content) as { mcpServers: Record<string, unknown> }).mcpServers["engram"]).toEqual(
      previous.mcpServers.engram,
    );
  });

  it("con plugin oficial activo y MCP ausente no lo recrea (setup incompleto lo cubre doctor/install)", () => {
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "engram@engram": [{ scope: "user", version: "0.1.3" }] } }),
    );
    fs.writeFileSync(mainFile, JSON.stringify({ mcpServers: { ajeno: { type: "http", url: "https://x" } } }));
    const ctx = makeCtx({ engramBin: "/opt/engram" });
    const { servers } = run(ctx);
    expect(servers["engram"]).toBeUndefined();
    expect(servers["ajeno"]).toEqual({ type: "http", url: "https://x" });
  });

  it("con plugin oficial activo y MCP foráneo lo preserva", () => {
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "engram@engram": [{ scope: "user", version: "0.1.3" }] } }),
    );
    const foreign = { type: "stdio", command: "/foreign/bin", args: ["mcp", "--tools=agent"] };
    fs.writeFileSync(
      mainFile,
      JSON.stringify({ mcpServers: { engram: foreign, ajeno: { type: "http", url: "https://x" } } }),
    );
    const ctx = makeCtx({ engramBin: "/opt/engram", ownedMcpServers: new Set(["engram"]) });
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
    if (action?.kind !== "write") throw new Error("Expected a config write");
    const servers = (JSON.parse(action.content) as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers["engram"]).toEqual(foreign);
    expect(servers["ajeno"]).toEqual({ type: "http", url: "https://x" });
  });

  it("sin binario de Engram no fabrica un registro MCP paralelo", () => {
    const ctx = makeCtx({ engramBin: null });
    const { servers } = run(ctx);
    expect(servers.engram).toBeUndefined();
    expect(servers.context7!.type).toBe("http");
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
    expect(servers.engram).toBeUndefined();
  });

  it("registra Context7 ausente y reclama ownership solo después de crear su entrada", () => {
    const ctx = makeCtx();
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);

    expect(action).toMatchObject({
      kind: "write",
      mcpOwnership: [{ server: "context7", owned: true }],
    });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const root = JSON.parse(action.content) as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    expect(root.mcpServers?.context7).toMatchObject({
      type: "http",
      url: "https://mcp.context7.com/mcp",
    });
  });

  it("conserva completa una entrada Context7 compatible y la deshabilitación por proyecto", () => {
    const previous = {
      mcpServers: {
        context7: {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          headers: { "X-User-Setting": "preserve" },
          userSetting: "preserve",
        },
        ajeno: { type: "http", url: "https://example.invalid/foreign" },
      },
      projects: {
        "/tmp/project": {
          disabledMcpServers: ["context7"],
          userSetting: "preserve",
        },
      },
    };
    fs.writeFileSync(mainFile, JSON.stringify(previous, null, 2) + "\n");

    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx());
    expect(action).toMatchObject({ kind: "write" });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const result = JSON.parse(action.content) as typeof previous & { mcpOwnership?: unknown };
    expect(result.mcpServers?.context7).toEqual(previous.mcpServers.context7);
    expect(result.mcpServers?.ajeno).toEqual(previous.mcpServers.ajeno);
    expect(result.projects).toEqual(previous.projects);
    expect(action).not.toHaveProperty("mcpOwnership");
  });

  it("bloquea una colisión Context7 de otro endpoint sin mutar la configuración", () => {
    const previous = JSON.stringify({
      mcpServers: {
        context7: {
          type: "http",
          url: "https://example.invalid/user-context7",
          userSetting: "preserve",
        },
      },
    }, null, 2) + "\n";
    fs.writeFileSync(mainFile, previous);

    expect(() => claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx()))
      .toThrow(/context7|endpoint|conflict|collision/i);
    expect(fs.readFileSync(mainFile, "utf8")).toBe(previous);
  });

  it("bloquea una colisión Context7 de otro tipo sin mutar la configuración", () => {
    const previous = JSON.stringify({
      mcpServers: {
        context7: { type: "stdio", command: "foreign-context7", userSetting: "preserve" },
      },
    }, null, 2) + "\n";
    fs.writeFileSync(mainFile, previous);

    expect(() => claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx()))
      .toThrow(/context7|type|conflict|collision/i);
    expect(fs.readFileSync(mainFile, "utf8")).toBe(previous);
  });

  it.each(["[]", '{"broken": UNTRUSTED_CONFIG_VALUE}'])("rechaza la raíz MCP inválida sin mostrar contenido: %s", (raw) => {
    fs.writeFileSync(mainFile, raw);
    let message = "";
    try { claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx()); } catch (error) { message = String(error); }
    expect(message).toMatch(/MCP/);
    expect(message).not.toContain("UNTRUSTED_CONFIG_VALUE");
    expect(fs.readFileSync(mainFile, "utf8")).toBe(raw);
  });

  it.each([
    { label: "contenedor array", config: { mcpServers: [] as unknown[] } },
    { label: "contenedor null", config: { mcpServers: null } },
    { label: "entrada array", config: { mcpServers: { context7: [] as unknown[] } } },
    { label: "entrada null", config: { mcpServers: { context7: null } } },
  ])("rechaza Context7 cuando el $label no es un objeto MCP verificable", ({ config }) => {
    const previous = JSON.stringify(config, null, 2) + "\n";
    fs.writeFileSync(mainFile, previous);

    expect(() => claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), makeCtx()))
      .toThrow(/context7|mcp|object|array|conflict/i);
    expect(fs.readFileSync(mainFile, "utf8")).toBe(previous);
  });
});

describe("claudeCodeAdapter.planMainConfig: permissions por defecto", () => {
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
    const [action] = claudeCodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx).filter((action) => action.target.endsWith("settings.json"));
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

  it("la config fresca siembra permissions sin hooks propios read-anywhere y denies de .env", () => {
    const { settings, content } = run(makeCtx());
    expect(settings).not.toHaveProperty("hooks");
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
