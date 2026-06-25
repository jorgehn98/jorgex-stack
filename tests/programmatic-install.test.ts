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
  expect(content).toMatch(/English[- ]only/i);
  expect(content).toContain("Do not wrap the final JSON in Markdown");
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
        mode: { mode, subagentConcurrency },
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
    const schema = JSON.parse(readText(finalSchemaPath)) as { required?: string[]; properties?: Record<string, unknown> };
    const required = schema.required ?? [];
    expect(required).toEqual(["status", "decision", "confidence", "summary", "risks", "next_steps"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(required));

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
