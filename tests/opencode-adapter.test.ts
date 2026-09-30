import fs from "node:fs";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { loadCanonicalAgents, loadCanonicalHooks, loadCanonicalMcp, type CanonicalAgent } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP, resolveAgentModel, type RuntimeModelMap } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function opencodeContext(configDir: string) {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: MODELS,
    warnings: [],
  };
}

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-opencode-sol-"));
  tempDirs.push(dir);
  return dir;
}

function writeActionContent(actions: ReturnType<typeof opencodeAdapter.planMainConfig>, target: string): string {
  const action = actions.find((candidate) => candidate.kind === "write" && candidate.target === target);
  if (action?.kind !== "write") throw new Error(`Missing write action for ${target}`);
  return action.content;
}

function primaryOwnership(actions: ReturnType<typeof opencodeAdapter.planMainConfig>, target: string): ReadonlySet<string> {
  const action = actions.find((candidate) => candidate.kind === "write" && candidate.target === target);
  if (action?.kind !== "write") throw new Error(`Missing write action for ${target}`);
  return new Set((action.primaryModelOwnership ?? []).filter((change) => change.owned).map((change) => change.field));
}

/** Delimitador del frontmatter del agente: recorte, no un parser YAML. */
function frontmatter(content: string): string {
  const end = content.indexOf("\n---", 3);
  if (!content.startsWith("---\n") || end === -1) throw new Error("Agente sin frontmatter delimitado");
  return content.slice(4, end);
}

/**
 * Valor escalar de un campo del header tal como lo escribe el adapter:
 * JSON double-quoted (seguro para YAML) o plano. No es un parser YAML.
 */
function decodeScalar(raw: string): string {
  const value = raw.trim();
  return value.startsWith('"') ? JSON.parse(value) as string : value;
}

/** Valor decodificado del primer campo del frontmatter, o undefined si falta. */
function frontmatterField(content: string, field: string): string | undefined {
  const line = frontmatter(content).split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  return line === undefined ? undefined : decodeScalar(line.slice(field.length + 1));
}

/** Prefijo seguro canónico de Git compartido por los seis comandos read-only. */
const GIT_READ_PREFIX = "git --no-pager -c core.fsmonitor=false -c log.showSignature=false";

interface NativePermissionRule {
  action: string;
  resource: string;
  effect: string;
}

/**
 * Permisos nativos del frontmatter: array ordenado de reglas. La fuente lo
 * serializa como YAML JSON flow (documentado), así que se parsea esa línea como
 * JSON; no se inventa un parser YAML ni se añaden dependencias.
 */
function nativePermissions(content: string): NativePermissionRule[] {
  const lines = frontmatter(content).split("\n");
  expect(lines.some((line) => line.startsWith("permission:")), "sin campo legacy `permission:`").toBe(false);
  const line = lines.find((candidate) => candidate.startsWith("permissions:"));
  if (line === undefined) throw new Error("falta el campo nativo `permissions:`");
  const parsed = JSON.parse(line.slice("permissions:".length).trim()) as unknown;
  expect(Array.isArray(parsed), "`permissions` debe ser un array JSON flow (validación de host después del GREEN)").toBe(true);
  return parsed as NativePermissionRule[];
}

const MODELS: RuntimeModelMap = {
  strong: { model: "provider/strong", variant: "high" },
  standard: { model: "provider/standard", variant: "medium" },
  cheap: { model: "provider/cheap" },
};

function agent(overrides: Partial<CanonicalAgent>): CanonicalAgent {
  return {
    name: "demo",
    description: "Demo agent",
    mode: "subagent",
    tier: "standard",
    readonly: false,
    bash: "full",
    spawn: true,
    body: "\n# Demo\n\nBody.\n",
    ...overrides,
  };
}

