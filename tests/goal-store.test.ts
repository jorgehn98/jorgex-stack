import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGoalStore, GOAL_STORE_SCHEMA_VERSION } from "../stack/plugins/opencode/goal/store.js";

const tempDirs: string[] = [];

function makeDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-goal-store-"));
  tempDirs.push(dir);
  return path.join(dir, "goals.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Goal Mode SQLite store", () => {
  it("migrates legacy duplicate open goals before adding the uniqueness guard", async () => {
    const databasePath = makeDbPath();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    const insert = database.prepare(
      `INSERT INTO goals (id, project, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run("goal_old", "jorgex-stack", "Old open goal", "active", "2026-06-17T00:00:00.000Z", "2026-06-17T00:00:00.000Z");
    insert.run("goal_new", "jorgex-stack", "New open goal", "paused", "2026-06-17T01:00:00.000Z", "2026-06-17T01:00:00.000Z");
    database.close();

    const store = createGoalStore({ databasePath });

    expect(() => store.migrate()).not.toThrow();
    expect(store.schemaVersion()).toBe(GOAL_STORE_SCHEMA_VERSION);
    expect(store.getCurrentGoal("jorgex-stack")).toMatchObject({
      id: "goal_new",
      status: "paused",
    });
    expect(store.getGoal("goal_old")).toMatchObject({ status: "cancelled" });

    store.close();
  });

  it("creates a new DB, applies versioned migrations and creates an active goal", () => {
    const store = createGoalStore({ databasePath: makeDbPath() });

    store.migrate();

    expect(store.schemaVersion()).toBe(GOAL_STORE_SCHEMA_VERSION);

    const goal = store.createGoal({
      objective: "ship Goal Mode for OpenCode",
      project: "jorgex-stack",
    });

    expect(goal).toMatchObject({
      objective: "ship Goal Mode for OpenCode",
      project: "jorgex-stack",
      status: "active",
    });
    expect(goal.id).toEqual(expect.any(String));
    expect(goal.createdAt).toEqual(expect.any(String));
    expect(goal.updatedAt).toEqual(expect.any(String));

    expect(store.getGoal(goal.id)).toMatchObject(goal);
    expect(store.getActiveGoal("jorgex-stack")).toMatchObject(goal);

    store.close();
  });

  it("persists append-only ordered events and recovers an active goal after reopening", () => {
    const databasePath = makeDbPath();
    const first = createGoalStore({
      databasePath,
      now: (() => {
        const ticks = [
          "2026-06-17T00:00:00.000Z",
          "2026-06-17T00:00:01.000Z",
          "2026-06-17T00:00:02.000Z",
        ];
        return () => ticks.shift() ?? "2026-06-17T00:00:03.000Z";
      })(),
    });

    first.migrate();
    const goal = first.createGoal({
      objective: "multi PR goal",
      project: "jorgex-stack",
    });
    first.appendEvent(goal.id, {
      type: "goal.started",
      message: "Goal created",
      data: { source: "command" },
    });
    first.appendEvent(goal.id, {
      type: "slice.planned",
      message: "First slice planned",
      data: { slice: "store" },
    });
    first.close();

    const reopened = createGoalStore({ databasePath });
    reopened.migrate();

    expect(reopened.getActiveGoal("jorgex-stack")).toMatchObject({
      id: goal.id,
      status: "active",
      objective: "multi PR goal",
    });
    expect(reopened.listEvents(goal.id).map((event) => event.type)).toEqual([
      "goal.started",
      "slice.planned",
    ]);
    expect(reopened.listEvents(goal.id).map((event) => event.createdAt)).toEqual([
      "2026-06-17T00:00:01.000Z",
      "2026-06-17T00:00:02.000Z",
    ]);

    reopened.close();
  });

  it("enforces valid state transitions and rejects invalid transitions", () => {
    const store = createGoalStore({ databasePath: makeDbPath() });
    store.migrate();
    const goal = store.createGoal({ objective: "state machine", project: "jorgex-stack" });

    expect(store.transitionGoal(goal.id, "paused", { reason: "user requested pause" })).toMatchObject({
      id: goal.id,
      status: "paused",
    });
    expect(store.transitionGoal(goal.id, "active", { reason: "resume" })).toMatchObject({
      id: goal.id,
      status: "active",
    });
    expect(store.transitionGoal(goal.id, "waiting_for_merge", { reason: "PR opened" })).toMatchObject({
      id: goal.id,
      status: "waiting_for_merge",
    });

    expect(() => store.transitionGoal(goal.id, "complete", { reason: "pretend done" })).toThrow(
      /invalid transition/i,
    );

    expect(store.transitionGoal(goal.id, "active", { reason: "merge detected externally" })).toMatchObject({
      id: goal.id,
      status: "active",
    });
    expect(store.transitionGoal(goal.id, "complete", { reason: "all success criteria verified" })).toMatchObject({
      id: goal.id,
      status: "complete",
    });
    expect(() => store.transitionGoal(goal.id, "active", { reason: "resume completed goal" })).toThrow(
      /terminal/i,
    );

    store.close();
  });

  it("registers phases, worktrees, pull requests and waits for all external merge evidence", () => {
    const store = createGoalStore({ databasePath: makeDbPath() });
    store.migrate();
    const goal = store.createGoal({ objective: "multi PR goal", project: "jorgex-stack" });

    const phase = store.addPhase(goal.id, {
      name: "SQLite store",
      objective: "Create state foundation",
      status: "active",
    });
    const worktree = store.addWorktree(goal.id, {
      phaseId: phase.id,
      path: "C:\\tmp\\JorgeX-Stack-goal-mode-store",
      branch: "goal-mode-store",
      status: "active",
    });
    const pullRequest = store.recordPullRequest(goal.id, {
      phaseId: phase.id,
      worktreeId: worktree.id,
      number: 42,
      url: "https://github.com/jorgehn98/jorgex-stack/pull/42",
      branch: "goal-mode-store",
      base: "main",
      status: "open",
    });
    const secondPhase = store.addPhase(goal.id, {
      name: "Command UX",
      objective: "Create command handlers",
      status: "active",
    });
    const secondWorktree = store.addWorktree(goal.id, {
      phaseId: secondPhase.id,
      path: "C:\\tmp\\JorgeX-Stack-goal-mode-command",
      branch: "goal-mode-command",
      status: "active",
    });
    const secondPullRequest = store.recordPullRequest(goal.id, {
      phaseId: secondPhase.id,
      worktreeId: secondWorktree.id,
      number: 43,
      url: "https://github.com/jorgehn98/jorgex-stack/pull/43",
      branch: "goal-mode-command",
      base: "main",
      status: "open",
    });

    expect(store.getGoal(goal.id)?.status).toBe("waiting_for_merge");
    expect(store.getPullRequest(pullRequest.id)).toMatchObject({
      number: 42,
      status: "open",
    });
    expect(store.nextAction(goal.id)).toMatchObject({
      type: "wait_for_merge",
      pullRequestId: pullRequest.id,
    });

    store.recordPullRequestMerged(pullRequest.id, {
      mergedAt: "2026-06-17T01:00:00.000Z",
      mergeCommit: "abc123",
    });

    expect(store.getPullRequest(pullRequest.id)).toMatchObject({
      status: "merged",
      mergedAt: "2026-06-17T01:00:00.000Z",
      mergeCommit: "abc123",
    });
    expect(store.getGoal(goal.id)?.status).toBe("waiting_for_merge");
    expect(store.nextAction(goal.id)).toMatchObject({
      type: "wait_for_merge",
      pullRequestId: secondPullRequest.id,
    });

    store.recordPullRequestMerged(secondPullRequest.id, {
      mergedAt: "2026-06-17T02:00:00.000Z",
      mergeCommit: "def456",
    });

    expect(store.getGoal(goal.id)?.status).toBe("active");
    expect(() =>
      store.recordPullRequestMerged(secondPullRequest.id, {
        mergedAt: "2026-06-17T03:00:00.000Z",
        mergeCommit: "already-merged",
      }),
    ).toThrow(/not open/i);

    store.close();
  });

  it("keeps an open pull request as the next action gate even if status is resumed", () => {
    const store = createGoalStore({ databasePath: makeDbPath() });
    store.migrate();
    const goal = store.createGoal({ objective: "open PR invariant", project: "jorgex-stack" });
    const phase = store.addPhase(goal.id, {
      name: "PR gate",
      objective: "Protect open PR invariant",
      status: "active",
    });
    const worktree = store.addWorktree(goal.id, {
      phaseId: phase.id,
      path: "C:\\tmp\\JorgeX-Stack-goal-mode-invariant",
      branch: "goal-mode-invariant",
      status: "active",
    });
    const pullRequest = store.recordPullRequest(goal.id, {
      phaseId: phase.id,
      worktreeId: worktree.id,
      number: 47,
      url: "https://github.com/jorgehn98/jorgex-stack/pull/47",
      branch: "goal-mode-invariant",
      base: "main",
      status: "open",
    });

    const resumed = store.transitionGoal(goal.id, "active", { reason: "manual resume attempt" });

    expect(resumed.status).toBe("waiting_for_merge");
    expect(store.nextAction(goal.id)).toEqual({
      type: "wait_for_merge",
      pullRequestId: pullRequest.id,
    });

    store.close();
  });

  it("does not unblock a blocked goal just because an open pull request was merged", () => {
    const store = createGoalStore({ databasePath: makeDbPath() });
    store.migrate();
    const goal = store.createGoal({ objective: "blocked multi PR goal", project: "jorgex-stack" });
    const phase = store.addPhase(goal.id, {
      name: "Blocked slice",
      objective: "Needs human input after PR",
      status: "active",
    });
    const worktree = store.addWorktree(goal.id, {
      phaseId: phase.id,
      path: "C:\\tmp\\JorgeX-Stack-goal-mode-blocked",
      branch: "goal-mode-blocked",
      status: "active",
    });
    const pullRequest = store.recordPullRequest(goal.id, {
      phaseId: phase.id,
      worktreeId: worktree.id,
      number: 44,
      url: "https://github.com/jorgehn98/jorgex-stack/pull/44",
      branch: "goal-mode-blocked",
      base: "main",
      status: "open",
    });

    store.transitionGoal(goal.id, "blocked", { reason: "human decision required" });
    store.recordPullRequestMerged(pullRequest.id, {
      mergedAt: "2026-06-17T03:00:00.000Z",
      mergeCommit: "fed789",
    });

    expect(store.getGoal(goal.id)?.status).toBe("blocked");
    expect(store.nextAction(goal.id)).toEqual({ type: "continue" });

    store.close();
  });

  it("rolls back a composed operation when any write fails", () => {
    const store = createGoalStore({ databasePath: makeDbPath() });
    store.migrate();
    const goal = store.createGoal({ objective: "rollback", project: "jorgex-stack" });

    expect(() =>
      store.transaction(() => {
        store.addPhase(goal.id, {
          name: "Valid phase",
          objective: "This should roll back",
          status: "active",
        });
        store.addWorktree(goal.id, {
          phaseId: "missing-phase",
          path: "C:\\tmp\\missing",
          branch: "missing",
          status: "active",
        });
      }),
    ).toThrow();

    expect(store.listPhases(goal.id)).toEqual([]);
    expect(store.listWorktrees(goal.id)).toEqual([]);

    store.close();
  });
});
