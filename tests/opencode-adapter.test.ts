import fs from "node:fs";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { loadCanonicalHooks, loadCanonicalMcp, type CanonicalAgent } from "../src/lib/canonical.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";
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
    expect(standard!.content).toContain("model: provider/standard");
    expect(standard!.content).toContain("variant: medium");

    const [cheap] = opencodeAdapter.renderAgent(
      agent({ name: "engram", tier: "cheap" }),
      MODELS,
    );
    expect(cheap!.content).toContain("model: provider/cheap");
    expect(cheap!.content).not.toContain("variant:");
  });

  it("full-bash inherits the general policy without overriding its asks or denies", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ bash: "full" }), MODELS);
    expect(out!.content).not.toMatch(/\n  (bash|edit):/);
    expect(out!.content).not.toContain("permission:\n---");
  });

  it("git-read denies arbitrary shell and disables Git options before variable arguments", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    expect(out!.content).toContain('"*": deny');
    expect(out!.content).not.toContain('"git diff*": allow');
    expect(out!.content).toContain("core.fsmonitor=false");
    expect(out!.content).toContain("log.showSignature=false");
    expect(out!.content).toContain('--no-ext-diff --no-textconv --end-of-options *": allow');
    expect(out!.content).toContain("put refs and paths after --end-of-options");
  });

  it("none: bash denegado por completo", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "none" }), MODELS);
    expect(out!.content).toContain("bash: deny");
    expect(out!.content).not.toContain('"git reset*": deny');
  });

  it.each([
    ["readonly", true, "deny"],
    ["writer", false, "allow"],
  ] as const)("%s usa permission.edit sin renderizar el bloque tools deprecado", (_label, readonly, edit) => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly }), MODELS);
    const content = out!.content;

    if (readonly) expect(content).toContain(`permission:\n  edit: ${edit}`);
    else expect(content).not.toMatch(/\n  edit:/);
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
    const fresh = JSON.parse(writeActionContent(
      opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(freshDir)),
      freshFile,
    )) as Record<string, any>;
    expect(fresh.model).toBe("openai/gpt-5.6-sol");
    expect(fresh.provider.openai.models["gpt-5.6-sol"].limit.context).toBe(872000);

    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const ctx = opencodeContext(configDir);
    const mcp = loadCanonicalMcp(stackRoot());

    fs.writeFileSync(configFile, JSON.stringify({
      foreign: { kept: true },
      provider: { custom: true, openai: { models: { "user-model": { limit: { context: 42 } } } } },
    }, null, 2));
    const installActions = opencodeAdapter.planMainConfig(mcp, ctx);
    const installed = writeActionContent(installActions, configFile);
    const parsed = JSON.parse(installed) as Record<string, any>;

    expect(parsed.model).toBe("openai/gpt-5.6-sol");
    expect(parsed.provider.openai.models["gpt-5.6-sol"].limit).toEqual({
      context: 872000,
      input: 744000,
      output: 128000,
    });
    expect(parsed.foreign).toEqual({ kept: true });
    expect(parsed.provider.custom).toBe(true);
    expect(parsed.provider.openai.models["user-model"].limit.context).toBe(42);

    fs.writeFileSync(configFile, installed);
    expect(writeActionContent(opencodeAdapter.planMainConfig(mcp, ctx), configFile)).toBe(installed);

    parsed.model = "user/model";
    parsed.provider.openai.models["gpt-5.6-sol"].limit.context = 900000;
    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2));
    const unmerged = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...ctx,
        ownedPrimaryModelFields: primaryOwnership(installActions, configFile),
      }),
      configFile,
    )) as Record<string, any>;

    expect(unmerged.model).toBe("user/model");
    expect(unmerged.provider.openai.models["gpt-5.6-sol"].limit).toEqual({ context: 900000 });
    expect(unmerged.foreign).toEqual({ kept: true });
    expect(unmerged.provider.custom).toBe(true);
    expect(unmerged.provider.openai.models["user-model"].limit.context).toBe(42);

    const preexistingDir = tempConfigDir();
    const preexistingFile = path.join(preexistingDir, "opencode.json");
    const preexisting = {
      model: "openai/gpt-5.6-sol",
      provider: { openai: { models: { "gpt-5.6-sol": { limit: { context: 872000, input: 744000, output: 128000 } } } } },
    };
    fs.writeFileSync(preexistingFile, JSON.stringify(preexisting, null, 2));
    const preexistingActions = opencodeAdapter.planMainConfig(mcp, opencodeContext(preexistingDir));
    expect(primaryOwnership(preexistingActions, preexistingFile)).toEqual(new Set());
    fs.writeFileSync(preexistingFile, writeActionContent(preexistingActions, preexistingFile));
    const preserved = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), opencodeContext(preexistingDir)),
      preexistingFile,
    ));
    expect(preserved).toMatchObject(preexisting);

    const emptyTreeDir = tempConfigDir();
    const emptyTreeFile = path.join(emptyTreeDir, "opencode.json");
    const emptyTree = { provider: { openai: { models: {} } } };
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
    expect(emptyTreeUnmerged.provider).toEqual(emptyTree.provider);

    const removedLimitDir = tempConfigDir();
    const removedLimitFile = path.join(removedLimitDir, "opencode.json");
    const removedLimitActions = opencodeAdapter.planMainConfig(mcp, opencodeContext(removedLimitDir));
    const removedLimitConfig = JSON.parse(writeActionContent(removedLimitActions, removedLimitFile));
    delete removedLimitConfig.provider.openai.models["gpt-5.6-sol"].limit;
    fs.writeFileSync(removedLimitFile, JSON.stringify(removedLimitConfig, null, 2));
    const removedLimitUnmerged = JSON.parse(writeActionContent(
      opencodeAdapter.planUnmerge(mcp, loadCanonicalHooks(stackRoot()), {
        ...opencodeContext(removedLimitDir),
        ownedPrimaryModelFields: primaryOwnership(removedLimitActions, removedLimitFile),
      }),
      removedLimitFile,
    ));
    expect(removedLimitUnmerged.provider).toBeUndefined();

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
      mcp?: Record<string, { type?: string; url?: string }>;
    };
    expect(root.mcp?.context7).toMatchObject({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
    });
  });

  it("conserva completa una entrada Context7 compatible sin reclamar ownership", () => {
    const configDir = tempConfigDir();
    const configFile = path.join(configDir, "opencode.json");
    const previous = {
      model: "user/model",
      provider: { user: { setting: "preserve" } },
      mcp: {
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          headers: { "X-User-Setting": "preserve" },
          userSetting: "preserve",
        },
        foreign: { type: "remote", url: "https://example.invalid/foreign" },
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(previous, null, 2) + "\n");

    const [action] = opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), opencodeContext(configDir));
    expect(action).toMatchObject({ kind: "write", target: configFile });
    if (action?.kind !== "write") throw new Error("Expected a Context7 config write");

    const result = JSON.parse(action.content) as typeof previous;
    expect(result.mcp.context7).toEqual(previous.mcp.context7);
    expect(result.mcp.foreign).toEqual(previous.mcp.foreign);
    expect(result.provider.user).toEqual(previous.provider.user);
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
  const commands = out!.content.split("\n").filter((line) => /^    "git .*": allow$/.test(line))
    .map((line) => JSON.parse(line.trim().slice(0, -": allow".length)) as string)
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
