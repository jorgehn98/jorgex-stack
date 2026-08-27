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
import { DEFAULT_MODEL_MAP, type RuntimeModelMap } from "./model-map.js";
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
  models: RuntimeModelMap;
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
  | { kind: "blocked"; reason: "projection-cleanup-failed" };

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
    models: input.models,
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

function filterPackageSettings(settingsJson: string, source: string): string | null {
  const direct = filterProjectedPiPackage(settingsJson, source);
  if (direct !== null) return direct;

  try {
    const settings: unknown = JSON.parse(settingsJson);
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
    const packages = Reflect.get(settings, "packages");
    if (!Array.isArray(packages)) return null;
    const normalized = packages.map((entry) => (
      entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && Reflect.get(entry, "source") === source
    ) ? source : entry);
    return filterProjectedPiPackage(JSON.stringify({ ...settings, packages: normalized }), source);
  } catch {
    return null;
  }
}

function reconcilePackageFilter(
  input: PiProjectionLifecycleInput,
  scope: ProjectionScope,
  deps: PiProjectionLifecycleDeps,
): boolean {
  const current = deps.readText(scope.settingsFile);
  if (current === null) return false;
  const filtered = filterPackageSettings(current, input.packageSource);
  if (filtered === null || filtered === current) return false;
  deps.writeText(scope.settingsFile, filtered);
  return true;
}

function packageFilterHasDrift(
  input: PiProjectionLifecycleInput,
  scope: ProjectionScope,
  deps: PiProjectionLifecycleDeps,
): boolean {
  const current = deps.readText(scope.settingsFile);
  if (current === null) return true;
  const filtered = filterPackageSettings(current, input.packageSource);
  return filtered === null || filtered !== current;
}

function packageFilterWillChange(
  input: PiProjectionLifecycleInput,
  scope: ProjectionScope,
  deps: PiProjectionLifecycleDeps,
): boolean {
  const current = deps.readText(scope.settingsFile);
  if (current === null) return false;
  const filtered = filterPackageSettings(current, input.packageSource);
  return filtered !== null && filtered !== current;
}

function parseReceipt(raw: string | null, scope: ProjectionScope): PiProjectionReceipt | null {
  if (raw === null) return null;
  try {
    const receipt: unknown = JSON.parse(raw);
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return null;
    const version = Reflect.get(receipt, "schemaVersion");
    const receivedScope = Reflect.get(receipt, "scope");
    const owned = Reflect.get(receipt, "owned");
    if (version !== 1 || receivedScope === null || typeof receivedScope !== "object" || Array.isArray(receivedScope)) {
      return null;
    }
    if (Reflect.get(receivedScope, "kind") !== scope.kind
      || Reflect.get(receivedScope, "home") !== scope.home
      || Reflect.get(receivedScope, "codingAgentDir") !== scope.codingAgentDir
      || Reflect.get(receivedScope, "receiptFile") !== scope.receiptFile
      || !Array.isArray(owned)
      || !owned.every((file): file is string => typeof file === "string" && isManagedPath(scope, file))) {
      return null;
    }
    return {
      schemaVersion: 1,
      scope: {
        kind: scope.kind,
        home: scope.home,
        codingAgentDir: scope.codingAgentDir,
        receiptFile: scope.receiptFile,
      },
      owned: owned.map((file) => path.resolve(file)),
    };
  } catch {
    return null;
  }
}

function realPiProjectionScope(): PiProjectionScope {
  return {
    kind: "real",
    home: HOME,
    codingAgentDir: process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent"),
    receiptFile: path.join(dataDir(), "pi-projection-receipt.json"),
  };
}

/** Lee sin mutar los archivos que Pi conserva frente a otros runtimes. */
export function readRealPiProjectionOwned(): string[] {
  const scope = projectionScope(realPiProjectionScope());
  return parseReceipt(readTextIfExists(scope.receiptFile), scope)?.owned ?? [];
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

function backupExisting(paths: string[], deps: PiProjectionLifecycleDeps): void {
  const existing = uniquePaths(paths.filter((file) => deps.readText(file) !== null));
  if (existing.length > 0) deps.backup(existing);
}

export function runPiProjectionLifecycle(
  input: PiProjectionLifecycleInput,
  deps: PiProjectionLifecycleDeps,
): PiProjectionLifecycleResult {
  const scope = projectionScope(input.scope);

  if (input.operation === "uninstall") {
    const prompt = path.join(scope.codingAgentDir, "AGENTS.md");
    const existingPrompt = deps.readText(prompt);
    const promptWillChange = existingPrompt !== null
      && withoutManagedPromptSections(existingPrompt) !== existingPrompt;
    const receiptContent = deps.readText(scope.receiptFile);
    const receipt = parseReceipt(receiptContent, scope);
    if (receipt === null && receiptContent !== null) {
      if (promptWillChange) backupExisting([prompt], deps);
      removeManagedPromptSections(scope, deps);
      return { kind: "blocked", reason: "projection-cleanup-failed" };
    }
    if (receipt === null) {
      if (promptWillChange) backupExisting([prompt], deps);
      removeManagedPromptSections(scope, deps);
      return { kind: "uninstalled" };
    }

    const retained = manifestOwned(deps.readManifest());
    const removed = receipt.owned.filter((owned) => !retained.has(owned));
    backupExisting([
      ...(promptWillChange ? [prompt] : []),
      ...receipt.owned,
      scope.receiptFile,
    ], deps);
    removeManagedPromptSections(scope, deps);
    try {
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
    if (packageFilterHasDrift(input, scope, deps)) paths.push(scope.settingsFile);
    if (deps.readText(scope.receiptFile) !== expectedReceipt) paths.push(scope.receiptFile);
    const unique = uniquePaths(paths);
    return unique.length === 0 ? { kind: "healthy" } : { kind: "drift", paths: unique };
  }

  const packageWillChange = packageFilterWillChange(input, scope, deps);
  const receiptChanged = deps.readText(scope.receiptFile) !== expectedReceipt;
  if (drifted.length > 0 || packageWillChange || receiptChanged) {
    backupExisting([
      ...drifted.map((action) => action.target),
      ...(packageWillChange ? [scope.settingsFile] : []),
      ...(receiptChanged ? [scope.receiptFile] : []),
    ], deps);
  }
  applyActions(drifted, deps);
  const packageChanged = reconcilePackageFilter(input, scope, deps);
  if (receiptChanged) deps.writeText(scope.receiptFile, expectedReceipt);

  if (input.operation === "install") return { kind: "installed", receipt };
  return { kind: "synced", changed: drifted.length > 0 || packageChanged || receiptChanged };
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
    models: DEFAULT_MODEL_MAP.codex,
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
