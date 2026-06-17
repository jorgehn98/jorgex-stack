import fs from "node:fs";
import path from "node:path";
import type { GoalRecord, GoalStatus, GoalStore, NextAction } from "./types.js";
import { assertSafeArtifactPath, createMasterArtifacts } from "./artifacts.js";

const COMMANDS = new Set(["status", "plan", "history", "pause", "resume", "cancel", "merged"]);
const EXPLICITLY_UNSUPPORTED = new Set(["quick", "work"]);

export interface GoalCommandHandlersOptions {
  store: GoalStore;
  project: string;
  artifactsRootDir?: string;
}

export interface GoalCommandResponse {
  message: string;
}

export interface GoalCommandHandlers {
  handleGoalCommand(input: string): GoalCommandResponse;
}

export function createGoalCommandHandlers(options: GoalCommandHandlersOptions): GoalCommandHandlers {
  let currentGoalId: string | undefined;

  const currentGoal = () => {
    const byId = currentGoalId ? options.store.getGoal(currentGoalId) : undefined;
    const active = byId ?? options.store.getCurrentGoal(options.project);
    currentGoalId = active?.id ?? currentGoalId;
    return active;
  };

  const requireCurrentGoal = () => {
    const goal = currentGoal();
    if (!goal) {
      throw new Error("No active goal found. Start one with /goal <objective>.");
    }
    return goal;
  };

  return {
    handleGoalCommand(rawInput: string): GoalCommandResponse {
      const input = rawInput.trim();
      const [firstToken = "", ...args] = input.split(/\s+/);
      const firstLower = firstToken.toLowerCase();
      const normalized = firstLower === "merged" ? "merged" : input.toLowerCase();

      if (input.length === 0) {
        throw new Error("Goal objective cannot be empty.");
      }

      if (EXPLICITLY_UNSUPPORTED.has(normalized)) {
        throw new Error("/goal quick and /goal work are not supported. Use /goal <objective> for large goals.");
      }

      if (!COMMANDS.has(normalized)) {
        let artifactRootDir: string | undefined;
        const goal = options.store.transaction(() => {
          const createdGoal = options.store.createGoal({
            objective: input,
            project: options.project,
          });
          artifactRootDir = options.artifactsRootDir
            ? path.join(options.artifactsRootDir, createdGoal.id)
            : undefined;
          try {
            if (artifactRootDir) {
              createMasterArtifacts({
                store: options.store,
                goalId: createdGoal.id,
                rootDir: artifactRootDir,
                allowedRootDir: options.artifactsRootDir,
              });
            }
            options.store.appendEvent(createdGoal.id, {
              type: "goal.created",
              message: `Goal created: ${createdGoal.objective}`,
              data: { objective: createdGoal.objective, project: createdGoal.project },
            });
          } catch (error) {
            if (artifactRootDir && options.artifactsRootDir) {
              cleanupBootstrappedArtifactDir(artifactRootDir, options.artifactsRootDir);
            }
            throw new Error(`Goal bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return createdGoal;
        });
        currentGoalId = goal.id;

        return {
          message: `Goal created: ${goal.objective}\nStatus: ${goal.status}\nNext action: ${formatNextAction(options.store.nextAction(goal.id))}`,
        };
      }

      if (normalized === "status") return statusResponse(currentGoal(), options.store);
      if (normalized === "plan") {
        return planResponse(requireCurrentGoal(), options.store, options.artifactsRootDir);
      }
      if (normalized === "history") return historyResponse(requireCurrentGoal(), options.store);

      const goal = requireCurrentGoal();
      if (normalized === "pause") {
        return transitionResponse(options.store, goal, "paused", "Goal paused by user.");
      }
      if (normalized === "resume") {
        if (goal.status === "waiting_for_merge") {
          throw new Error("Cannot resume while the goal is waiting for an external PR merge.");
        }

        const nextStatus = options.store.getOpenPullRequest(goal.id) ? "waiting_for_merge" : "active";
        return transitionResponse(options.store, goal, nextStatus, "Goal resumed by user.");
      }
      if (normalized === "cancel") {
        return transitionResponse(options.store, goal, "cancelled", "Goal cancelled by user.");
      }
      if (normalized === "merged") {
        return mergedResponse(options.store, goal, args.join(" "));
      }

      throw new Error(`Unsupported /goal command: ${input}`);
    },
  };
}

function statusResponse(goal: GoalRecord | undefined, store: GoalStore): GoalCommandResponse {
  if (!goal) {
    return { message: "No active goal. Start one with /goal <objective>." };
  }

  return {
    message: [
      `Goal: ${goal.objective}`,
      `Status: ${goal.status}`,
      `Next action: ${formatNextAction(store.nextAction(goal.id))}`,
    ].join("\n"),
  };
}

function planResponse(goal: GoalRecord, store: GoalStore, artifactsRootDir: string | undefined): GoalCommandResponse {
  const plan = store.getArtifact(goal.id, "plan");
  if (plan) {
    if (!fs.existsSync(plan.path)) {
      throw new Error(`Registered goal plan is not readable at ${plan.path}. Recreate or fix the artifact path.`);
    }
    if (artifactsRootDir) {
      assertSafeArtifactPath(plan.path, artifactsRootDir, "Registered goal plan");
    }
    return {
      message: [`Plan for goal: ${goal.objective}`, fs.readFileSync(plan.path, "utf8")].join("\n\n"),
    };
  }

  if (artifactsRootDir) {
    throw new Error("Goal master plan artifact is not registered. Recreate or repair the goal artifacts.");
  }

  return {
    message: [
      `Plan for goal: ${goal.objective}`,
      "Phases: master PRD/plan generation, slice execution, PR review, waiting for merge, final verification.",
      "Detailed master artifacts are created by the next Goal Mode slice.",
    ].join("\n"),
  };
}

function cleanupBootstrappedArtifactDir(rootDir: string, allowedRootDir: string): void {
  try {
    assertSafeArtifactPath(rootDir, allowedRootDir, "Goal artifact cleanup path");
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    // Preserve the original bootstrap error; unsafe cleanup paths are intentionally left untouched.
  }
}

function mergedResponse(store: GoalStore, goal: GoalRecord, mergeCommit: string): GoalCommandResponse {
  const pullRequest = store.getOpenPullRequest(goal.id);
  if (!pullRequest) {
    throw new Error("No open pull request is waiting for merge.");
  }

  const merged = store.recordPullRequestMerged(pullRequest.id, {
    mergedAt: new Date().toISOString(),
    mergeCommit: mergeCommit.trim() || "manual",
  });

  return {
    message: `Pull request #${merged.number} marked as merged. Goal status: ${store.getGoal(goal.id)?.status ?? "unknown"}`,
  };
}

function historyResponse(goal: GoalRecord, store: GoalStore): GoalCommandResponse {
  const events = store.listEvents(goal.id);
  const lines = events.length === 0
    ? ["No history events recorded yet."]
    : events.map((event) => `- ${event.createdAt} ${event.type}: ${event.message}`);

  return {
    message: [`History for goal: ${goal.objective}`, ...lines].join("\n"),
  };
}

function transitionResponse(
  store: GoalStore,
  goal: GoalRecord,
  status: GoalStatus,
  reason: string,
): GoalCommandResponse {
  const updated = store.transitionGoal(goal.id, status, { reason });
  return {
    message: `Goal ${updated.status}: ${updated.objective}`,
  };
}

function formatNextAction(action: NextAction): string {
  if (action.type === "wait_for_merge") {
    return `waiting for external merge of ${action.pullRequestId}`;
  }

  return "continue";
}
