import fs from "node:fs";
import path from "node:path";
import type { GoalStore } from "./types.js";

export interface MasterArtifactsInput {
  store: GoalStore;
  goalId: string;
  rootDir: string;
  allowedRootDir?: string;
}

export interface MasterArtifactsResult {
  created: boolean;
  preserved: boolean;
  prdPath: string;
  planPath: string;
}

export function createMasterArtifacts(input: MasterArtifactsInput): MasterArtifactsResult {
  const goal = input.store.getGoal(input.goalId);
  if (!goal) {
    throw new Error(`Goal ${input.goalId} not found.`);
  }

  const allowedRootDir = input.allowedRootDir ?? input.rootDir;
  assertSafeArtifactPath(input.rootDir, allowedRootDir, "Goal artifact root");
  fs.mkdirSync(input.rootDir, { recursive: true });

  const prdPath = path.join(input.rootDir, "PRD.md");
  const planPath = path.join(input.rootDir, "plan.md");
  assertSafeArtifactPath(prdPath, allowedRootDir, "Goal PRD artifact");
  assertSafeArtifactPath(planPath, allowedRootDir, "Goal plan artifact");
  const prdCreated = writeIfMissing(prdPath, renderMasterPrd(goal.objective));
  const planCreated = writeIfMissing(planPath, renderMasterPlan(goal.objective));

  input.store.recordArtifact(goal.id, { kind: "prd", path: prdPath });
  input.store.recordArtifact(goal.id, { kind: "plan", path: planPath });

  return {
    created: prdCreated || planCreated,
    preserved: !prdCreated || !planCreated,
    prdPath,
    planPath,
  };
}

export function assertSafeArtifactPath(filePath: string, allowedRootDir: string, label = "Goal artifact"): void {
  const resolvedAllowedRoot = resolveExistingPathWithoutSymlinks(allowedRootDir, `${label} root`);
  const resolvedPath = resolveExistingPathWithoutSymlinks(filePath, label);
  if (!isContainedIn(resolvedPath, resolvedAllowedRoot)) {
    throw new Error(`${label} must stay inside ${allowedRootDir}. Refusing: ${filePath}`);
  }

  const stats = lstatIfExists(filePath);
  if (stats?.isFile() && stats.nlink > 1) {
    throw new Error(`${label} must not be a hard link.`);
  }
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function resolveExistingPathWithoutSymlinks(input: string, label: string): string {
  assertNoSymlinkInExistingPath(input, label);
  let current = path.resolve(input);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    missing.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return missing.reduceRight((base, part) => path.join(base, part), real);
}

function assertNoSymlinkInExistingPath(input: string, label: string): void {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  const relativeParts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stats = lstatIfExists(current);
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not include symlinks.`);
    }
  }
}

function lstatIfExists(input: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isContainedIn(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function renderMasterPrd(objective: string): string {
  return [
    "# PRD maestro",
    "",
    "## Objetivo",
    "",
    objective,
    "",
    "## Alcance",
    "",
    "- Mantener el objetivo global del Goal Mode.",
    "- Dividir el trabajo en slices ejecutables por el orquestador.",
    "- Esperar merges manuales antes de continuar.",
    "",
  ].join("\n");
}

function renderMasterPlan(objective: string): string {
  return [
    "# Plan maestro",
    "",
    "## Objetivo",
    "",
    objective,
    "",
    "## Fases",
    "",
    "1. Preparar PRD/plan maestro.",
    "2. Ejecutar slices acotados con el orquestador.",
    "3. Procesar reviews y esperar merge externo cuando corresponda.",
    "4. Verificar criterios globales antes de cerrar.",
    "",
  ].join("\n");
}
