import fs from "node:fs";
import path from "node:path";
import { piAdapter } from "../adapters/pi.js";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../adapters/types.js";
import { planCommands } from "../components/commands.js";
import { planSkills } from "../components/skills.js";
import { planSystemPrompt } from "../components/system-prompt.js";
import { createBackup } from "./backup.js";
import { removeMarkdownSection } from "./filemerge.js";
import { copyFile, readTextIfExists, writeText } from "./fsx.js";
import { readManifest } from "./manifest.js";
import { DEFAULT_MODEL_MAP } from "./model-map.js";
import { dataDir, HOME, stackRoot } from "./paths.js";
import { filterProjectedPiPackage } from "./pi-package-lifecycle.js";

export type PiProjectionOperation = "install" | "sync" | "doctor" | "uninstall";

export interface PiProjectionReceipt {
  schemaVersion: 1;
  scope: PiProjectionScope;
  owned: string[];
}

export interface PiProjectionScope {
  kind: "real" | "target-dir";
  home: string;
  codingAgentDir: string;
  receiptFile: string;
}

export interface PiProjectionLifecycleInput {
  operation: PiProjectionOperation;
  scope: PiProjectionScope;
  packageSource: string;
  stackDir: string;
  engramBin: string;
  playwrightCliEnabled: boolean;
}

export interface PiProjectionManifest {
  runtimes: {
    codex?: { owned: string[] };
    opencode?: { owned: string[] };
  };
}

export interface PiProjectionLifecycleDeps {
  readText(file: string): string | null;
  backup(paths: string[]): void;
  writeText(file: string, content: string): void;
  copyFile(source: string, target: string): void;
  removeFile(file: string): void;
  readManifest(): PiProjectionManifest;
}

export type PiProjectionLifecycleResult =
  | { kind: "installed"; receipt: PiProjectionReceipt }
  | { kind: "synced"; changed: boolean }
  | { kind: "healthy" }
  | { kind: "drift"; paths: string[] }
  | { kind: "uninstalled" }
  | {
    kind: "blocked";
    reason: "projection-backup-failed" | "projection-cleanup-failed" | "source-divergent";
  };

type ProjectionScope = PiProjectionScope & {
  settingsFile: string;
};

