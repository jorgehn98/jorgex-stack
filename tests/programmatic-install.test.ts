import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext, InstallMode, SubagentConcurrency } from "../src/adapters/types.js";
import { runInstall } from "../src/install.js";
import { loadCanonicalAgents } from "../src/lib/canonical.js";
import * as backup from "../src/lib/backup.js";
import { DEFAULT_MODEL_MAP, type RuntimeModelMap } from "../src/lib/model-map.js";
import { dataDir, stackRoot } from "../src/lib/paths.js";

const RUNTIMES = [
  ["OpenCode", opencodeAdapter],
  ["Codex", codexAdapter],
  ["Claude Code", claudeCodeAdapter],
] as const;

const canonicalAgents = loadCanonicalAgents(path.join(stackRoot(), "agents"));
const primaryAgent = canonicalAgents.find((agent) => agent.mode === "primary")!;
const sampleSubagent = canonicalAgents.find((agent) => agent.mode === "subagent")!;
const finalSchemaPath = path.join(stackRoot(), "modes", "programmatic", "final-output.schema.json");
const programmaticRequiredKeys = ["status", "decision", "confidence", "summary", "risks", "next_steps", "delegations"] as const;
const programmaticRequiredKeysLine = "Required keys: `status`, `decision`, `confidence`, `summary`, `risks`, `next_steps`, `delegations`";
const legacyProgrammaticContractPattern = /##\s+Result contract\b|\bResult contract\b|Status \/ Delegations \/ Risks/;
const legacyDelegationLinePattern = /→ \[agent\]:/;

function makeContext(adapter: Adapter, configDir: string, mode: InstallMode, subagentConcurrency: SubagentConcurrency): InstallContext {
  return {
    stackDir: stackRoot(),
    configDir,
    mode,
    subagentConcurrency,
    engramBin: path.join(configDir, "engram"),
    models: DEFAULT_MODEL_MAP[adapter.id] as RuntimeModelMap,
    warnings: [],
  };
}

function renderTargets(adapter: Adapter, ctx: InstallContext, agent = primaryAgent): string[] {
  const paths = adapter.paths(ctx.configDir);
  return adapter.renderAgent(agent, ctx.models).map((artifact) => {
    switch (artifact.kind) {
      case "agent":
        return path.join(paths.agentsDir, artifact.file);
      case "command":
        return path.join(paths.commandsDir, artifact.file);
      case "output-style":
        return path.join(paths.outputStylesDir!, artifact.file);
      case "skill":
        return path.join(paths.skillsDir, artifact.file);
      case "profile":
        return path.join(paths.profilesDir!, artifact.file);
    }
  });
}

function expectProgrammaticSystemPrompt(content: string): void {
  expect(content).toContain("PROGRAMMATIC MODE");
  expect(content).toContain("strict JSON object");
}

function expectProgrammaticPrimary(content: string, concurrency: SubagentConcurrency): void {
  expect(content).toContain("strict JSON object");
  expect(content).toContain("status");
  expect(content).toContain("decision");
  expect(content).toContain("confidence");
  expect(content).toContain("summary");
  expect(content).toContain("risks");
  expect(content).toContain("next_steps");
  expect(content).toContain("delegations");
  expect(content).toMatch(/English[- ]only/i);
  expect(content).toContain("Do not wrap the final JSON in Markdown");
  expect(content).toContain("If a subagent reports `partial`");
  expect(content).toContain("keep the safe work and relaunch only what still needs guidance");
  expect(content).toContain("If a subagent reports `blocked`");
  expect(content).toContain("one concrete question");
  expect(content).toContain("explicit guidance");
  if (concurrency === "serial") {
    expect(content).toMatch(/one subagent at a time|no parallel delegation/i);
  } else {
    expect(content).toMatch(/max_parallel_subagents|parallel delegation/i);
  }
}

function expectProgrammaticSubagent(content: string): void {
  expect(content).toMatch(/English[- ]only/i);
  expect(content).toMatch(/compact/i);
  expect(content).toMatch(/long Markdown reports/i);
  expect(content).toContain("task-critical uncertainty");
  expect(content).toContain("set `status` to `blocked`");
  expect(content).toContain("one concrete question");
  expect(content).toContain("main agent/orchestrator");
  expect(content).toContain("report the remainder as `partial`");
}