describe("opencodeAdapter.renderAgent: barrera de git destructivo", () => {
  it("renders the OpenCode models explicitly selected by the user", () => {
    const [standard] = opencodeAdapter.renderAgent(
      agent({ name: "implementer", tier: "standard" }),
      MODELS,
    );
    // El ID exacto se compara decodificando el escalar del header, nunca por
    // texto sin comillas (el `#` del tag no debe ser un comentario YAML).
    expect(frontmatterField(standard!.content, "model")).toBe("provider/standard#medium");
    expect(frontmatter(standard!.content)).not.toMatch(/^variant:/m);

    const [cheap] = opencodeAdapter.renderAgent(
      agent({ name: "engram", tier: "cheap" }),
      MODELS,
    );
    expect(frontmatterField(cheap!.content, "model")).toBe("provider/cheap");
    expect(frontmatter(cheap!.content)).not.toMatch(/^variant:/m);
  });

  it("full-bash inherits the general policy without overriding its asks or denies", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ bash: "full" }), MODELS);
    expect(out!.content).not.toMatch(/\n  (bash|edit|shell|subagent):/);
    expect(frontmatter(out!.content).split("\n").some((line) => line.startsWith("permissions:") || line.startsWith("permission:"))).toBe(false);
  });

  it("git-read deniega shell arbitrario y fija las opciones Git antes de argumentos variables", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    const rules = nativePermissions(out!.content);
    const shell = rules.filter((rule) => rule.action === "shell");

    // Deny global primero y sin asks: los seis prefijos seguros son la única allow.
    expect(shell[0]).toEqual({ action: "shell", resource: "*", effect: "deny" });
    expect(rules.filter((rule) => rule.effect === "ask")).toEqual([]);

    const allows = shell.filter((rule) => rule.effect === "allow").map((rule) => rule.resource);
    expect(allows.length).toBeGreaterThanOrEqual(6);
    for (const resource of allows) {
      expect(resource, resource).toContain("core.fsmonitor=false");
      expect(resource, resource).toContain("log.showSignature=false");
      expect(resource, resource).toContain("--no-ext-diff --no-textconv --end-of-options");
    }
    // Con argumentos variables después de `--end-of-options`…
    expect(allows.some((resource) => resource.endsWith(" *"))).toBe(true);
    // …y sin wildcards que Git pudiera interpretar como opciones.
    expect(allows.some((resource) => /^git diff\*/.test(resource))).toBe(false);
    expect(out!.content).toContain("put refs and paths after --end-of-options");
  });

  it("none: shell denegado por completo", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "none" }), MODELS);
    const rules = nativePermissions(out!.content);
    expect(rules.filter((rule) => rule.action === "shell")).toEqual([{ action: "shell", resource: "*", effect: "deny" }]);
    expect(rules.some((rule) => rule.resource.includes("git reset"))).toBe(false);
  });

  it.each([
    ["readonly", true],
    ["writer", false],
  ] as const)("%s usa el deny nativo de `edit` sin renderizar el bloque tools deprecado", (_label, readonly) => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly }), MODELS);
    const content = out!.content;

    if (readonly) {
      expect(nativePermissions(content).some((rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny")).toBe(true);
    } else {
      // Un rol full-trust no necesita bloque propio: hereda la política general.
      expect(frontmatter(content).split("\n").some((line) => line.startsWith("permissions:"))).toBe(false);
    }
    expect(content).not.toMatch(/^tools:/m);
  });

  it("primary no fija permisos (usa los defaults globales)", () => {
    const [out] = opencodeAdapter.renderAgent(agent({
      name: "orchestrator",
      mode: "primary",
      body: "Load and follow the `orchestrator` skill.",
    }), MODELS);
    expect(out!.content).toContain("Load and follow the `orchestrator` skill");
    expect(out!.content).not.toContain("## Phases");
    expect(out!.content).not.toContain("permission:");
    expect(out!.content).not.toContain("model:");
    expect(out!.content).not.toContain("variant:");
    expect(out!.content).not.toContain('"git reset*": deny');
  });
});

describe("opencodeAdapter primary Sol defaults", () => {
  it("añade límites ausentes, es idempotente y limpia solo valores canónicos", () => {
    const freshDir = tempConfigDir();
    const freshFile = path.join(freshDir, "opencode.json");
    const freshActions = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(freshDir));
    const fresh = JSON.parse(writeActionContent(freshActions, freshFile)) as Record<string, any>;
    expect(fresh.model).toBe("openai/gpt-6.1-sol");
    expect(fresh.providers.openai.models["gpt-6.1-sol"].limit.context).toBe(872000);
    // ID de ownership v2 file-qualificado: JSON.stringify([basename, ...segmentos]).
    const freshOwnership = primaryOwnership(freshActions, freshFile);
    expect(freshOwnership.has(JSON.stringify(["opencode.json", "model"]))).toBe(true);
    expect(freshOwnership.has(
      JSON.stringify(["opencode.json", "providers", "openai", "models", "gpt-6.1-sol", "limit", "context"]),
    )).toBe(true);

    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const ctx = opencodeContext(configDir);
    const mcp = loadCanonicalMcp(stackRoot());

    const legacyProvider = { custom: { npm: "@example/custom-provider", options: { baseURL: "https://example.invalid/v1" } } };
    fs.writeFileSync(configFile, JSON.stringify({
      foreign: { kept: true },
      provider: legacyProvider,
    }, null, 2));
    const installActions = opencodeAdapter.planMainConfig(mcp, ctx);
    const installed = writeActionContent(installActions, configFile);
    const parsed = JSON.parse(installed) as Record<string, any>;

    expect(parsed.model).toBe("openai/gpt-6.1-sol");
    expect(parsed.providers.openai.models["gpt-6.1-sol"].limit).toEqual({
      context: 872000,
      input: 744000,
      output: 128000,
    });
    expect(parsed.foreign).toEqual({ kept: true });
    expect(parsed.provider).toEqual(legacyProvider);

    fs.writeFileSync(configFile, installed);
    expect(writeActionContent(opencodeAdapter.planMainConfig(mcp, ctx), configFile)).toBe(installed);

    parsed.model = "user/model";
    parsed.providers.openai.models["gpt-6.1-sol"].limit.context = 900000;
    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2));
    const unmerged = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...ctx,
        ownedPrimaryModelFields: primaryOwnership(installActions, configFile),
      }),
      configFile,
    )) as Record<string, any>;

    expect(unmerged.model).toBe("user/model");
    expect(unmerged.providers.openai.models["gpt-6.1-sol"].limit).toEqual({ context: 900000 });
    expect(unmerged.foreign).toEqual({ kept: true });
    expect(unmerged.provider).toEqual(legacyProvider);

    const preexistingDir = tempConfigDir();
    const preexistingFile = path.join(preexistingDir, "opencode.json");
    const preexisting = {
      model: "openai/gpt-6.1-sol",
      providers: { openai: { models: { "gpt-6.1-sol": { limit: { context: 872000, input: 744000, output: 128000 } } } } },
    };
    fs.writeFileSync(preexistingFile, JSON.stringify(preexisting, null, 2));
    const preexistingActions = opencodeAdapter.planMainConfig(mcp, opencodeContext(preexistingDir));
    const preexistingOwnership = primaryOwnership(preexistingActions, preexistingFile);
    // Un valor igual preexistente no se reclama (model/providers completos)…
    const preexistingModelProviderIds = [
      ["model"],
      ["providers"],
      ["providers", "openai"],
      ["providers", "openai", "models"],
      ["providers", "openai", "models", "gpt-6.1-sol"],
      ["providers", "openai", "models", "gpt-6.1-sol", "limit"],
      ["providers", "openai", "models", "gpt-6.1-sol", "limit", "context"],
      ["providers", "openai", "models", "gpt-6.1-sol", "limit", "input"],
      ["providers", "openai", "models", "gpt-6.1-sol", "limit", "output"],
    ].map((segments) => JSON.stringify(["opencode.json", ...segments]));
    expect([...preexistingOwnership].filter((id) => preexistingModelProviderIds.includes(id))).toEqual([]);
    // …pero los defaults de servidor que SÍ se crean quedan owned file-qualified.
    for (const segments of [
      ["update"],
      ["agents", "plan", "disabled"],
      ["agents", "title", "model"],
      ["agents", "summary", "model"],
      ["compaction", "auto"],
      ["compaction", "keep", "tokens"],
      ["formatter"],
      ["lsp"],
      ["worktree", "directory"],
    ]) {
      expect(preexistingOwnership.has(JSON.stringify(["opencode.json", ...segments])), segments.join(".")).toBe(true);
    }
    fs.writeFileSync(preexistingFile, writeActionContent(preexistingActions, preexistingFile));
    const preserved = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), opencodeContext(preexistingDir)),
      preexistingFile,
    ));
    expect(preserved).toMatchObject(preexisting);

    const emptyTreeDir = tempConfigDir();
    const emptyTreeFile = path.join(emptyTreeDir, "opencode.json");
    const emptyTree = { providers: { openai: { models: {} } } };
    fs.writeFileSync(emptyTreeFile, JSON.stringify(emptyTree, null, 2));
    const emptyTreeActions = opencodeAdapter.planMainConfig(mcp, opencodeContext(emptyTreeDir));
    fs.writeFileSync(emptyTreeFile, writeActionContent(emptyTreeActions, emptyTreeFile));
    const emptyTreeUnmerged = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...opencodeContext(emptyTreeDir),
        ownedPrimaryModelFields: primaryOwnership(emptyTreeActions, emptyTreeFile),
      }),
      emptyTreeFile,
    ));
    expect(emptyTreeUnmerged.providers).toEqual(emptyTree.providers);

    const removedLimitDir = tempConfigDir();
    const removedLimitFile = path.join(removedLimitDir, "opencode.json");
    const removedLimitActions = opencodeAdapter.planMainConfig(mcp, opencodeContext(removedLimitDir));
    const removedLimitConfig = JSON.parse(writeActionContent(removedLimitActions, removedLimitFile));
    delete removedLimitConfig.providers.openai.models["gpt-6.1-sol"].limit;
    fs.writeFileSync(removedLimitFile, JSON.stringify(removedLimitConfig, null, 2));
    const removedLimitUnmerged = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...opencodeContext(removedLimitDir),
        ownedPrimaryModelFields: primaryOwnership(removedLimitActions, removedLimitFile),
      }),
      removedLimitFile,
    ));
    expect(removedLimitUnmerged.providers).toBeUndefined();

    const malformedDir = tempConfigDir();
    fs.writeFileSync(path.join(malformedDir, "opencode.json"), JSON.stringify({ model: false }));
    expect(() => opencodeAdapter.planMainConfig(mcp, opencodeContext(malformedDir)))
      .toThrow("'model' debe ser un identificador provider/model no vacío");
  });
});

