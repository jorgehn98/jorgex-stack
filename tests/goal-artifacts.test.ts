import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoalStore } from "../stack/plugins/opencode/goal/store.js";
import { createGoalCommandHandlers } from "../stack/plugins/opencode/goal/command.js";

type GoalArtifactsModule = typeof import("../stack/plugins/opencode/goal/artifacts.js");

interface GoalArtifactRecord {
  id: string;
  goalId: string;
  kind: "prd" | "plan";
  path: string;
  createdAt: string;
  updatedAt: string;
}

interface GoalArtifactsStore {
  recordArtifact(goalId: string, input: { kind: "prd" | "plan"; path: string }): GoalArtifactRecord;
  listArtifacts(goalId: string): GoalArtifactRecord[];
  getArtifact(goalId: string, kind: "prd" | "plan"): GoalArtifactRecord | undefined;
}

type ArtifactStore = ReturnType<typeof createGoalStore> & GoalArtifactsStore;

const PROJECT = "jorgex-stack";

let tempDir = "";
let goalRoot = "";
let store: ArtifactStore | undefined;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "text", "content", "output", "body"]) {
      const candidate = record[key];
      if (typeof candidate === "string") return candidate;
    }
  }

  throw new Error(`Expected a text response, got ${JSON.stringify(value)}`);
}

async function loadArtifactsModule(): Promise<GoalArtifactsModule> {
  return import("../stack/plugins/opencode/goal/artifacts.js");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-goal-artifacts-"));
  goalRoot = path.join(tempDir, "goal-root");
  store = createGoalStore({ databasePath: path.join(tempDir, "goals.sqlite") }) as ArtifactStore;
  store.migrate();
});

afterEach(() => {
  store?.close();
  store = undefined;

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
    goalRoot = "";
  }
});

describe("Goal Mode master artifacts", () => {
  it("crea PRD.md y plan.md maestros, y registra sus rutas en SQLite", async () => {
    const { createMasterArtifacts } = await loadArtifactsModule();
    const goal = store!.createGoal({
      objective: "Ship master artifacts for Goal Mode",
      project: PROJECT,
    });

    const result = await createMasterArtifacts({
      store: store!,
      goalId: goal.id,
      rootDir: goalRoot,
    });

    expect(result).toMatchObject({
      created: true,
      preserved: false,
      prdPath: path.join(goalRoot, "PRD.md"),
      planPath: path.join(goalRoot, "plan.md"),
    });

    expect(fs.existsSync(result.prdPath)).toBe(true);
    expect(fs.existsSync(result.planPath)).toBe(true);
    expect(fs.readFileSync(result.prdPath, "utf8")).toContain(goal.objective);
    expect(fs.readFileSync(result.planPath, "utf8")).toContain(goal.objective);

    expect(store!.listArtifacts(goal.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "prd", path: result.prdPath }),
        expect.objectContaining({ kind: "plan", path: result.planPath }),
      ]),
    );
    expect(store!.getArtifact(goal.id, "plan")).toMatchObject({ path: result.planPath });
  });

  it("no pisa el plan maestro si ya tiene edición humana", async () => {
    const { createMasterArtifacts } = await loadArtifactsModule();
    const goal = store!.createGoal({
      objective: "Preserve human edits in master plan",
      project: PROJECT,
    });

    const first = await createMasterArtifacts({
      store: store!,
      goalId: goal.id,
      rootDir: goalRoot,
    });

    const humanPlan = [
      "# Plan maestro",
      "",
      "Edición humana.",
      "No sobrescribir.",
      "",
    ].join("\n");
    fs.writeFileSync(first.planPath, humanPlan, "utf8");

    const second = await createMasterArtifacts({
      store: store!,
      goalId: goal.id,
      rootDir: goalRoot,
    });

    expect(second).toMatchObject({
      created: false,
      preserved: true,
      prdPath: first.prdPath,
      planPath: first.planPath,
    });
    expect(fs.readFileSync(first.planPath, "utf8")).toBe(humanPlan);
    expect(store!.listArtifacts(goal.id)).toHaveLength(2);
  });

  it("hace que /goal plan lea el plan maestro registrado", async () => {
    const goal = store!.createGoal({
      objective: "Expose master plan through /goal plan",
      project: PROJECT,
    });

    const humanReadablePlan = [
      "# Plan maestro",
      "",
      "1. Primera fase",
      "2. Segunda fase",
      "",
      "Responsable: Goal Mode",
    ].join("\n");
    fs.mkdirSync(goalRoot, { recursive: true });
    const planPath = path.join(goalRoot, "plan.md");
    fs.writeFileSync(planPath, humanReadablePlan, "utf8");

    store!.recordArtifact(goal.id, { kind: "plan", path: planPath });

    const handlers = createGoalCommandHandlers({ store: store!, project: PROJECT });
    const output = textOf(handlers.handleGoalCommand("plan"));

    expect(output).toContain("Expose master plan through /goal plan");
    expect(output).toContain("Primera fase");
    expect(output).toContain("Segunda fase");
    expect(output).toContain("Goal Mode");
  });
});
