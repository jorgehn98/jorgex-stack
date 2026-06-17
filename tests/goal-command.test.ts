import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoalStore } from "../stack/plugins/opencode/goal/store.js";
import { createGoalCommandHandlers } from "../stack/plugins/opencode/goal/command.js";

const PROJECT = "jorgex-stack";

let tempDir = "";
let store: ReturnType<typeof createGoalStore> | undefined;
let handlers: ReturnType<typeof createGoalCommandHandlers> | undefined;

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

function runGoalCommand(input: string) {
  if (!handlers) {
    throw new Error("Goal command handlers are not initialised.");
  }

  return Promise.resolve().then(() => handlers!.handleGoalCommand(input));
}

async function seedGoal(objective = "Ship Goal Mode for OpenCode") {
  const output = await runGoalCommand(objective);
  const goal = store?.getActiveGoal(PROJECT);

  if (!goal) {
    throw new Error("Expected an active goal after create.");
  }

  return { goal, output };
}

async function seedOpenPullRequest(objective = "Manual merge recovery goal", number = 46) {
  const { goal } = await seedGoal(objective);
  const phase = store!.addPhase(goal.id, {
    name: "Slice waiting for manual merge signal",
    objective: "Wait until /goal merged",
    status: "active",
  });
  const worktree = store!.addWorktree(goal.id, {
    phaseId: phase.id,
    path: `C:\\tmp\\JorgeX-Stack-goal-mode-manual-merge-${number}`,
    branch: `goal-mode-manual-merge-${number}`,
    status: "active",
  });
  const pullRequest = store!.recordPullRequest(goal.id, {
    phaseId: phase.id,
    worktreeId: worktree.id,
    number,
    url: `https://github.com/jorgehn98/jorgex-stack/pull/${number}`,
    branch: `goal-mode-manual-merge-${number}`,
    base: "main",
    status: "open",
  });

  return { goal, pullRequest };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-goal-command-"));
  const databasePath = path.join(tempDir, "goals.sqlite");
  store = createGoalStore({ databasePath });
  store.migrate();
  handlers = createGoalCommandHandlers({
    store,
    project: PROJECT,
    artifactsRootDir: path.join(tempDir, "artifacts"),
  });
});