describe("opencodeAdapter Context7 registration safety", () => {
  it("registra Context7 ausente y reclama ownership de la entrada creada", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));

    expect(action).toMatchObject({
      kind: "write",
      target: configFile,
      mcpOwnership: [{ server: "context7", owned: true }],
    });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const root = JSON.parse(action.content) as {
      mcp?: { servers?: Record<string, { type?: string; url?: string }>; context7?: unknown };
    };
    expect(root.mcp?.servers?.context7).toMatchObject({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
    });
    expect(root.mcp?.context7).toBeUndefined();
  });

  it("conserva completa una entrada Context7 nativa compatible sin reclamar ownership", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const previous = {
      model: "user/model",
      providers: { user: { setting: "preserve" } },
      mcp: {
        servers: {
          context7: {
            type: "remote",
            url: "https://mcp.context7.com/mcp",
            headers: { "X-User-Setting": "preserve" },
            userSetting: "preserve",
          },
          foreign: { type: "remote", url: "https://example.invalid/foreign" },
        },
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(previous, null, 2) + "\n");

    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));
    expect(action).toMatchObject({ kind: "write", target: configFile });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const result = JSON.parse(action.content) as typeof previous;
    expect(result.mcp.servers.context7).toEqual(previous.mcp.servers.context7);
    expect(result.mcp.servers.foreign).toEqual(previous.mcp.servers.foreign);
    expect(result.providers.user).toEqual(previous.providers.user);
    expect(action).not.toHaveProperty("mcpOwnership");
  });

  it("con una entrada legacy plana compatible no crea un duplicado nativo que la oculte", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const legacyContext7 = {
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      headers: { "X-User-Setting": "preserve" },
      userSetting: "preserve",
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify({ model: "user/model", mcp: { context7: legacyContext7, foreign: { type: "remote", url: "https://example.invalid/foreign" } } }, null, 2) + "\n",
    );

    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");
    const result = JSON.parse(action.content) as {
      mcp: { context7?: unknown; foreign?: unknown; servers?: unknown };
    };

    expect(result.mcp.context7).toEqual(legacyContext7);
    expect(result.mcp.foreign).toEqual({ type: "remote", url: "https://example.invalid/foreign" });
    expect(result.mcp.servers).toBeUndefined();
    expect(action).not.toHaveProperty("mcpOwnership");
  });

  it.each([
    {
      label: "otro endpoint",
      context7: {
        type: "remote",
        url: "https://example.invalid/user-context7",
        userSetting: "preserve",
      },
    },
    {
      label: "deshabilitación nativa",
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        enabled: false,
      },
    },
    {
      label: "deshabilitación nativa con tipo inválido",
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        enabled: "false",
      },
    },
    {
      label: "otro tipo",
      context7: {
        type: "local",
        command: ["foreign-context7"],
      },
    },
  ])("bloquea la colisión Context7 por $label sin mutar la configuración", ({ context7 }) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const previous = {
      model: "user/model",
      mcp: { context7, foreign: { type: "remote", url: "https://example.invalid/foreign" } },
    };
    const previousBytes = JSON.stringify(previous, null, 2) + "\n";
    fs.writeFileSync(configFile, previousBytes);

    expect(() => opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)))
      .toThrow(/context7|endpoint|enabled|conflict|collision/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(previousBytes);
  });

  it.each(["[]", '{"broken": UNTRUSTED_CONFIG_VALUE}'])("rechaza la raíz MCP inválida sin mostrar contenido: %s", (raw) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    fs.writeFileSync(configFile, raw);
    let message = "";
    try { opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)); } catch (error) { message = String(error); }
    expect(message).toMatch(/MCP/);
    expect(message).not.toContain("UNTRUSTED_CONFIG_VALUE");
    expect(fs.readFileSync(configFile, "utf8")).toBe(raw);
  });

  it.each([
    { label: "contenedor array", config: { mcp: [] as unknown[] } },
    { label: "contenedor null", config: { mcp: null } },
    { label: "entrada array", config: { mcp: { context7: [] as unknown[] } } },
    { label: "entrada null", config: { mcp: { context7: null } } },
  ])("rechaza Context7 cuando el $label no es un objeto MCP verificable", ({ config }) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const previous = { model: "user/model", ...config };
    const previousBytes = JSON.stringify(previous, null, 2) + "\n";
    fs.writeFileSync(configFile, previousBytes);

    expect(() => opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)))
      .toThrow(/context7|mcp|object|array|conflict/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(previousBytes);
  });
});


