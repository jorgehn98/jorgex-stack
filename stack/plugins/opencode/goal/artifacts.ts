import fs from "node:fs";
import path from "node:path";
import type { GoalStore } from "./types.js";

export interface MasterArtifactsInput {
  store: GoalStore;
  goalId: string;
  rootDir: string;
}

export interface MasterArtifactsResult {
  created: boolean;
  preserved: boolean;
  prdPath: string;
  planPath: string;
}

export async function createMasterArtifacts(input: MasterArtifactsInput): Promise<MasterArtifactsResult> {
  const goal = input.store.getGoal(input.goalId);
  if (!goal) {
    throw new Error(`Goal ${input.goalId} not found.`);
  }

  fs.mkdirSync(input.rootDir, { recursive: true });

  const prdPath = path.join(input.rootDir, "PRD.md");
  const planPath = path.join(input.rootDir, "plan.md");
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

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, "utf8");
  return true;
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
