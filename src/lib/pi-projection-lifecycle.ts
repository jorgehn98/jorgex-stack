import fs from "node:fs";
import path from "node:path";
import { piAdapter } from "../adapters/pi.js";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../adapters/types.js";
import { planCommands } from "../components/commands.js";
import { planSkills } from "../components/skills.js";
import { planSystemPrompt } from "../components/system-prompt.js";
import { createBackup } from "./backup.js";
import { removeMarkdownSection } from "./filemerge.js";
import { copyFile, writeText } from "./fsx.js";
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

export type PiProjectionBlockedReason =
  | "projection-backup-failed"
  | "projection-cleanup-failed"
  | "projection-receipt-invalid"
  | "projection-receipt-unreadable"
  | "projection-write-failed";

export interface PiProjectionBlocked {
  kind: "blocked";
  reason: PiProjectionBlockedReason;
  paths: string[];
  remedy: string;
}

export type PiProjectionLifecycleResult =
  | { kind: "installed"; receipt: PiProjectionReceipt }
  | { kind: "synced"; changed: boolean }
  | { kind: "healthy" }
  | { kind: "drift"; paths: string[] }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: "source-divergent" }
  | PiProjectionBlocked;

export type PiProjectionUninstallPrepareResult =
  | { kind: "prepared"; plan: unknown }
  | PiProjectionBlocked;

export type PiProjectionUninstallCompleteResult = { kind: "uninstalled" } | PiProjectionBlocked;

type ProjectionScope = PiProjectionScope & {
  settingsFile: string;
};

type PreparedPiProjectionUninstall = {
  prompt: { file: string; content: string } | null;
  ownedToRemove: string[];
  receiptFile: string | null;
};

const preparedPiProjectionUninstalls = new WeakMap<object, PreparedPiProjectionUninstall>();

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
    if (!owned.every((file, index): file is string => typeof file === "string" && file === expected.owned[index])) {
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

function readTextOnlyIfMissing(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
}

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
  let receiptContent: string | null;
  try {
    receiptContent = readTextOnlyIfMissing(scope.receiptFile);
  } catch {
    return { kind: "corrupt", file: scope.receiptFile };
  }
  if (receiptContent === null) {
    return { kind: "absent" };
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((file) => path.resolve(file)))];
}

function blocked(
  reason: PiProjectionBlockedReason,
  paths: string[],
  remedy: string,
): PiProjectionBlocked {
  return { kind: "blocked", reason, paths: uniquePaths(paths), remedy };
}

function backupExisting(
  paths: string[],
  deps: PiProjectionLifecycleDeps,
): { kind: "backed-up" } | { kind: "backup-failed"; paths: string[] } {
  const candidates = uniquePaths(paths);
  let existing: string[];
  try {
    existing = candidates.filter((file) => deps.readText(file) !== null);
  } catch {
    return { kind: "backup-failed", paths: candidates };
  }
  if (existing.length === 0) return { kind: "backed-up" };
  try {
    deps.backup(existing);
    return { kind: "backed-up" };
  } catch {
    return { kind: "backup-failed", paths: existing };
  }
}

function backupFailure(paths: string[]): PiProjectionBlocked {
  return blocked(
    "projection-backup-failed",
    paths,
    "Revisa permisos y espacio disponible para crear las copias de seguridad indicadas antes de reintentar.",
  );
}

function cleanupFailure(paths: string[]): PiProjectionBlocked {
  return blocked(
    "projection-cleanup-failed",
    paths,
    "Revisa permisos, cierra procesos que usen estas rutas y vuelve a ejecutar la desinstalación.",
  );
}

function receiptInvalid(receiptFile: string): PiProjectionBlocked {
  return blocked(
    "projection-receipt-invalid",
    [receiptFile],
    "Restaura un receipt de proyección íntegro o elimina manualmente solo los archivos gestionados tras verificar su propiedad.",
  );
}

function receiptUnreadable(receiptFile: string): PiProjectionBlocked {
  return blocked(
    "projection-receipt-unreadable",
    [receiptFile],
    "Revisa los permisos o el estado de E/S del receipt de proyección y vuelve a intentarlo.",
  );
}

function writeFailure(file: string): PiProjectionBlocked {
  return blocked(
    "projection-write-failed",
    [file],
    "Revisa los permisos de escritura de esta ruta y vuelve a ejecutar la desinstalación.",
  );
}

function readProjectionReceipt(
  receiptFile: string,
  deps: PiProjectionLifecycleDeps,
): { kind: "absent" } | { kind: "present"; content: string } | { kind: "unreadable" } {
  try {
    const content = deps.readText(receiptFile);
    return content === null ? { kind: "absent" } : { kind: "present", content };
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "unreadable" };
  }
}