it("Git rejects executable and output options after every rendered read-only prefix", () => {
  const root = tempConfigDir();
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "--quiet", root], { env });
  const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
  const commands = nativePermissions(out!.content)
    .filter((rule) => rule.action === "shell" && rule.effect === "allow")
    .map((rule) => rule.resource)
    .filter((command) => !command.endsWith(" *"));
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    for (const flag of ["--output=forbidden", "--out=forbidden", "--ext-diff", "--textconv", "--no-index", "--show-signature"]) {
      const result = spawnSync("git", [...command.split(" ").slice(1), flag], { cwd: root, env, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect([128, 129], `${command} ${flag}`).toContain(result.status);
      expect(fs.existsSync(path.join(root, "forbidden"))).toBe(false);
    }
  }
});

describe("opencodeAdapter v2: configuración fresca nativa", () => {
  it("emite providers/permissions/mcp.servers sin claves v1 y es byte-idempotente", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const mcp = loadCanonicalMcp(stackRoot());
    const ctx = opencodeContext(configDir);

    const content = writeActionContent(opencodeAdapter.planMainConfig(mcp, ctx), configFile);
    const root = JSON.parse(content) as Record<string, any>;

    // Formato nativo v2 (PRD §Implementation Decisions): providers en plural,
    // permissions como lista ordenada y MCP anidado en mcp.servers.
    expect(root).toMatchObject({
      providers: expect.any(Object),
      permissions: expect.any(Array),
      mcp: { servers: expect.any(Object) },
    });
    expect((root.permissions as unknown[]).length).toBeGreaterThan(0);
    expect(root.mcp.servers.context7).toMatchObject({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
    });

    // Sin emisión legacy v1: provider/permission planos y mcp.<servidor> fuera.
    expect(root.provider).toBeUndefined();
    expect(root.permission).toBeUndefined();
    expect(root.mcp.context7).toBeUndefined();

    // Primary Sol 6.1 con límites explícitos del contrato (T04), en providers.
    expect(root.model).toBe("openai/gpt-6.1-sol");
    expect(root.providers.openai.models["gpt-6.1-sol"].limit).toEqual({
      context: 872000,
      input: 744000,
      output: 128000,
    });

    // Permisos no inertes y con precedencia real (Spec T04:56): la última
    // coincidencia gana. Todo deny de secreto debe ir ANTES de la excepción
    // `*.env.example: allow` para read y edit, y el overlay aprobado no añade
    // ningún `ask`. Valores esperados tomados del contrato, no del algoritmo.
    const permissions = root.permissions as Array<{ action: string; resource: string; effect: string }>;
    const secretPatterns = ["*.env", "*.env.*", "*.ssh/*", "*.aws/credentials", "*.npmrc", "*.git-credentials", "*id_rsa*", "*id_ed25519*", "*.pem", "*.key"];
    for (const action of ["read", "edit"] as const) {
      for (const resource of secretPatterns) {
        expect(permissions).toContainEqual({ action, resource, effect: "deny" });
      }
      const allowIndex = permissions.findIndex((rule) => rule.action === action && rule.resource === "*.env.example" && rule.effect === "allow");
      expect(allowIndex, `${action}: falta la excepción *.env.example`).toBeGreaterThanOrEqual(0);
      const lastDenyIndex = permissions.reduce((last, rule, index) => (rule.action === action && rule.effect === "deny" ? index : last), -1);
      expect(allowIndex, `${action}: la excepción debe ir después de todos los denies`).toBeGreaterThan(lastDenyIndex);
    }
    expect(permissions).toContainEqual({ action: "external_directory", resource: "*", effect: "allow" });
    expect(permissions.some((rule) => rule.effect === "ask"), "el overlay aprobado no añade asks").toBe(false);

    // Segunda planificación sobre el archivo ya escrito: mismos bytes.
    fs.writeFileSync(configFile, content);
    expect(writeActionContent(opencodeAdapter.planMainConfig(mcp, ctx), configFile)).toBe(content);
  });
});

