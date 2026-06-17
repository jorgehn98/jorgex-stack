export const GOAL_STORE_SCHEMA_VERSION = 3 as const;

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "waiting_for_merge"
  | "budget_limited"
  | "failed"
  | "complete"
  | "cancelled";

export type PullRequestStatus = "open" | "merged" | "closed";
export type GoalArtifactKind = "prd" | "plan";

export interface GoalStoreOptions {
  databasePath: string;
  now?: () => string;
}

export interface GoalInput {
  objective: string;
  project: string;
}

export interface GoalTransitionInput {
  reason: string;
}

export interface GoalEventInput {
  type: string;
  message: string;
  data?: unknown;
}

export interface PhaseInput {
  name: string;
  objective: string;
  status: GoalStatus;
}

export interface WorktreeInput {
  phaseId: string;
  path: string;
  branch: string;
  status: GoalStatus;
}

export interface PullRequestInput {
  phaseId: string;
  worktreeId: string;
  number: number;
  url: string;
  branch: string;
  base: string;
  status: PullRequestStatus;
}

export interface PullRequestMergeInput {
  mergedAt: string;
  mergeCommit: string;
}

export interface GoalArtifactInput {
  kind: GoalArtifactKind;
  path: string;
}

export interface GoalRecord {
  id: string;
  project: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEventRecord {
  id: string;
  goalId: string;
  type: string;
  message: string;
  data?: unknown;
  createdAt: string;
  sequence: number;
}

export interface PhaseRecord {
  id: string;
  goalId: string;
  name: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeRecord {
  id: string;
  goalId: string;
  phaseId: string;
  path: string;
  branch: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestRecord {
  id: string;
  goalId: string;
  phaseId: string;
  worktreeId: string;
  number: number;
  url: string;
  branch: string;
  base: string;
  status: PullRequestStatus;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergeCommit?: string;
}

export interface GoalArtifactRecord {
  id: string;
  goalId: string;
  kind: GoalArtifactKind;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalStoreSnapshot {
  schemaVersion: number;
  nextEventSequence: number;
  goals: GoalRecord[];
  events: GoalEventRecord[];
  phases: PhaseRecord[];
  worktrees: WorktreeRecord[];
  pullRequests: PullRequestRecord[];
}

export interface NextActionWaitForMerge {
  type: "wait_for_merge";
  pullRequestId: string;
}

export interface NextActionContinue {
  type: "continue";
}

export type NextAction = NextActionWaitForMerge | NextActionContinue;

export interface GoalStore {
  migrate(): void;
  schemaVersion(): number;
  createGoal(input: GoalInput): GoalRecord;
  getGoal(goalId: string): GoalRecord | undefined;
  getActiveGoal(project: string): GoalRecord | undefined;
  getCurrentGoal(project: string): GoalRecord | undefined;
  getOpenPullRequest(goalId: string): PullRequestRecord | undefined;
  appendEvent(goalId: string, input: GoalEventInput): GoalEventRecord;
  listEvents(goalId: string): GoalEventRecord[];
  transitionGoal(
    goalId: string,
    status: GoalStatus,
    input: GoalTransitionInput,
  ): GoalRecord;
  addPhase(goalId: string, input: PhaseInput): PhaseRecord;
  addWorktree(goalId: string, input: WorktreeInput): WorktreeRecord;
  recordPullRequest(goalId: string, input: PullRequestInput): PullRequestRecord;
  getPullRequest(pullRequestId: string): PullRequestRecord | undefined;
  recordArtifact(goalId: string, input: GoalArtifactInput): GoalArtifactRecord;
  listArtifacts(goalId: string): GoalArtifactRecord[];
  getArtifact(goalId: string, kind: GoalArtifactKind): GoalArtifactRecord | undefined;
  nextAction(goalId: string): NextAction;
  recordPullRequestMerged(
    pullRequestId: string,
    input: PullRequestMergeInput,
  ): PullRequestRecord;
  transaction<T>(operation: () => T): T;
  listPhases(goalId: string): PhaseRecord[];
  listWorktrees(goalId: string): WorktreeRecord[];
  close(): void;
}