/** Prepara y respalda la limpieza de Pi sin modificar los archivos proyectados. */
export function preparePiProjectionUninstall(
  input: PiProjectionLifecycleInput,
  deps: PiProjectionLifecycleDeps,
): PiProjectionUninstallPrepareResult {
  if (input.operation !== "uninstall") {
    return cleanupFailure([]);
  }

  const scope = projectionScope(input.scope);
  const expectedReceipt = expectedProjectionReceipt(input, scope);
  const prompt = path.join(scope.codingAgentDir, "AGENTS.md");
  let existingPrompt: string | null;
  try {
    existingPrompt = deps.readText(prompt);
  } catch {
    return cleanupFailure([prompt]);
  }
  const promptContent = existingPrompt === null ? null : withoutManagedPromptSections(existingPrompt);
  const promptUpdate = promptContent === null || promptContent === existingPrompt
    ? null
    : { file: path.resolve(prompt), content: promptContent };

  const receiptRead = readProjectionReceipt(scope.receiptFile, deps);
  if (receiptRead.kind === "unreadable") return receiptUnreadable(scope.receiptFile);

  let ownedToRemove: string[] = [];
  let receiptFile: string | null = null;
  let backupTargets = promptUpdate === null ? [] : [promptUpdate.file];
  if (receiptRead.kind === "present") {
    const receipt = parseReceipt(receiptRead.content, expectedReceipt);
    if (receipt === null) return receiptInvalid(scope.receiptFile);

    let retained: Set<string>;
    try {
      retained = manifestOwned(deps.readManifest());
    } catch {
      return cleanupFailure([scope.receiptFile]);
    }
    ownedToRemove = receipt.owned.filter((owned) => !retained.has(owned));
    receiptFile = path.resolve(scope.receiptFile);
    backupTargets = [...backupTargets, ...receipt.owned, receiptFile];
  }

  const backup = backupExisting(backupTargets, deps);
  if (backup.kind === "backup-failed") return backupFailure(backup.paths);

  const token = {};
  preparedPiProjectionUninstalls.set(token, {
    prompt: promptUpdate,
    ownedToRemove,
    receiptFile,
  });
  return { kind: "prepared", plan: token };
}

/** Completa una limpieza de Pi ya preparada sin volver a leer ni respaldar su estado. */
export function completePiProjectionUninstall(
  plan: unknown,
  deps: PiProjectionLifecycleDeps,
): PiProjectionUninstallCompleteResult {
  if (typeof plan !== "object" || plan === null) {
    return cleanupFailure([]);
  }
  const prepared = preparedPiProjectionUninstalls.get(plan);
  if (prepared === undefined) {
    return cleanupFailure([]);
  }

  if (prepared.prompt !== null) {
    try {
      deps.writeText(prepared.prompt.file, prepared.prompt.content);
    } catch {
      return writeFailure(prepared.prompt.file);
    }
  }
  for (const owned of prepared.ownedToRemove) {
    try {
      deps.removeFile(owned);
    } catch {
      return cleanupFailure([owned]);
    }
  }
  if (prepared.receiptFile !== null) {
    try {
      deps.removeFile(prepared.receiptFile);
    } catch {
      return cleanupFailure([prepared.receiptFile]);
    }
  }
  return { kind: "uninstalled" };
}

export function runPiProjectionLifecycle(
  input: PiProjectionLifecycleInput,
  deps: PiProjectionLifecycleDeps,
): PiProjectionLifecycleResult {
  const scope = projectionScope(input.scope);

  if (input.operation === "uninstall") {
    const prepared = preparePiProjectionUninstall(input, deps);
    return prepared.kind === "blocked"
      ? prepared
      : completePiProjectionUninstall(prepared.plan, deps);
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
    const backup = backupExisting([
      ...drifted.map((action) => action.target),
      ...(packageWillChange ? [scope.settingsFile] : []),
      ...(receiptChanged ? [scope.receiptFile] : []),
    ], deps);
    if (backup.kind === "backup-failed") return backupFailure(backup.paths);
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

function systemProjectionLifecycle(
  input: PiProjectionLifecycleSystemInput,
): { input: PiProjectionLifecycleInput; deps: PiProjectionLifecycleDeps } {
  const targetRoot = input.targetDir === undefined ? null : path.resolve(input.targetDir);
  const scope: PiProjectionScope = targetRoot === null
    ? realPiProjectionScope()
    : {
        kind: "target-dir",
        home: path.join(targetRoot, "home"),
        codingAgentDir: path.join(targetRoot, "pi-agent"),
        receiptFile: path.join(targetRoot, "state", "pi-projection-receipt.json"),
      };

  return {
    input: {
      operation: input.operation,
      scope,
      packageSource: input.packageSource,
      stackDir: stackRoot(),
      engramBin: input.engramBin ?? "",
      playwrightCliEnabled: input.playwrightCliEnabled,
    },
    deps: {
      readText: readTextOnlyIfMissing,
      backup: (paths) => createBackup(
        paths,
        `pi-projection-${input.operation}`,
        targetRoot === null ? undefined : path.join(targetRoot, "backups"),
      ),
      writeText,
      copyFile,
      removeFile: (file) => fs.rmSync(file, { force: true }),
      readManifest: targetRoot === null ? readManifest : () => ({ runtimes: {} }),
    },
  };
}

/** Prepara la limpieza compartida contra el scope real o aislado de Pi. */
export function preparePiProjectionUninstallSystem(
  input: PiProjectionLifecycleSystemInput,
): PiProjectionUninstallPrepareResult {
  const lifecycle = systemProjectionLifecycle(input);
  return preparePiProjectionUninstall(lifecycle.input, lifecycle.deps);
}

/** Completa una limpieza compartida ya preparada contra el mismo scope de Pi. */
export function completePiProjectionUninstallSystem(
  plan: unknown,
  input: PiProjectionLifecycleSystemInput,
): PiProjectionUninstallCompleteResult {
  const lifecycle = systemProjectionLifecycle(input);
  return completePiProjectionUninstall(plan, lifecycle.deps);
}

/** Ejecuta la proyección compartida contra el scope real o aislado de Pi. */
export function runPiProjectionLifecycleSystem(
  input: PiProjectionLifecycleSystemInput,
): PiProjectionLifecycleResult {
  const lifecycle = systemProjectionLifecycle(input);
  return runPiProjectionLifecycle(lifecycle.input, lifecycle.deps);
}