describe("opencodeAdapter v2: preservación JSONC", () => {
  it("conserva comentarios y claves ajenas al escribir opencode.json", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const cliFile = path.join(configDir, "cli.json");
    const original = [
      "// comentario del usuario",
      "{",
      '  "foreign": { "kept": true }, // nota',
      '  "model": "user/model"',
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(configFile, original);

    const mcp = loadCanonicalMcp(stackRoot());
    const actions = opencodeAdapter.planMainConfig(mcp, opencodeContext(configDir));

    // Ninguna copia a otro destino: solo la config del servidor y cli.json.
    expect(actions.filter((action) => action.target !== configFile && action.target !== cliFile)).toEqual([]);

    const content = writeActionContent(actions, configFile);
    expect(content).toContain("// comentario del usuario");
    expect(content).toContain("// nota");
    expect(content).toContain('"kept": true');
    expect(content).toContain('"user/model"');

    // Segunda planificación sobre el archivo escrito: mismos bytes.
    fs.writeFileSync(configFile, content);
    expect(writeActionContent(opencodeAdapter.planMainConfig(mcp, opencodeContext(configDir)), configFile)).toBe(content);
  });
});

describe("opencodeAdapter v2: config nativa opencode.jsonc", () => {
  it("edita el .jsonc existente en su propio archivo, con IDs basename .jsonc y unmerge solo owned", () => {
    const configDir = tempConfigDir();
    const jsoncFile = path.join(configDir, "opencode.jsonc");
    const jsonFile = path.join(configDir, "opencode.json");
    const cliFile = path.join(configDir, "cli.json");
    const original = [
      "// config propia del usuario",
      "{",
      '  "model": "user/model",',
      '  "theme": { "name": "user-theme" }',
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(jsoncFile, original);

    const mcp = loadCanonicalMcp(stackRoot());
    const actions = opencodeAdapter.planMainConfig(mcp, opencodeContext(configDir));

    // La config nativa es la que ya existe: no se crea un segundo archivo que el
    // host no leería (split-brain).
    const content = writeActionContent(actions, jsoncFile);
    expect(actions.some((action) => action.target === jsonFile)).toBe(false);
    expect(actions.some((action) => action.target === cliFile), "el cliente sigue en la raíz correcta").toBe(true);

    // Contenido ajeno preservado y defaults v2 solo en campos ausentes.
    expect(content).toContain("// config propia del usuario");
    expect(content).toContain('"user/model"');
    expect(content).toContain('"user-theme"');
    const parsed = parseJsonc(content) as Record<string, unknown>;
    expect(parsed["model"]).toBe("user/model");
    expect(parsed["formatter"]).toBe(true);

    // IDs file-qualificados con el basename REAL del archivo editado.
    const owned = primaryOwnership(actions, jsoncFile);
    expect(owned).toContain(JSON.stringify(["opencode.jsonc", "formatter"]));
    expect([...owned].some((field) => field.startsWith('["opencode.json"'))).toBe(false);

    // Idempotencia sobre el mismo archivo.
    fs.writeFileSync(jsoncFile, content);
    expect(writeActionContent(opencodeAdapter.planMainConfig(mcp, opencodeContext(configDir)), jsoncFile)).toBe(content);

    // Unmerge: solo retira el campo owned y canónico; lo ajeno (y sus comentarios) queda.
    const unmerged = opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
      ...opencodeContext(configDir),
      ownedPrimaryModelFields: new Set([JSON.stringify(["opencode.jsonc", "formatter"])]),
    });
    const afterUnmerge = writeActionContent(unmerged, jsoncFile);
    expect(afterUnmerge).toContain("// config propia del usuario");
    expect(afterUnmerge).toContain('"user/model"');
    expect(afterUnmerge).toContain('"user-theme"');
    expect((parseJsonc(afterUnmerge) as Record<string, unknown>)["formatter"]).toBeUndefined();
  });

  it("con opencode.json y opencode.jsonc presentes falla cerrado sin fusionar ni ignorar ninguno", () => {
    const configDir = tempConfigDir();
    const jsonFile = path.join(configDir, "opencode.json");
    const jsoncFile = path.join(configDir, "opencode.jsonc");
    const jsonContent = JSON.stringify({ theme: { name: "user-json" } }, null, 2) + "\n";
    const jsoncContent = [
      "// config .jsonc del usuario",
      "{",
      '  "theme": { "name": "user-jsonc" }',
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(jsonFile, jsonContent);
    fs.writeFileSync(jsoncFile, jsoncContent);

    // Selector ambiguo: no se puede saber cuál lee el host, así que la opción
    // conservadora es bloquear con remedio en vez de fusionar o ignorar uno.
    expect(() => opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)))
      .toThrow(/ambig|conflicto|conserva|opencode\.jsonc/i);

    // Ninguno de los dos archivos se toca.
    expect(fs.readFileSync(jsonFile, "utf8")).toBe(jsonContent);
    expect(fs.readFileSync(jsoncFile, "utf8")).toBe(jsoncContent);
  });
});

