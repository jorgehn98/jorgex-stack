import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "../src/lib/canonical.js";
import type { AgentModelChoices } from "../src/lib/agent-model.js";
import { TEST_MODEL_MAP as DEFAULT_MODEL_MAP } from "./fixtures/model-map.js";
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
const MODELS: AgentModelChoices = {
};


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

    expect(root.model).toBeUndefined();
    expect(root.providers).toBeUndefined();
    expect(root.agents).toBeUndefined();

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

  /**
   * IDs file-qualificados de los contenedores que Stack crea al sembrar el
   * modelo (Spec 04:62): la poda exige el ID propio del contenedor, no basta
   * con las hojas. Un fixture que representa contenedores creados por Stack
   * debe incluirlos para que el unmerge los retire cuando queden vacíos.
   */
  const limitContainerFieldIds = (provider: string, model: string): string[] =>
    [
      ["providers"],
      ["providers", provider],
      ["providers", provider, "models"],
      ["providers", provider, "models", model],
      ["providers", provider, "models", model, "limit"],
    ].map((segments) => JSON.stringify(["opencode.json", ...segments]));

  function providersOf(content: string): Record<string, { models?: Record<string, { limit?: Record<string, number> }> }> {
    return (JSON.parse(content) as { providers?: Record<string, { models?: Record<string, { limit?: Record<string, number> }> }> }).providers ?? {};
  }

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
    // No se introduce otro catálogo ni límites prefijados.
    expect(providers["opencode-go"]).toBeUndefined();
  });

  it("unmerge retira solo los límites owned canónicos y preserva lo ajeno", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    // El fixture representa el modelo/limit creados por Stack (aunque el
    // usuario añadiera luego `user-model` al mismo provider); el set owned
    // incluye los contenedores de la cadena, no solo las hojas, para que el
    // unmerge retire el límite canónico sin dejar residuo vacío.
    const ownedFields = [
      ...limitContainerFieldIds("opencode-go", "deepseek-v4.1-flash"),
      ...limitFieldIds("opencode-go", "deepseek-v4.1-flash"),
    ];
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

describe("opencodeAdapter v2: unmerge no poda contenedores preexistentes ajenos", () => {
  it("preserva limit/agents.title/compaction/worktree vacíos preexistentes al retirar hojas owned", () => {
    // Spec 04:62: los contenedores se podan SOLO cuando su propio ID
    // file-qualified es owned y quedan vacíos. Un `{}` que ya existía antes de
    // que Stack sembrara sus hojas es del usuario y debe sobrevivir; un
    // `pruneEmpty`/`removed` incondicional lo borraría como residuo.
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const preexisting = {
      providers: { openai: { models: { "gpt-6.1-sol": { limit: {} } } } },
      agents: { title: {} },
      compaction: {},
      worktree: {},
      foreign: { kept: true },
    };
    fs.writeFileSync(configFile, JSON.stringify(preexisting, null, 2) + "\n");

    const mcp = loadCanonicalMcp(stackRoot());
    const actions = opencodeAdapter.planMainConfig(mcp, opencodeContext(configDir));
    const owned = primaryOwnership(actions, configFile);

    // El plan no reclama los contenedores que ya existían: no los creó.
    for (const segments of [
      ["providers", "openai", "models", "gpt-6.1-sol", "limit"],
      ["agents", "title"],
      ["compaction"],
      ["worktree"],
    ]) {
      expect(owned.has(JSON.stringify(["opencode.json", ...segments])), segments.join(".")).toBe(false);
    }
    expect(owned.has(JSON.stringify(["opencode.json", "providers", "openai", "models", "gpt-6.1-sol", "limit", "context"]))).toBe(false);

    fs.writeFileSync(configFile, writeActionContent(actions, configFile));
    const unmerged = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...opencodeContext(configDir),
        ownedPrimaryModelFields: owned,
      }),
      configFile,
    )) as Record<string, any>;

    // Las hojas owned se retiran…
    expect(unmerged.providers.openai.models["gpt-6.1-sol"].limit.context).toBeUndefined();
    expect(unmerged.providers.openai.models["gpt-6.1-sol"].limit.input).toBeUndefined();
    expect(unmerged.providers.openai.models["gpt-6.1-sol"].limit.output).toBeUndefined();
    // …y los contenedores preexistentes ajenos sobreviven vacíos.
    expect(unmerged.providers.openai.models["gpt-6.1-sol"].limit).toEqual({});
    expect(unmerged.agents.title).toEqual({});
    expect(unmerged.compaction).toEqual({});
    expect(unmerged.worktree).toEqual({});
    expect(unmerged.foreign).toEqual({ kept: true });

    // Lo creado por Stack (otros providers/límites) sí desaparece por completo.
    expect(unmerged.providers.openai.models["gpt-6-astra"]).toBeUndefined();
    expect(unmerged.providers["opencode-go"]).toBeUndefined();
  });
});