afterEach(() => {
  handlers = undefined;
  store?.close();
  store = undefined;

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("/goal command", () => {
  it("crea un goal persistente a partir de un objetivo libre", async () => {
    const objective = "Ship Goal Mode for OpenCode";
    const output = await runGoalCommand(objective);
    const goal = store?.getActiveGoal(PROJECT);

    expect(goal).toMatchObject({
      project: PROJECT,
      objective,
      status: "active",
    });
    expect(textOf(output).toLowerCase()).toContain(objective.toLowerCase());
    expect(textOf(output).toLowerCase()).toMatch(/goal|created|creado/);
    expect(store?.getArtifact(goal!.id, "plan")?.path).toContain(path.join(tempDir, "artifacts"));
  });

  it("no deja un goal abierto si falla el bootstrap de artefactos maestros", async () => {
    const blockedRoot = path.join(tempDir, "blocked-artifacts-root");
    fs.writeFileSync(blockedRoot, "not a directory", "utf8");
    handlers = createGoalCommandHandlers({
      store: store!,
      project: PROJECT,
      artifactsRootDir: blockedRoot,
    });

    await expect(runGoalCommand("Bootstrap must roll back")).rejects.toThrow(/bootstrap failed/i);

    expect(store!.getCurrentGoal(PROJECT)).toBeUndefined();
  });

  it("rechaza un objetivo vacío", async () => {
    await expect(runGoalCommand("")).rejects.toThrow(/objective|objetivo|vac/i);
    await expect(runGoalCommand("   ")).rejects.toThrow(/objective|objetivo|vac/i);
  });

  it("rechaza /goal quick y /goal work", async () => {
    await expect(runGoalCommand("quick")).rejects.toThrow(/quick|work|unsupported|no soport/i);
    await expect(runGoalCommand("work")).rejects.toThrow(/quick|work|unsupported|no soport/i);
  });

  it("status devuelve el goal actual sin tocar modelos reales", async () => {
    const { goal } = await seedGoal();
    const output = await runGoalCommand("status");
    const text = textOf(output).toLowerCase();

    expect(text).toContain(goal.objective.toLowerCase());
    expect(text).toContain("active");
    expect(store?.getGoal(goal.id)).toMatchObject({ status: "active" });
  });

  it("plan devuelve una vista del plan del goal actual", async () => {
    const { goal } = await seedGoal();
    const output = await runGoalCommand("plan");
    const text = textOf(output).toLowerCase();

    expect(text).toContain(goal.objective.toLowerCase());
    expect(text).toMatch(/plan|fases|phase/);
  });

  it("history conserva los eventos anteriores después de cancelar", async () => {
    const { goal } = await seedGoal();

    await runGoalCommand("pause");
    await runGoalCommand("resume");

    const beforeCancel = textOf(await runGoalCommand("history")).toLowerCase();
    expect(beforeCancel).toContain(goal.objective.toLowerCase());
    expect(beforeCancel).toContain("paused");
    expect(beforeCancel).toContain("active");

    await runGoalCommand("cancel");
    expect(store?.getGoal(goal.id)).toMatchObject({ status: "cancelled" });

    const afterCancel = textOf(await runGoalCommand("history")).toLowerCase();
    expect(afterCancel).toContain(goal.objective.toLowerCase());
    expect(afterCancel).toContain("paused");
    expect(afterCancel).toContain("active");
    expect(afterCancel).toContain("cancel");
  });

  it("recupera un goal pausado desde SQLite después de reiniciar handlers", async () => {
    const { goal } = await seedGoal("Recover paused goal");
    await runGoalCommand("pause");

    handlers = createGoalCommandHandlers({ store: store!, project: PROJECT });

    const status = textOf(await runGoalCommand("status")).toLowerCase();
    expect(status).toContain(goal.objective.toLowerCase());
    expect(status).toContain("paused");
  });

  it("rechaza crear otro goal mientras existe uno no terminal", async () => {
    await seedGoal("First open goal");

    await expect(runGoalCommand("Second open goal")).rejects.toThrow(/already has an open goal|goal abierto/i);
  });

  it("resume no salta waiting_for_merge cuando hay un PR abierto", async () => {
    const { goal } = await seedGoal("Wait for merge goal");
    const phase = store!.addPhase(goal.id, {
      name: "Slice waiting for merge",
      objective: "Keep waiting until external merge",
      status: "active",
    });
    const worktree = store!.addWorktree(goal.id, {
      phaseId: phase.id,
      path: "C:\\tmp\\JorgeX-Stack-goal-mode-wait",
      branch: "goal-mode-wait",
      status: "active",
    });
    store!.recordPullRequest(goal.id, {
      phaseId: phase.id,
      worktreeId: worktree.id,
      number: 45,
      url: "https://github.com/jorgehn98/jorgex-stack/pull/45",
      branch: "goal-mode-wait",
      base: "main",
      status: "open",
    });

    await expect(runGoalCommand("resume")).rejects.toThrow(/waiting for an external PR merge/i);
    expect(store!.getGoal(goal.id)).toMatchObject({ status: "waiting_for_merge" });
  });

  it("permite señalar manualmente que el PR externo ya fue mergeado", async () => {
    const { goal } = await seedOpenPullRequest("Manual merge recovery goal", 46);

    const output = textOf(await runGoalCommand("merged\tabc123")).toLowerCase();

    expect(output).toContain("#46");
    expect(output).toContain("active");
    expect(store!.getGoal(goal.id)).toMatchObject({ status: "active" });
    expect(store!.getOpenPullRequest(goal.id)).toBeUndefined();
  });

  it("usa mergeCommit manual por defecto en /goal merged sin argumento", async () => {
    const { pullRequest } = await seedOpenPullRequest("Manual merge default commit goal", 47);

    await runGoalCommand("merged");

    expect(store!.getPullRequest(pullRequest.id)).toMatchObject({
      status: "merged",
      mergeCommit: "manual",
    });
  });

  it("rechaza /goal merged si no hay PR abierto", async () => {
    await seedGoal("No open PR to merge");

    await expect(runGoalCommand("merged")).rejects.toThrow(/no open pull request/i);
  });

  it("falla explícitamente si /goal plan requiere artefactos pero no hay plan registrado", () => {
    store!.createGoal({
      objective: "Missing registered master plan",
      project: PROJECT,
    });

    expect(() => handlers!.handleGoalCommand("plan")).toThrow(/plan artifact is not registered/i);
  });

  it("pause, resume y cancel actualizan el estado persistido del goal", async () => {
    const { goal } = await seedGoal();

    const pauseOutput = textOf(await runGoalCommand("pause")).toLowerCase();
    expect(pauseOutput).toContain("paused");
    expect(store?.getGoal(goal.id)).toMatchObject({ status: "paused" });

    const resumeOutput = textOf(await runGoalCommand("resume")).toLowerCase();
    expect(resumeOutput).toContain("active");
    expect(store?.getGoal(goal.id)).toMatchObject({ status: "active" });

    const cancelOutput = textOf(await runGoalCommand("cancel")).toLowerCase();
    expect(cancelOutput).toContain("cancel");
    expect(store?.getGoal(goal.id)).toMatchObject({ status: "cancelled" });
  });
});