function expectHumanSafe(content: string): void {
  expect(content).not.toContain("PROGRAMMATIC MODE");
  expect(content).not.toContain("strict JSON object");
  expect(content).not.toContain("max_parallel_subagents");
  expect(content).not.toContain("Do not wrap the final JSON in Markdown");
}

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe.each(RUNTIMES)("%s", (_name, adapter) => {
  let tempRoot = "";

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  async function install(mode: InstallMode, subagentConcurrency: SubagentConcurrency): Promise<{ configDir: string; ctx: InstallContext }> {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-programmatic-install-"));
    const configDir = path.join(tempRoot, adapter.id);
    const ctx = makeContext(adapter, configDir, mode, subagentConcurrency);

    await expect(
      runInstall({
        runtimes: [adapter.id],
        targetDir: configDir,
        dryRun: false,
        yes: true,
        mode: mode === "human"
          ? { mode: "human", subagentConcurrency: "serial" }
          : { mode: "programmatic", subagentConcurrency },
      }),
    ).resolves.toBe(0);

    return { configDir, ctx };
  }

  it("programmatic/serial escribe el contrato generado y queda idempotente", async () => {
    const { configDir, ctx } = await install("programmatic", "serial");
    const paths = adapter.paths(configDir);
    const primaryTargets = renderTargets(adapter, ctx, primaryAgent);
    const subagentTargets = renderTargets(adapter, ctx, sampleSubagent);

    const snapshot = new Map<string, string>();
    snapshot.set(paths.systemPromptFile, readText(paths.systemPromptFile));
    for (const file of primaryTargets) snapshot.set(file, readText(file));
    for (const file of subagentTargets) snapshot.set(file, readText(file));

    expectProgrammaticSystemPrompt(snapshot.get(paths.systemPromptFile)!);
    for (const file of primaryTargets) expectProgrammaticPrimary(snapshot.get(file)!, "serial");
    for (const file of subagentTargets) expectProgrammaticSubagent(snapshot.get(file)!);

    expect(fs.existsSync(finalSchemaPath)).toBe(true);
    const schema = JSON.parse(readText(finalSchemaPath)) as { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean };
    const required = schema.required ?? [];
    expect(required).toEqual(["status", "decision", "confidence", "summary", "risks", "next_steps", "delegations"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(required));
    const validSample = Object.fromEntries(required.map((key) => [key, key]));
    const invalidSample = { ...validSample, unexpected: "boom" };
    const allowedKeys = new Set(Object.keys(schema.properties ?? {}));
    expect(Object.keys(invalidSample).filter((key) => !allowedKeys.has(key))).toEqual(["unexpected"]);

    await expect(
      runInstall({
        runtimes: [adapter.id],
        targetDir: configDir,
        dryRun: false,
        yes: true,
        mode: { mode: "programmatic", subagentConcurrency: "serial" },
      }),
    ).resolves.toBe(0);

    expect(readText(paths.systemPromptFile)).toBe(snapshot.get(paths.systemPromptFile));
    for (const file of primaryTargets) expect(readText(file)).toBe(snapshot.get(file));
    for (const file of subagentTargets) expect(readText(file)).toBe(snapshot.get(file));
  });

  it("programmatic artifacts no arrastran el Result contract markdown y comparten el contrato JSON de siete claves", async () => {
    const { ctx } = await install("programmatic", "serial");
    const primaryTargets = renderTargets(adapter, ctx, primaryAgent);
    const subagentTargets = renderTargets(adapter, ctx, sampleSubagent);

    for (const file of [...primaryTargets, ...subagentTargets]) {
      expect(readText(file)).not.toMatch(legacyProgrammaticContractPattern);
      expect(readText(file)).not.toMatch(legacyDelegationLinePattern);
    }

    const schema = JSON.parse(readText(finalSchemaPath)) as { required?: string[]; additionalProperties?: boolean };
    expect(schema.required).toEqual([...programmaticRequiredKeys]);
    expect(schema.additionalProperties).toBe(false);

    const agentsAddendum = readText(path.join(stackRoot(), "modes", "programmatic", "AGENTS.addendum.md"));
    expect(agentsAddendum).toContain(programmaticRequiredKeysLine);
  });

  it("final-output.schema.json restringe status y delegations sin Markdown", () => {
    const schema = JSON.parse(readText(finalSchemaPath)) as {
      properties?: {
        status?: { enum?: string[] };
        delegations?: { items?: { type?: string; pattern?: string } };
      };
    };

    expect(schema.properties?.status?.enum).toEqual(["done", "partial", "blocked"]);
    expect(schema.properties?.delegations?.items?.type).toBe("string");

    const delegationPattern = schema.properties?.delegations?.items?.pattern;
    expect(delegationPattern).toBeDefined();
    expect(new RegExp(delegationPattern!).test("implementer: fix mode handling — src/install.ts — saved mode"))
      .toBe(true);
    expect(new RegExp(delegationPattern!).test("→ [agent]: implementer — src/file.ts — fix the bug")).toBe(false);
    expect(new RegExp(delegationPattern!).test("implementer: fix mode — src/install.ts — input — extra")).toBe(false);
  });

  it("human mode deja los artefactos limpios", async () => {
    const { configDir, ctx } = await install("human", "serial");
    const paths = adapter.paths(configDir);
    const primaryTargets = renderTargets(adapter, ctx, primaryAgent);
    const subagentTargets = renderTargets(adapter, ctx, sampleSubagent);

    expectHumanSafe(readText(paths.systemPromptFile));
    for (const file of primaryTargets) expectHumanSafe(readText(file));
    for (const file of subagentTargets) expectHumanSafe(readText(file));
  });
});

describe("Codex: cambio de modo con skills compartidos", () => {
  let tempRoot = "";

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  it("human → programmatic → human reescribe cleanly el orchestrator compartido", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-programmatic-switch-"));
    const configDir = path.join(tempRoot, "codex");
    const ctx = makeContext(codexAdapter, configDir, "human", "serial");
    const primaryTargets = renderTargets(codexAdapter, ctx, primaryAgent);
    const subagentTargets = renderTargets(codexAdapter, ctx, sampleSubagent);
    const backupsRoot = path.join(dataDir(), "backups");
    const backupIdsBefore = backup.listBackups(backupsRoot).map((entry) => entry.id);
    const createBackupSpy = vi.spyOn(backup, "createBackup");

    await expect(
      runInstall({
        runtimes: ["codex"],
        targetDir: configDir,
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
      }),
    ).resolves.toBe(0);

    const humanSnapshot = new Map<string, string>();
    const codexPaths = codexAdapter.paths(configDir);
    humanSnapshot.set(codexPaths.systemPromptFile, readText(codexPaths.systemPromptFile));
    for (const file of primaryTargets) humanSnapshot.set(file, readText(file));
    for (const file of subagentTargets) humanSnapshot.set(file, readText(file));

    for (const content of humanSnapshot.values()) expectHumanSafe(content);

    await expect(
      runInstall({
        runtimes: ["codex"],
        targetDir: configDir,
        dryRun: false,
        yes: true,
        mode: { mode: "programmatic", subagentConcurrency: "parallel" },
      }),
    ).resolves.toBe(0);

    const programmaticPaths = codexAdapter.paths(configDir);
    expectProgrammaticSystemPrompt(readText(programmaticPaths.systemPromptFile));
    for (const file of primaryTargets) expectProgrammaticPrimary(readText(file), "parallel");
    for (const file of subagentTargets) expectProgrammaticSubagent(readText(file));

    await expect(
      runInstall({
        runtimes: ["codex"],
        targetDir: configDir,
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
      }),
    ).resolves.toBe(0);

    expect(readText(programmaticPaths.systemPromptFile)).toBe(humanSnapshot.get(programmaticPaths.systemPromptFile));
    for (const file of primaryTargets) expect(readText(file)).toBe(humanSnapshot.get(file));
    for (const file of subagentTargets) expect(readText(file)).toBe(humanSnapshot.get(file));
    expect(createBackupSpy).not.toHaveBeenCalled();
    expect(backup.listBackups(backupsRoot).map((entry) => entry.id)).toEqual(backupIdsBefore);
  });
});

