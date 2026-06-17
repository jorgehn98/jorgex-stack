import { randomUUID } from "node:crypto";
import { GoalDb } from "./db.js";
import { assertGoalTransition, isTerminalGoalStatus } from "./state.js";
import {
  GOAL_STORE_SCHEMA_VERSION,
  type GoalArtifactInput,
  type GoalArtifactKind,
  type GoalArtifactRecord,
  type GoalEventInput,
  type GoalEventRecord,
  type GoalInput,
  type GoalRecord,
  type GoalStatus,
  type GoalStore,
  type GoalStoreOptions,
  type GoalTransitionInput,
  type NextAction,
  type PhaseInput,
  type PhaseRecord,
  type PullRequestInput,
  type PullRequestMergeInput,
  type PullRequestRecord,
  type WorktreeInput,
  type WorktreeRecord,
} from "./types.js";

export { GOAL_STORE_SCHEMA_VERSION } from "./types.js";

type Row = Record<string, unknown>;

export function createGoalStore(options: GoalStoreOptions): GoalStore {
  return new GoalStoreImpl(options);
}

function createRecordId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function readText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid SQLite row: ${key} must be a string.`);
  }
  return value;
}

function readNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Invalid SQLite row: ${key} must be a number.`);
  }
  return value;
}

function readOptionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid SQLite row: ${key} must be a string.`);
  }
  return value;
}

function encodeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeJson(value: string | undefined): unknown {
  return value === undefined ? undefined : JSON.parse(value);
}

function mapGoal(row: Row): GoalRecord {
  return {
    id: readText(row, "id"),
    project: readText(row, "project"),
    objective: readText(row, "objective"),
    status: readText(row, "status") as GoalStatus,
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
  };
}

function mapEvent(row: Row): GoalEventRecord {
  return {
    id: readText(row, "id"),
    goalId: readText(row, "goal_id"),
    type: readText(row, "type"),
    message: readText(row, "message"),
    data: decodeJson(readOptionalText(row, "data")),
    createdAt: readText(row, "created_at"),
    sequence: readNumber(row, "sequence"),
  };
}

function mapPhase(row: Row): PhaseRecord {
  return {
    id: readText(row, "id"),
    goalId: readText(row, "goal_id"),
    name: readText(row, "name"),
    objective: readText(row, "objective"),
    status: readText(row, "status") as GoalStatus,
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
  };
}

function mapWorktree(row: Row): WorktreeRecord {
  return {
    id: readText(row, "id"),
    goalId: readText(row, "goal_id"),
    phaseId: readText(row, "phase_id"),
    path: readText(row, "path"),
    branch: readText(row, "branch"),
    status: readText(row, "status") as GoalStatus,
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
  };
}

function mapPullRequest(row: Row): PullRequestRecord {
  return {
    id: readText(row, "id"),
    goalId: readText(row, "goal_id"),
    phaseId: readText(row, "phase_id"),
    worktreeId: readText(row, "worktree_id"),
    number: readNumber(row, "number"),
    url: readText(row, "url"),
    branch: readText(row, "branch"),
    base: readText(row, "base"),
    status: readText(row, "status") as PullRequestRecord["status"],
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
    mergedAt: readOptionalText(row, "merged_at"),
    mergeCommit: readOptionalText(row, "merge_commit"),
  };
}

function mapArtifact(row: Row): GoalArtifactRecord {
  return {
    id: readText(row, "id"),
    goalId: readText(row, "goal_id"),
    kind: readText(row, "kind") as GoalArtifactKind,
    path: readText(row, "path"),
    createdAt: readText(row, "created_at"),
    updatedAt: readText(row, "updated_at"),
  };
}

class GoalStoreImpl implements GoalStore {
  private readonly db: GoalDb;
  private readonly now: () => string;
  private isClosed = false;
  private inTransaction = false;

  constructor(options: GoalStoreOptions) {
    this.db = new GoalDb(options.databasePath);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  migrate(): void {
    this.ensureOpen();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_goals_project_status_updated
        ON goals(project, status, updated_at);

      UPDATE goals
      SET status = 'cancelled'
      WHERE status NOT IN ('failed', 'complete', 'cancelled')
        AND EXISTS (
          SELECT 1
          FROM goals AS newer
          WHERE newer.project = goals.project
            AND newer.status NOT IN ('failed', 'complete', 'cancelled')
            AND (
              newer.updated_at > goals.updated_at
              OR (newer.updated_at = goals.updated_at AND newer.created_at > goals.created_at)
              OR (
                newer.updated_at = goals.updated_at
                AND newer.created_at = goals.created_at
                AND newer.id > goals.id
              )
            )
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_one_open_per_project
        ON goals(project)
        WHERE status NOT IN ('failed', 'complete', 'cancelled');

      CREATE TABLE IF NOT EXISTS goal_events (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_goal_events_goal_sequence
        ON goal_events(goal_id, sequence);

      CREATE TABLE IF NOT EXISTS goal_phases (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS goal_worktrees (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        phase_id TEXT NOT NULL REFERENCES goal_phases(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS goal_prs (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        phase_id TEXT NOT NULL REFERENCES goal_phases(id) ON DELETE CASCADE,
        worktree_id TEXT NOT NULL REFERENCES goal_worktrees(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        branch TEXT NOT NULL,
        base TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        merged_at TEXT,
        merge_commit TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_goal_prs_goal_status_created
        ON goal_prs(goal_id, status, created_at);

      CREATE TABLE IF NOT EXISTS goal_artifacts (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(goal_id, kind)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_goal_artifacts_goal_kind
        ON goal_artifacts(goal_id, kind);

      PRAGMA user_version = ${GOAL_STORE_SCHEMA_VERSION};
    `);
  }

  schemaVersion(): number {
    this.ensureOpen();
    const row = this.db.get("PRAGMA user_version;");
    return typeof row?.user_version === "number" ? row.user_version : 0;
  }

  createGoal(input: GoalInput): GoalRecord {
    this.ensureOpen();
    this.assertText(input.objective, "objective");
    this.assertText(input.project, "project");

    const existing = this.getCurrentGoal(input.project);
    if (existing) {
      throw new Error(`Project ${input.project} already has an open goal: ${existing.objective}.`);
    }

    const createdAt = this.now();
    const goal: GoalRecord = {
      id: createRecordId("goal"),
      project: input.project,
      objective: input.objective,
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };

    this.db.run(
      `INSERT INTO goals (id, project, objective, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      goal.id,
      goal.project,
      goal.objective,
      goal.status,
      goal.createdAt,
      goal.updatedAt,
    );

    return goal;
  }

  getGoal(goalId: string): GoalRecord | undefined {
    this.ensureOpen();
    const row = this.db.get("SELECT * FROM goals WHERE id = ?", goalId);
    return row ? mapGoal(row) : undefined;
  }

  getActiveGoal(project: string): GoalRecord | undefined {
    this.ensureOpen();
    const row = this.db.get(
      `SELECT * FROM goals
       WHERE project = ? AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`,
      project,
    );
    return row ? mapGoal(row) : undefined;
  }

  getCurrentGoal(project: string): GoalRecord | undefined {
    this.ensureOpen();
    const row = this.db.get(
      `SELECT * FROM goals
       WHERE project = ? AND status NOT IN ('failed', 'complete', 'cancelled')
       ORDER BY updated_at DESC
       LIMIT 1`,
      project,
    );
    return row ? mapGoal(row) : undefined;
  }

  appendEvent(goalId: string, input: GoalEventInput): GoalEventRecord {
    return this.atomically(() => {
      this.ensureOpen();
      const goal = this.requireGoal(goalId);
      this.assertText(input.type, "type");
      this.assertText(input.message, "message");

      const sequenceRow = this.db.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM goal_events");
      const sequence =
        typeof sequenceRow?.next_sequence === "number" ? sequenceRow.next_sequence : 1;
      const createdAt = this.now();
      const event: GoalEventRecord = {
        id: createRecordId("event"),
        goalId,
        type: input.type,
        message: input.message,
        data: input.data,
        createdAt,
        sequence,
      };

      this.db.run(
        `INSERT INTO goal_events (id, goal_id, type, message, data, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.goalId,
        event.type,
        event.message,
        encodeJson(event.data),
        event.createdAt,
        event.sequence,
      );
      this.touchGoal(goal.id, createdAt);
      return event;
    });
  }

  listEvents(goalId: string): GoalEventRecord[] {
    this.ensureOpen();
    return this.db
      .all("SELECT * FROM goal_events WHERE goal_id = ? ORDER BY sequence ASC", goalId)
      .map(mapEvent);
  }

  transitionGoal(
    goalId: string,
    status: GoalStatus,
    input: GoalTransitionInput,
  ): GoalRecord {
    return this.atomically(() => {
      this.ensureOpen();
      const goal = this.requireGoal(goalId);
      this.assertText(input.reason, "reason");

      if (goal.status === status) return goal;

      assertGoalTransition(goal.status, status);
      const updatedAt = this.now();
      this.db.run(
        "UPDATE goals SET status = ?, updated_at = ? WHERE id = ?",
        status,
        updatedAt,
        goalId,
      );
      this.insertEvent(goalId, `goal.${status}`, input.reason, { from: goal.status, to: status }, updatedAt);
      return this.requireGoal(goalId);
    });
  }

  addPhase(goalId: string, input: PhaseInput): PhaseRecord {
    return this.atomically(() => {
      this.ensureOpen();
      this.requireGoal(goalId);
      this.assertText(input.name, "name");
      this.assertText(input.objective, "objective");

      const createdAt = this.now();
      const phase: PhaseRecord = {
        id: createRecordId("phase"),
        goalId,
        name: input.name,
        objective: input.objective,
        status: input.status,
        createdAt,
        updatedAt: createdAt,
      };

      this.db.run(
        `INSERT INTO goal_phases (id, goal_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        phase.id,
        phase.goalId,
        phase.name,
        phase.objective,
        phase.status,
        phase.createdAt,
        phase.updatedAt,
      );
      this.insertEvent(goalId, "goal.phase_added", "Goal phase added", {
        phaseId: phase.id,
        name: phase.name,
        status: phase.status,
      }, createdAt);
      this.touchGoal(goalId, createdAt);
      return phase;
    });
  }

  addWorktree(goalId: string, input: WorktreeInput): WorktreeRecord {
    return this.atomically(() => {
      this.ensureOpen();
      this.requireGoal(goalId);
      this.requirePhase(goalId, input.phaseId);
      this.assertText(input.path, "path");
      this.assertText(input.branch, "branch");

      const createdAt = this.now();
      const worktree: WorktreeRecord = {
        id: createRecordId("worktree"),
        goalId,
        phaseId: input.phaseId,
        path: input.path,
        branch: input.branch,
        status: input.status,
        createdAt,
        updatedAt: createdAt,
      };

      this.db.run(
        `INSERT INTO goal_worktrees (id, goal_id, phase_id, path, branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        worktree.id,
        worktree.goalId,
        worktree.phaseId,
        worktree.path,
        worktree.branch,
        worktree.status,
        worktree.createdAt,
        worktree.updatedAt,
      );
      this.insertEvent(goalId, "goal.worktree_added", "Goal worktree added", {
        worktreeId: worktree.id,
        phaseId: worktree.phaseId,
        branch: worktree.branch,
        status: worktree.status,
      }, createdAt);
      this.touchGoal(goalId, createdAt);
      return worktree;
    });
  }

  recordPullRequest(goalId: string, input: PullRequestInput): PullRequestRecord {
    return this.atomically(() => {
      this.ensureOpen();
      const goal = this.requireGoal(goalId);
      this.requirePhase(goalId, input.phaseId);
      this.requireWorktree(goalId, input.phaseId, input.worktreeId);
      this.assertText(input.url, "url");
      this.assertText(input.branch, "branch");
      this.assertText(input.base, "base");

      if (isTerminalGoalStatus(goal.status)) {
        throw new Error(`Cannot register a pull request on terminal goal ${goalId}.`);
      }

      const createdAt = this.now();
      const pullRequest: PullRequestRecord = {
        id: createRecordId("pr"),
        goalId,
        phaseId: input.phaseId,
        worktreeId: input.worktreeId,
        number: input.number,
        url: input.url,
        branch: input.branch,
        base: input.base,
        status: input.status,
        createdAt,
        updatedAt: createdAt,
      };

      this.db.run(
        `INSERT INTO goal_prs
         (id, goal_id, phase_id, worktree_id, number, url, branch, base, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pullRequest.id,
        pullRequest.goalId,
        pullRequest.phaseId,
        pullRequest.worktreeId,
        pullRequest.number,
        pullRequest.url,
        pullRequest.branch,
        pullRequest.base,
        pullRequest.status,
        pullRequest.createdAt,
        pullRequest.updatedAt,
      );

      if (input.status === "open") {
        this.db.run(
          "UPDATE goals SET status = 'waiting_for_merge', updated_at = ? WHERE id = ?",
          createdAt,
          goalId,
        );
        this.insertEvent(goalId, "goal.waiting_for_merge", "Pull request opened", {
          pullRequestId: pullRequest.id,
          number: pullRequest.number,
        }, createdAt);
      } else {
        this.insertEvent(goalId, "goal.pull_request_recorded", "Pull request recorded", {
          pullRequestId: pullRequest.id,
          number: pullRequest.number,
          status: pullRequest.status,
        }, createdAt);
        this.touchGoal(goalId, createdAt);
      }

      return pullRequest;
    });
  }

  getPullRequest(pullRequestId: string): PullRequestRecord | undefined {
    this.ensureOpen();
    const row = this.db.get("SELECT * FROM goal_prs WHERE id = ?", pullRequestId);
    return row ? mapPullRequest(row) : undefined;
  }

  getOpenPullRequest(goalId: string): PullRequestRecord | undefined {
    this.ensureOpen();
    const row = this.db.get(
      `SELECT * FROM goal_prs
       WHERE goal_id = ? AND status = 'open'
       ORDER BY created_at ASC
       LIMIT 1`,
      goalId,
    );
    return row ? mapPullRequest(row) : undefined;
  }

  listPullRequests(goalId: string): PullRequestRecord[] {
    this.ensureOpen();
    return this.db
      .all("SELECT * FROM goal_prs WHERE goal_id = ? ORDER BY created_at ASC", goalId)
      .map(mapPullRequest);
  }

  recordArtifact(goalId: string, input: GoalArtifactInput): GoalArtifactRecord {
    return this.atomically(() => {
      this.ensureOpen();
      this.requireGoal(goalId);
      this.assertText(input.path, "path");
      if (input.kind !== "prd" && input.kind !== "plan") {
        throw new Error(`Invalid artifact kind: ${input.kind}`);
      }

      const existing = this.getArtifact(goalId, input.kind);
      const updatedAt = this.now();
      if (existing) {
        this.db.run(
          "UPDATE goal_artifacts SET path = ?, updated_at = ? WHERE id = ?",
          input.path,
          updatedAt,
          existing.id,
        );
        this.insertEvent(goalId, "goal.artifact_recorded", "Goal artifact updated", {
          artifactId: existing.id,
          kind: input.kind,
        }, updatedAt);
        this.touchGoal(goalId, updatedAt);
        return this.getArtifact(goalId, input.kind)!;
      }

      const artifact: GoalArtifactRecord = {
        id: createRecordId("artifact"),
        goalId,
        kind: input.kind,
        path: input.path,
        createdAt: updatedAt,
        updatedAt,
      };

      this.db.run(
        `INSERT INTO goal_artifacts (id, goal_id, kind, path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        artifact.id,
        artifact.goalId,
        artifact.kind,
        artifact.path,
        artifact.createdAt,
        artifact.updatedAt,
      );
      this.insertEvent(goalId, "goal.artifact_recorded", "Goal artifact recorded", {
        artifactId: artifact.id,
        kind: artifact.kind,
      }, updatedAt);
      this.touchGoal(goalId, updatedAt);
      return artifact;
    });
  }

  listArtifacts(goalId: string): GoalArtifactRecord[] {
    this.ensureOpen();
    return this.db
      .all("SELECT * FROM goal_artifacts WHERE goal_id = ? ORDER BY kind ASC", goalId)
      .map(mapArtifact);
  }

  getArtifact(goalId: string, kind: GoalArtifactKind): GoalArtifactRecord | undefined {
    this.ensureOpen();
    const row = this.db.get(
      "SELECT * FROM goal_artifacts WHERE goal_id = ? AND kind = ?",
      goalId,
      kind,
    );
    return row ? mapArtifact(row) : undefined;
  }

  nextAction(goalId: string): NextAction {
    this.ensureOpen();
    const goal = this.requireGoal(goalId);

    if (goal.status === "waiting_for_merge") {
      const pullRequest = this.getOpenPullRequest(goalId);
      if (pullRequest) {
        return { type: "wait_for_merge", pullRequestId: pullRequest.id };
      }
    }

    return { type: "continue" };
  }

  recordPullRequestMerged(
    pullRequestId: string,
    input: PullRequestMergeInput,
  ): PullRequestRecord {
    return this.atomically(() => {
      this.ensureOpen();
      const pullRequest = this.requirePullRequest(pullRequestId);
      this.assertText(input.mergedAt, "mergedAt");
      this.assertText(input.mergeCommit, "mergeCommit");

      this.db.run(
        `UPDATE goal_prs
         SET status = 'merged', merged_at = ?, merge_commit = ?, updated_at = ?
         WHERE id = ?`,
        input.mergedAt,
        input.mergeCommit,
        input.mergedAt,
        pullRequestId,
      );

      const goal = this.requireGoal(pullRequest.goalId);
      if (!isTerminalGoalStatus(goal.status)) {
        const nextOpenPullRequest = this.nextOpenPullRequest(pullRequest.goalId);
        const nextStatus =
          goal.status === "waiting_for_merge"
            ? nextOpenPullRequest
              ? "waiting_for_merge"
              : "active"
            : goal.status;

        this.db.run(
          "UPDATE goals SET status = ?, updated_at = ? WHERE id = ?",
          nextStatus,
          input.mergedAt,
          pullRequest.goalId,
        );
        this.insertEvent(pullRequest.goalId, "goal.merge_detected", "Pull request merged externally", {
          pullRequestId,
          mergeCommit: input.mergeCommit,
          nextOpenPullRequestId: nextOpenPullRequest ? readText(nextOpenPullRequest, "id") : undefined,
        }, input.mergedAt);
      }

      return this.requirePullRequest(pullRequestId);
    });
  }

  private nextOpenPullRequest(goalId: string): Row | undefined {
    return this.db.get(
          `SELECT id FROM goal_prs
           WHERE goal_id = ? AND status = 'open'
           ORDER BY created_at ASC
           LIMIT 1`,
      goalId,
    );
  }

  transaction<T>(operation: () => T): T {
    this.ensureOpen();
    if (this.inTransaction) {
      throw new Error("Nested goal store transactions are not supported.");
    }

    this.db.exec("BEGIN IMMEDIATE;");
    this.inTransaction = true;
    try {
      const result = operation();
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
        throw new Error("Goal store transactions must be synchronous.");
      }
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  listPhases(goalId: string): PhaseRecord[] {
    this.ensureOpen();
    return this.db
      .all("SELECT * FROM goal_phases WHERE goal_id = ? ORDER BY created_at ASC", goalId)
      .map(mapPhase);
  }

  listWorktrees(goalId: string): WorktreeRecord[] {
    this.ensureOpen();
    return this.db
      .all("SELECT * FROM goal_worktrees WHERE goal_id = ? ORDER BY created_at ASC", goalId)
      .map(mapWorktree);
  }

  close(): void {
    if (this.isClosed) return;
    this.db.close();
    this.isClosed = true;
  }

  private insertEvent(
    goalId: string,
    type: string,
    message: string,
    data: unknown,
    createdAt: string,
  ): void {
    const sequenceRow = this.db.get("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM goal_events");
    const sequence =
      typeof sequenceRow?.next_sequence === "number" ? sequenceRow.next_sequence : 1;
    this.db.run(
      `INSERT INTO goal_events (id, goal_id, type, message, data, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      createRecordId("event"),
      goalId,
      type,
      message,
      encodeJson(data),
      createdAt,
      sequence,
    );
  }

  private touchGoal(goalId: string, updatedAt: string): void {
    this.db.run("UPDATE goals SET updated_at = ? WHERE id = ?", updatedAt, goalId);
  }

  private atomically<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    return this.transaction(operation);
  }

  private requireGoal(goalId: string): GoalRecord {
    const goal = this.getGoal(goalId);
    if (!goal) {
      throw new Error(`Goal ${goalId} not found.`);
    }
    return goal;
  }

  private requirePhase(goalId: string, phaseId: string): PhaseRecord {
    this.assertText(phaseId, "phaseId");
    const row = this.db.get(
      "SELECT * FROM goal_phases WHERE id = ? AND goal_id = ?",
      phaseId,
      goalId,
    );
    if (!row) {
      throw new Error(`Phase ${phaseId} does not belong to goal ${goalId}.`);
    }
    return mapPhase(row);
  }

  private requireWorktree(
    goalId: string,
    phaseId: string,
    worktreeId: string,
  ): WorktreeRecord {
    this.assertText(worktreeId, "worktreeId");
    const row = this.db.get(
      "SELECT * FROM goal_worktrees WHERE id = ? AND goal_id = ? AND phase_id = ?",
      worktreeId,
      goalId,
      phaseId,
    );
    if (!row) {
      throw new Error(`Worktree ${worktreeId} does not belong to phase ${phaseId}.`);
    }
    return mapWorktree(row);
  }

  private requirePullRequest(pullRequestId: string): PullRequestRecord {
    const pullRequest = this.getPullRequest(pullRequestId);
    if (!pullRequest) {
      throw new Error(`Pull request ${pullRequestId} not found.`);
    }
    return pullRequest;
  }

  private ensureOpen(): void {
    if (this.isClosed) {
      throw new Error("Goal store is closed.");
    }
  }

  private assertText(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid ${field}.`);
    }
  }
}