describe("opencodeAdapter v2: permisos nativos por rol en el frontmatter", () => {
  function canonicalAgentByName(name: string): CanonicalAgent {
    const found = loadCanonicalAgents(path.join(stackRoot(), "agents")).find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`agente canónico ausente: ${name}`);
    return found;
  }

  it.each([
    ["implementer", false, "unrestricted", false],
    ["code-reviewer", true, "git-read", false],
    ["comment-fixer", false, "git-read", true],
    ["engram", true, "deny", true],
  ] as const)(
    "rol %s: `permissions` nativo ordenado sin campo legacy",
    (name, editDeny, shell, subagentDeny) => {
      const [rendered] = opencodeAdapter.renderAgent(canonicalAgentByName(name), MODELS);
      const content = rendered!.content;

      if (shell === "unrestricted" && !editDeny && !subagentDeny) {
        const lines = frontmatter(content).split("\n");
        expect(lines.some((line) => line.startsWith("permissions:")), "sin restricciones no se emite bloque").toBe(false);
        expect(lines.some((line) => line.startsWith("permission:")), "sin campo legacy").toBe(false);
        return;
      }

      const rules = nativePermissions(content);
      // El overlay v2 no introduce fricción nueva: ningún `ask`.
      expect(rules.filter((rule) => rule.effect === "ask")).toEqual([]);
      expect(rules.some((rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny")).toBe(editDeny);
      expect(rules.some((rule) => rule.action === "subagent" && rule.resource === "*" && rule.effect === "deny")).toBe(subagentDeny);

      const shellRules = rules.filter((rule) => rule.action === "shell");
      if (shell === "deny") {
        expect(shellRules).toEqual([{ action: "shell", resource: "*", effect: "deny" }]);
        return;
      }
      // git-read: deny global PRIMERO y después los seis prefijos seguros (el
      // orden es la precedencia).
      expect(shellRules[0]).toEqual({ action: "shell", resource: "*", effect: "deny" });
      const allows = shellRules.filter((rule) => rule.effect === "allow");
      expect(allows.length).toBeGreaterThanOrEqual(6);
      for (const rule of allows) expect(rule.resource.startsWith(GIT_READ_PREFIX), rule.resource).toBe(true);
      expect(new Set(allows.map((rule) => rule.resource.replace(/ \*$/, ""))).size).toBeGreaterThanOrEqual(6);
    },
  );
});

describe("opencodeAdapter v2: límites de provider restantes (Spec T04)", () => {
  /** Contrato literal de la Spec 04:55, sin inferir nombres futuros. */
  const NATIVE_LIMITS = [
    { provider: "openai", model: "gpt-6-astra", limit: { context: 872000, input: 744000, output: 128000 } },
    { provider: "opencode-go", model: "deepseek-v4.1-flash", limit: { context: 400000, output: 128000 } },
    { provider: "opencode-go", model: "muse-spark-1.3-contributor", limit: { context: 400000, output: 128000 } },
  ] as const;

  const limitFieldIds = (provider: string, model: string): string[] =>
    Object.keys(NATIVE_LIMITS.find((entry) => entry.provider === provider && entry.model === model)!.limit)
      .map((key) => JSON.stringify(["opencode.json", "providers", provider, "models", model, "limit", key]));

  function providersOf(content: string): Record<string, { models?: Record<string, { limit?: Record<string, number> }> }> {
    return (JSON.parse(content) as { providers?: Record<string, { models?: Record<string, { limit?: Record<string, number> }> }> }).providers ?? {};
  }

  it("siembra los límites ausentes de la Spec con IDs owned file-qualificados", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const actions = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));

    const providers = providersOf(writeActionContent(actions, configFile));
    for (const { provider, model, limit } of NATIVE_LIMITS) {
      expect(providers[provider]?.models?.[model]?.limit, `${provider}/${model}`).toEqual(limit);
    }
    const owned = primaryOwnership(actions, configFile);
    for (const { provider, model } of NATIVE_LIMITS) {
      for (const field of limitFieldIds(provider, model)) expect(owned, field).toContain(field);
    }
  });

  it.each([
    ["modificado a mano", { context: 1, input: 2, output: 3 }],
    ["igual al canon", { context: 872000, input: 744000, output: 128000 }],
  ])("un límite preexistente %s no se reclama y se preserva", (_label, limit) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    fs.writeFileSync(configFile, JSON.stringify({ providers: { openai: { models: { "gpt-6-astra": { limit } } } } }, null, 2) + "\n");

    const actions = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));
    const providers = providersOf(writeActionContent(actions, configFile));
    expect(providers["openai"]?.models?.["gpt-6-astra"]?.limit).toEqual(limit);

    const owned = primaryOwnership(actions, configFile);
    for (const field of limitFieldIds("openai", "gpt-6-astra")) {
      expect(owned, `${field} no debe reclamarse`).not.toContain(field);
    }
    // Los límites restantes sí se siembran: el preexistente no bloquea a los demás.
    expect(providers["opencode-go"]?.models?.["deepseek-v4.1-flash"]?.limit).toEqual({ context: 400000, output: 128000 });
  });

  it("unmerge retira solo los límites owned canónicos y preserva lo ajeno", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const ownedFields = limitFieldIds("opencode-go", "deepseek-v4.1-flash");
    const config = {
      providers: {
        openai: { models: { "gpt-6-astra": { limit: { context: 872000, input: 744000, output: 128000 } } } },
        "opencode-go": {
          models: {
            "deepseek-v4.1-flash": { limit: { context: 400000, output: 128000 } },
            "user-model": { limit: { context: 1, output: 1 } },
          },
        },
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");

    const actions = opencodeAdapter.planUnmerge(loadCanonicalMcp(stackRoot()), loadCanonicalHooks(stackRoot()), {
      ...opencodeContext(configDir),
      ownedPrimaryModelFields: new Set(ownedFields),
    });
    const after = providersOf(writeActionContent(actions, configFile));
    expect(after["opencode-go"]?.models?.["deepseek-v4.1-flash"]?.limit, "owned canónico se retira").toBeUndefined();
    expect(after["opencode-go"]?.models?.["user-model"]?.limit, "lo ajeno se preserva").toEqual({ context: 1, output: 1 });
    expect(after["openai"]?.models?.["gpt-6-astra"]?.limit, "no owned: intacto").toEqual({ context: 872000, input: 744000, output: 128000 });
  });
});