describe("programmatic final-output contract", () => {
  it("incluye delegations en el schema y en las addenda programmatic", () => {
    expect(fs.existsSync(finalSchemaPath)).toBe(true);

    const schema = JSON.parse(readText(finalSchemaPath)) as { required?: string[]; properties?: Record<string, unknown> };
    const required = schema.required ?? [];

    expect(required).toEqual(
      expect.arrayContaining(["status", "decision", "confidence", "summary", "risks", "next_steps", "delegations"]),
    );
    expect(required).toHaveLength(7);
    expect(new Set(Object.keys(schema.properties ?? {}))).toEqual(new Set(programmaticRequiredKeys));
    expect(schema.properties?.delegations).toEqual(expect.objectContaining({ type: "array" }));

    const orchestratorAddendum = readText(path.join(stackRoot(), "modes", "programmatic", "orchestrator.addendum.md"));
    const subagentAddendum = readText(path.join(stackRoot(), "modes", "programmatic", "subagent.addendum.md"));

    expect(orchestratorAddendum).toMatch(/delegations/i);
    expect(subagentAddendum).toMatch(/delegations/i);
  });

  it("reemplaza el Result contract markdown por un único handoff JSON", () => {
    const agentsAddendum = readText(path.join(stackRoot(), "modes", "programmatic", "AGENTS.addendum.md"));
    const subagentAddendum = readText(path.join(stackRoot(), "modes", "programmatic", "subagent.addendum.md"));

    expect(agentsAddendum).toContain("strict JSON object only");
    expect(agentsAddendum).not.toContain("Result contract");
    expect(subagentAddendum).toContain("final JSON handoff");
    expect(subagentAddendum).not.toContain("Result contract");
  });
});

describe("agent-delegation skill en programmatic installs", () => {
  it("no reintroduce la gramática Markdown vieja y documenta delegations[]", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-programmatic-skill-"));
    const configDir = path.join(tmp, "opencode");

    try {
      await expect(
        runInstall({
          runtimes: ["opencode"],
          targetDir: configDir,
          dryRun: false,
          yes: true,
          mode: { mode: "programmatic", subagentConcurrency: "serial" },
        }),
      ).resolves.toBe(0);

      const skill = readText(path.join(opencodeAdapter.paths(configDir).skillsDir, "agent-delegation", "SKILL.md"));

      expect(skill).not.toContain("→ [agent]:");
      expect(skill).not.toContain("→ [agente]:");
      expect(skill).toContain("delegations[]");
      expect(skill).toMatch(/\bJSON\b/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
