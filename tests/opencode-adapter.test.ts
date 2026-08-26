import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { DESTRUCTIVE_GIT_DENY } from "../src/lib/git-guard.js";
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

  it("full-bash: '*' allow primero y luego los deny (última regla gana en OpenCode)", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ bash: "full" }), MODELS);
    const content = out!.content;
    expect(content).toContain('"*": allow');
    for (const pattern of DESTRUCTIVE_GIT_DENY) {
      expect(content).toContain(`"${pattern}": deny`);
    }
    // El catch-all debe ir ANTES que el primer deny (orden = precedencia).
    expect(content.indexOf('"*": allow')).toBeLessThan(content.indexOf(`"${DESTRUCTIVE_GIT_DENY[0]}": deny`));
  });

  it("git-read no cambia: solo git diff/log allow, sin barrera destructiva", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    expect(out!.content).toContain('"git diff*": allow');
    expect(out!.content).toContain('"git log*": allow');
    expect(out!.content).not.toContain('"git reset*": deny');
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

    expect(content).toContain(`permission:\n  edit: ${edit}`);
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