function projectionScope(scope: PiProjectionScope): ProjectionScope {
  return {
    ...scope,
    settingsFile: path.join(scope.codingAgentDir, "settings.json"),
  };
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isManagedPath(scope: ProjectionScope, file: string): boolean {
  return isInside(scope.home, file) || isInside(scope.codingAgentDir, file);
}

function isAllowedPath(scope: ProjectionScope, file: string): boolean {
  return isManagedPath(scope, file) || path.resolve(file) === path.resolve(scope.receiptFile);
}

function projectedPiAdapter(scope: ProjectionScope): SharedProjectionAdapter {
  const paths = piAdapter.paths(scope.codingAgentDir);
  return {
    ...piAdapter,
    paths: () => ({
      ...paths,
      skillsDir: path.join(scope.home, ".agents", "skills"),
    }),
  };
}

function projectionPlan(input: PiProjectionLifecycleInput, scope: ProjectionScope): FileAction[] {
  const ctx: InstallContext = {
    stackDir: input.stackDir,
    configDir: scope.codingAgentDir,
    engramBin: input.engramBin,
    models: DEFAULT_MODEL_MAP.codex,
    warnings: [],
    playwrightCliEnabled: input.playwrightCliEnabled,
  };
  const adapter = projectedPiAdapter(scope);
  return [
    ...planSystemPrompt(adapter, ctx),
    ...planSkills(adapter, ctx),
    ...planCommands(adapter, ctx),
  ];
}

function canonicalActionContent(action: FileAction): string {
  return action.kind === "write" ? action.content : fs.readFileSync(action.source, "utf8");
}

function hasActionDrift(action: FileAction, deps: PiProjectionLifecycleDeps): boolean {
  return deps.readText(action.target) !== canonicalActionContent(action);
}

function applyActions(actions: FileAction[], deps: PiProjectionLifecycleDeps): void {
  for (const action of actions) {
    if (action.kind === "write") deps.writeText(action.target, action.content);
    else deps.copyFile(action.source, action.target);
  }
}

function assertPlanContained(plan: FileAction[], scope: ProjectionScope): void {
  for (const action of plan) {
    if (!isAllowedPath(scope, action.target)) {
      throw new Error(`La proyección de Pi intentó escribir fuera del scope permitido: ${action.target}`);
    }
  }
}

function receiptFor(plan: FileAction[], scope: ProjectionScope): PiProjectionReceipt {
  const systemPrompt = path.join(scope.codingAgentDir, "AGENTS.md");
  const owned = [...new Set(
    plan
      .map((action) => path.resolve(action.target))
      .filter((target) => target !== systemPrompt),
  )];
  return {
    schemaVersion: 1,
    scope: {
      kind: scope.kind,
      home: scope.home,
      codingAgentDir: scope.codingAgentDir,
      receiptFile: scope.receiptFile,
    },
    owned,
  };
}

function receiptContent(receipt: PiProjectionReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function hasExactKeys(record: object, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function parseReceipt(raw: string | null, expected: PiProjectionReceipt): PiProjectionReceipt | null {
  if (raw === null) return null;
  try {
    const receipt: unknown = JSON.parse(raw);
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return null;
    const version = Reflect.get(receipt, "schemaVersion");
    const receivedScope = Reflect.get(receipt, "scope");
    const owned = Reflect.get(receipt, "owned");
    if (version !== expected.schemaVersion
      || !hasExactKeys(receipt, ["schemaVersion", "scope", "owned"])
      || receivedScope === null
      || typeof receivedScope !== "object"
      || Array.isArray(receivedScope)
      || !hasExactKeys(receivedScope, ["kind", "home", "codingAgentDir", "receiptFile"])) {
      return null;
    }
    if (Reflect.get(receivedScope, "kind") !== expected.scope.kind
      || Reflect.get(receivedScope, "home") !== expected.scope.home
      || Reflect.get(receivedScope, "codingAgentDir") !== expected.scope.codingAgentDir
      || Reflect.get(receivedScope, "receiptFile") !== expected.scope.receiptFile
      || !Array.isArray(owned)
      || owned.length !== expected.owned.length) {
      return null;
    }
    const expectedOwned = new Set(expected.owned);
    if (expectedOwned.size !== expected.owned.length
      || new Set(owned).size !== owned.length
      || !owned.every((file): file is string => typeof file === "string" && expectedOwned.has(file))) {
      return null;
    }
    return expected;
  } catch {
    return null;
  }
}

function expectedProjectionReceipt(
  input: PiProjectionLifecycleInput,
  scope: ProjectionScope,
): PiProjectionReceipt {
  const plan = projectionPlan(input, scope);
  assertPlanContained(plan, scope);
  return receiptFor(plan, scope);
}

function realPiProjectionScope(): PiProjectionScope {
  return {
    kind: "real",
    home: HOME,
    codingAgentDir: process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent"),
    receiptFile: path.join(dataDir(), "pi-projection-receipt.json"),
  };
}

export type RealPiProjectionOwnership =
  | { kind: "absent" }
  | { kind: "valid"; owned: string[] }
  | { kind: "corrupt"; file: string };

/** Lee sin mutar el receipt de la proyección real de Pi. */
export function readRealPiProjectionOwned(): RealPiProjectionOwnership {
  const scope = projectionScope(realPiProjectionScope());
  const expected = expectedProjectionReceipt({
    operation: "doctor",
    scope,
    packageSource: "",
    stackDir: stackRoot(),
    engramBin: "",
    playwrightCliEnabled: false,
  }, scope);
  const receiptContent = readTextIfExists(scope.receiptFile);
  if (receiptContent === null) {
    return fs.existsSync(scope.receiptFile)
      ? { kind: "corrupt", file: scope.receiptFile }
      : { kind: "absent" };
  }
  const receipt = parseReceipt(receiptContent, expected);
  return receipt === null
    ? { kind: "corrupt", file: scope.receiptFile }
    : { kind: "valid", owned: receipt.owned };
}

function manifestOwned(manifest: PiProjectionManifest): Set<string> {
  return new Set([
    ...(manifest.runtimes.codex?.owned ?? []),
    ...(manifest.runtimes.opencode?.owned ?? []),
  ].map((file) => path.resolve(file)));
}

function withoutManagedPromptSections(content: string): string {
  return ["system-prompt", "engram-protocol", "browser"]
    .reduce((current, section) => removeMarkdownSection(current, section), content);
}

function removeManagedPromptSections(scope: ProjectionScope, deps: PiProjectionLifecycleDeps): void {
  const prompt = path.join(scope.codingAgentDir, "AGENTS.md");
  const existing = deps.readText(prompt);
  if (existing === null) return;
  const content = withoutManagedPromptSections(existing);
  if (content !== existing) deps.writeText(prompt, content);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((file) => path.resolve(file)))];
}

function backupExisting(paths: string[], deps: PiProjectionLifecycleDeps): boolean {
  const existing = uniquePaths(paths.filter((file) => deps.readText(file) !== null));
  if (existing.length === 0) return true;
  try {
    deps.backup(existing);
    return true;
  } catch {
    return false;
  }
}

export function runPiProjectionLifecycle(
  input: PiProjectionLifecycleInput,
  deps: PiProjectionLifecycleDeps,
): PiProjectionLifecycleResult {
  const scope = projectionScope(input.scope);

  if (input.operation === "uninstall") {
    const expectedReceipt = expectedProjectionReceipt(input, scope);
    const prompt = path.join(scope.codingAgentDir, "AGENTS.md");
    const existingPrompt = deps.readText(prompt);
    const promptWillChange = existingPrompt !== null
      && withoutManagedPromptSections(existingPrompt) !== existingPrompt;
    const receiptContent = deps.readText(scope.receiptFile);
    const receipt = parseReceipt(receiptContent, expectedReceipt);
    if (receipt === null && receiptContent !== null) {
      return { kind: "blocked", reason: "projection-cleanup-failed" };
    }
    if (receipt === null) {
      if (promptWillChange && !backupExisting([prompt], deps)) {
        return { kind: "blocked", reason: "projection-backup-failed" };
      }
      try {
        removeManagedPromptSections(scope, deps);
      } catch {
        return { kind: "blocked", reason: "projection-cleanup-failed" };
      }
      return { kind: "uninstalled" };
    }

    const retained = manifestOwned(deps.readManifest());
    const removed = receipt.owned.filter((owned) => !retained.has(owned));
    if (!backupExisting([
      ...(promptWillChange ? [prompt] : []),
      ...receipt.owned,
      scope.receiptFile,
    ], deps)) {
      return { kind: "blocked", reason: "projection-backup-failed" };
    }
    try {
      removeManagedPromptSections(scope, deps);
      for (const owned of removed) deps.removeFile(owned);
      deps.removeFile(scope.receiptFile);
    } catch {
      return { kind: "blocked", reason: "projection-cleanup-failed" };
    }
    return { kind: "uninstalled" };
  }

  const plan = projectionPlan(input, scope);
  assertPlanContained(plan, scope);
  const receipt = receiptFor(plan, scope);
  const expectedReceipt = receiptContent(receipt);
  const drifted = plan.filter((action) => hasActionDrift(action, deps));

  if (input.operation === "doctor") {
    const paths = drifted.map((action) => path.resolve(action.target));
    const currentSettings = deps.readText(scope.settingsFile);
    if (currentSettings === null
      || filterProjectedPiPackage(currentSettings, input.packageSource) !== currentSettings) {
      paths.push(scope.settingsFile);
    }
    if (deps.readText(scope.receiptFile) !== expectedReceipt) paths.push(scope.receiptFile);
    const unique = uniquePaths(paths);
    return unique.length === 0 ? { kind: "healthy" } : { kind: "drift", paths: unique };
  }

  const currentSettings = deps.readText(scope.settingsFile);
  const filteredSettings = currentSettings === null
    ? null
    : filterProjectedPiPackage(currentSettings, input.packageSource);
  if (currentSettings !== null && filteredSettings === null) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  const packageWillChange = filteredSettings !== null && filteredSettings !== currentSettings;
  const receiptChanged = deps.readText(scope.receiptFile) !== expectedReceipt;
  if (drifted.length > 0 || packageWillChange || receiptChanged) {
    if (!backupExisting([
      ...drifted.map((action) => action.target),
      ...(packageWillChange ? [scope.settingsFile] : []),
      ...(receiptChanged ? [scope.receiptFile] : []),
    ], deps)) {
      return { kind: "blocked", reason: "projection-backup-failed" };
    }
  }
  applyActions(drifted, deps);
  if (packageWillChange && filteredSettings !== null) deps.writeText(scope.settingsFile, filteredSettings);
  if (receiptChanged) deps.writeText(scope.receiptFile, expectedReceipt);

  if (input.operation === "install") return { kind: "installed", receipt };
  return { kind: "synced", changed: drifted.length > 0 || packageWillChange || receiptChanged };
}

export interface PiProjectionLifecycleSystemInput {
  operation: PiProjectionOperation;
  targetDir?: string;
  packageSource: string;
  engramBin: string | null;
  playwrightCliEnabled: boolean;
}

/** Ejecuta la proyección compartida contra el scope real o aislado de Pi. */
export function runPiProjectionLifecycleSystem(
  input: PiProjectionLifecycleSystemInput,
): PiProjectionLifecycleResult {
  const targetRoot = input.targetDir === undefined ? null : path.resolve(input.targetDir);
  const scope: PiProjectionScope = targetRoot === null
    ? realPiProjectionScope()
    : {
        kind: "target-dir",
        home: path.join(targetRoot, "home"),
        codingAgentDir: path.join(targetRoot, "pi-agent"),
        receiptFile: path.join(targetRoot, "state", "pi-projection-receipt.json"),
      };

  return runPiProjectionLifecycle({
    operation: input.operation,
    scope,
    packageSource: input.packageSource,
    stackDir: stackRoot(),
    engramBin: input.engramBin ?? "",
    playwrightCliEnabled: input.playwrightCliEnabled,
  }, {
    readText: readTextIfExists,
    backup: (paths) => createBackup(
      paths,
      `pi-projection-${input.operation}`,
      targetRoot === null ? undefined : path.join(targetRoot, "backups"),
    ),
    writeText,
    copyFile,
    removeFile: (file) => fs.rmSync(file, { force: true }),
    readManifest: targetRoot === null ? readManifest : () => ({ runtimes: {} }),
  });
}