describe("opencodeAdapter provider legacy v1", () => {
  const legacyProvider = {
    custom: { npm: "@example/custom-provider", options: { baseURL: "https://example.invalid/v1" } },
  };

  it("preserva un provider legacy ajeno de id distinto sin escribirlo ni ocultarlo", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    fs.writeFileSync(configFile, JSON.stringify({ provider: legacyProvider, foreign: { kept: true } }, null, 2) + "\n");

    const parsed = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)),
      configFile,
    )) as Record<string, any>;

    expect(parsed.provider).toEqual(legacyProvider);
    expect(parsed.foreign).toEqual({ kept: true });
    expect(parsed.providers.openai.models["gpt-6.1-sol"].limit.context).toBe(872000);
  });

  it("falla cerrado con remedio cuando provider.openai legacy quedaría oculto por los defaults nativos", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const bytes = JSON.stringify({
      provider: { openai: { models: { "user-model": { limit: { context: 42 } } } } },
    }, null, 2) + "\n";
    fs.writeFileSync(configFile, bytes);

    expect(() => opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)))
      .toThrow(/legacy|providers|Migra/i);
    expect(fs.readFileSync(configFile, "utf8")).toBe(bytes);
  });

  it("con providers.openai nativo presente, no convierte ni borra el provider.openai legacy", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const legacy = { models: { "user-model": { limit: { context: 42 } } } };
    const native = { models: { "gpt-6.1-sol": { limit: { context: 100 } } }, userSetting: "preserve" };
    fs.writeFileSync(
      configFile,
      JSON.stringify({ provider: { openai: legacy }, providers: { openai: native } }, null, 2) + "\n",
    );

    const parsed = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)),
      configFile,
    )) as Record<string, any>;

    expect(parsed.provider.openai).toEqual(legacy);
    expect(parsed.providers.openai.userSetting).toBe("preserve");
    expect(parsed.providers.openai.models["gpt-6.1-sol"].limit.context).toBe(100);
  });
});