describe("opencodeAdapter v2: diagnóstico de contenedores no objeto", () => {
  // Guardia para la reutilización de `ensureOwnedPrimaryObject` en los cinco
  // contenedores: el rechazo de null/array/escalar debe conservar el `fieldPath`
  // exacto (Spec 04:64), sin snapshots de prosa.
  it.each([
    ["compaction null", { compaction: null }, "compaction"],
    ["worktree escalar", { worktree: "x" }, "worktree"],
  ])("rechaza %s con el campo en el diagnóstico", (_label, extra, fieldPath) => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const bytes = JSON.stringify({ model: "user/model", ...extra }, null, 2) + "\n";
    fs.writeFileSync(configFile, bytes);

    expect(() => opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir)))
      .toThrow(new RegExp(`'${fieldPath.replaceAll(".", "\\.")}' debe ser un objeto`));
    expect(fs.readFileSync(configFile, "utf8"), "sin writes sobre entrada inválida").toBe(bytes);
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
    expect(parsed.providers).toBeUndefined();
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

  it("no siembra agents.plan/summary nativos que tapen el alias legacy agent.plan/agent.summary", () => {
    // Spec 04:62: la misma preservación efectiva que title rige plan/summary. Un
    // `agent.plan`/`agent.summary` legacy personalizado ya decide ese rol; un
    // `agents.*` por defecto lo ocultaría (native válido prevalece).
    const configDir = tempConfigDir();
    const jsoncFile = path.join(configDir, "opencode.jsonc");
    const original = [
      "// alias legacy del usuario",
      "{",
      '  "agent": {',
      '    "plan": { "model": "user/custom-plan" },',
      '    "summary": { "model": "user/custom-summary" }',
      "  },",
      '  "foreign": { "kept": true }',
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(jsoncFile, original);

    const actions = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));
    const content = writeActionContent(actions, jsoncFile);
    expect(content, "el comentario ajeno sobrevive").toContain("// alias legacy del usuario");
    const root = parseJsonc(content) as Record<string, any>;

    // El alias legacy manda y el archivo ajeno se preserva.
    expect(root.agent.plan.model).toBe("user/custom-plan");
    expect(root.agent.summary.model).toBe("user/custom-summary");
    expect(root.agents?.plan, "no emitir el plan nativo que taparía agent.plan").toBeUndefined();
    expect(root.agents?.summary, "no emitir el summary nativo que taparía agent.summary").toBeUndefined();
    expect(root.foreign).toEqual({ kept: true });
    // La guardia es por alias: el built-in sin alias (`agents.title`) sí se siembra.
    expect(root.agents?.title?.model).toBeUndefined();

    // No se reclama ownership de un bloque que no se escribió.
    const owned = primaryOwnership(actions, jsoncFile);
    for (const segments of [
      ["agents", "plan"],
      ["agents", "plan", "disabled"],
      ["agents", "summary"],
      ["agents", "summary", "model"],
    ]) {
      expect(owned.has(JSON.stringify(["opencode.jsonc", ...segments])), segments.join(".")).toBe(false);
    }
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
      compaction: expect.any(Object),
      worktree: expect.any(Object),
    });
    expect(root.agents).toBeUndefined();
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
    expect(manual.agents.summary).toBeUndefined();
    expect(manual.compaction.keep.tokens).toBe(20000);
  });
});
