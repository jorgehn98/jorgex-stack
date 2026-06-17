import {
  GOAL_STORE_SCHEMA_VERSION,
  type GoalStatus,
  type GoalStoreSnapshot,
} from "./types.js";

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "waiting_for_merge",
  "budget_limited",
  "failed",
  "complete",
  "cancelled",
];

export const TERMINAL_GOAL_STATUSES = new Set<GoalStatus>([
  "failed",
  "complete",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: [
    "paused",
    "blocked",
    "waiting_for_merge",
    "budget_limited",
    "failed",
    "complete",
    "cancelled",
  ],
  paused: [
    "active",
    "blocked",
    "waiting_for_merge",
    "budget_limited",
    "failed",
    "cancelled",
  ],
  blocked: [
    "active",
    "paused",
    "waiting_for_merge",
    "budget_limited",
    "failed",
    "complete",
    "cancelled",
  ],
  waiting_for_merge: ["active", "blocked", "budget_limited", "failed", "cancelled"],
  budget_limited: ["active", "blocked", "waiting_for_merge", "failed", "cancelled"],
  failed: [],
  complete: [],
  cancelled: [],
};

export function createEmptyGoalStoreSnapshot(): GoalStoreSnapshot {
  return {
    schemaVersion: GOAL_STORE_SCHEMA_VERSION,
    nextEventSequence: 1,
    goals: [],
    events: [],
    phases: [],
    worktrees: [],
    pullRequests: [],
  };
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (from === to) return;

  if (isTerminalGoalStatus(from)) {
    throw new Error(`Cannot transition terminal goal from ${from} to ${to}.`);
  }

  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid transition from ${from} to ${to}.`);
  }
}