describe("opencodeAdapter v2: defaults de servidor y roster", () => {
  const CANONICAL_AGENTS = loadCanonicalAgents(path.join(stackRoot(), "agents"));

  function canonicalAgent(name: string): CanonicalAgent {
    const found = CANONICAL_AGENTS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Falta el agente canónico ${name}`);
    return found;
  }

  // Roster final v2 (Spec T04): modelo#variant exacto por agente, fuente
  // independiente del algoritmo de resolución del adapter.
  const ROSTER: Record<string, string> = {
    "codebase-analyst": "openai/gpt-6.1-sol#medium",
    "code-reviewer": "openai/gpt-6.1-sol#medium",
    "code-simplifier": "openai/gpt-6.1-sol#medium",
    "security-auditor": "openai/gpt-6.1-sol#xhigh",
    "silent-failure-hunter": "openai/gpt-6.1-sol#xhigh",
    "test-analyzer": "openai/gpt-6-luna#max",
    "type-design-analyzer": "openai/gpt-6-luna#max",
    implementer: "opencode-go/deepseek-v4.1-flash#high",
    tester: "opencode-go/deepseek-v4.1-flash#high",
    "comment-fixer": "opencode-go/muse-spark-1.3-contributor#medium",
    translator: "opencode-go/muse-spark-1.3-contributor#medium",
    "docs-maintainer": "minimax/MiniMax-M3#thinking",
    engram: "minimax/MiniMax-M3#thinking",
  };

  const freshRoster = (): RuntimeModelMap | undefined => DEFAULT_MODEL_MAP.opencode as RuntimeModelMap | undefined;

  it("resuelve los 13 subagentes del roster v2 desde DEFAULT_MODEL_MAP.opencode", () => {
    const roster = freshRoster();
    expect(roster, "T04: el roster OpenCode vive en DEFAULT_MODEL_MAP.opencode").toBeDefined();
    for (const [name, expected] of Object.entries(ROSTER)) {
      const canonical = canonicalAgent(name);
      const [model, variant] = expected.split("#");
      expect(
        resolveAgentModel(roster!, canonical.name, canonical.tier),
        name,
      ).toEqual(variant === undefined ? { model, variant: undefined } : { model, variant });
    }
  });

  it("renderiza cada subagente del roster como model#variant, sin name ni tier", () => {
    const roster = freshRoster();
    expect(roster, "T04: el roster OpenCode vive en DEFAULT_MODEL_MAP.opencode").toBeDefined();
    for (const [name, expected] of Object.entries(ROSTER)) {
      const [rendered] = opencodeAdapter.renderAgent(canonicalAgent(name), roster!);
      const content = rendered!.content;
      // El ID exacto se compara decodificando el escalar: el `#` del tag no es
      // un comentario YAML si el adapter lo escribe double-quoted.
      expect(frontmatterField(content, "model"), name).toBe(expected);
      expect(frontmatter(content), name).not.toMatch(/^(variant|name|tier):/m);
    }
  });

  it("el primary orchestrator no fija model/variant ni emite name/tier", () => {
    const [rendered] = opencodeAdapter.renderAgent(canonicalAgent("orchestrator"), MODELS);
    expect(rendered!.content).toContain("mode: primary");
    expect(frontmatter(rendered!.content)).not.toMatch(/^(model|variant|name|tier):/m);
  });

  it("respeta un mapa manual y no inyecta el roster por defecto", () => {
    const manual: RuntimeModelMap = {
      strong: { model: "user/strong" },
      standard: { model: "user/standard" },
      cheap: { model: "user/cheap" },
      overrides: { implementer: { model: "user/impl", variant: "low" } },
    };

    const [impl] = opencodeAdapter.renderAgent(canonicalAgent("implementer"), manual);
    expect(frontmatterField(impl!.content, "model")).toBe("user/impl#low");

    const [docs] = opencodeAdapter.renderAgent(canonicalAgent("docs-maintainer"), manual);
    expect(frontmatterField(docs!.content, "model")).toBe("user/cheap");
    expect(frontmatterField(docs!.content, "model")).not.toContain("minimax/MiniMax-M3");
  });

  it("no permite que un modelo/variant manual inyecte campos ni delimitadores en el header", () => {
    const injectedModel = 'user/injected";\nmode: primary\nname: injected';
    const injectedVariant = "high\npermissions:\n  edit: allow\n---";
    const manual: RuntimeModelMap = {
      strong: { model: "user/strong" },
      standard: { model: injectedModel, variant: injectedVariant },
      cheap: { model: "user/cheap" },
    };

    const [rendered] = opencodeAdapter.renderAgent(
      agent({ name: "demo", tier: "standard", readonly: false, bash: "full", spawn: true }),
      manual,
    );
    const content = rendered!.content;
    const lines = frontmatter(content).split("\n");

    // Un único campo escalar con el valor completo; el texto inyectado nunca
    // llega a ser una línea real del header.
    expect(frontmatterField(content, "model")).toBe(`${injectedModel}#${injectedVariant}`);
    expect(lines.filter((line) => line.startsWith("mode:"))).toHaveLength(1);
    expect(lines.some((line) => /^(name|tier|permission|permissions):/.test(line))).toBe(false);
    // El delimitador real sigue siendo único y el cuerpo canónico permanece intacto.
    expect(content.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(content.endsWith("\n# Demo\n\nBody.\n")).toBe(true);
  });

  it("preserva aliases legacy como elección efectiva sin sembrar defaults nativos que los oculten", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    fs.writeFileSync(configFile, JSON.stringify({
      autoupdate: false,
      small_model: "user/legacy-small",
      compaction: { preserve_recent_tokens: 7000 },
      agents: { plan: { disabled: false }, summary: { model: "user/legacy-summary" } },
    }, null, 2) + "\n");

    const root = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)),
      configFile,
    )) as Record<string, any>;

    expect(root.autoupdate).toBe(false);
    expect(root.small_model).toBe("user/legacy-small");
    expect(root.compaction.preserve_recent_tokens).toBe(7000);
    expect(root.update).toBeUndefined();
    expect(root.agents?.title?.model).toBeUndefined();
    expect(root.compaction.keep).toBeUndefined();
    // Un entry nativo legacy del usuario tampoco se pisa ni se oculta.
    expect(root.agents.plan.disabled).toBe(false);
    expect(root.agents.summary.model).toBe("user/legacy-summary");
  });

  it("un valor nativo válido prevalece y no convierte el alias legacy que convive con él", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    fs.writeFileSync(configFile, JSON.stringify({
      update: "disable",
      small_model: "user/legacy-small",
      agents: { title: { model: "user/native-title" } },
      compaction: { preserve_recent_tokens: 7000, keep: { tokens: 5000 } },
    }, null, 2) + "\n");

    const root = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)),
      configFile,
    )) as Record<string, any>;

    expect(root.update).toBe("disable");
    expect(root.agents.title.model).toBe("user/native-title");
    expect(root.compaction.keep.tokens).toBe(5000);
    expect(root.small_model).toBe("user/legacy-small");
    expect(root.compaction.preserve_recent_tokens).toBe(7000);
  });

  it("siembra los defaults v2 de servidor solo en campos ausentes", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const root = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)),
      configFile,
    )) as Record<string, any>;

    expect(root).toMatchObject({
      agents: expect.any(Object),
      compaction: expect.any(Object),
      worktree: expect.any(Object),
    });
    expect(root.agents.plan.disabled).toBe(true);
    expect(root.agents.title.model).toBe("openai/gpt-6-luna#none");
    expect(root.agents.summary.model).toBe("minimax/MiniMax-M3#thinking");
    expect(root.compaction).toEqual({ auto: true, keep: { tokens: 20000 } });
    expect(root.formatter).toBe(true);
    expect(root.lsp).toBe(false);
    expect(root.worktree).toEqual({ directory: "worktrees" });
    expect(root.update).toBe("auto");
    expect(root.default_agent).toBeUndefined();

    const manualDir = tempConfigDir();
    const manualFile = path.join(manualDir, "opencode.json");
    fs.writeFileSync(manualFile, JSON.stringify({
      update: "disable",
      formatter: false,
      lsp: true,
      worktree: { directory: "custom-worktrees" },
      agents: { plan: { disabled: false }, title: { model: "user/title-model" } },
      compaction: { auto: false },
    }, null, 2) + "\n");

    const manual = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(manualDir)),
      manualFile,
    )) as Record<string, any>;

    expect(manual.update).toBe("disable");
    expect(manual.formatter).toBe(false);
    expect(manual.lsp).toBe(true);
    expect(manual.worktree.directory).toBe("custom-worktrees");
    expect(manual.agents.plan.disabled).toBe(false);
    expect(manual.agents.title.model).toBe("user/title-model");
    expect(manual.compaction.auto).toBe(false);
    expect(manual.agents.summary.model).toBe("minimax/MiniMax-M3#thinking");
    expect(manual.compaction.keep.tokens).toBe(20000);
  });
});
