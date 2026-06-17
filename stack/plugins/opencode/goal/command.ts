import type { GoalRecord, GoalStatus, GoalStore, NextAction } from "./types.js";

const COMMANDS = new Set(["status", "plan", "history", "pause", "resume", "cancel"]);
const EXPLICITLY_UNSUPPORTED = new Set(["quick", "work"]);

export interface GoalCommandHandlersOptions {
  store: GoalStore;
  project: string;
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
      const normalized = input.toLowerCase();

      if (input.length === 0) {
        throw new Error("Goal objective cannot be empty.");
      }

      if (EXPLICITLY_UNSUPPORTED.has(normalized)) {
        throw new Error("/goal quick and /goal work are not supported. Use /goal <objective> for large goals.");
      }

      if (!COMMANDS.has(normalized)) {
        const goal = options.store.createGoal({
          objective: input,
          project: options.project,
        });
        currentGoalId = goal.id;
        options.store.appendEvent(goal.id, {
          type: "goal.created",
          message: `Goal created: ${goal.objective}`,
          data: { objective: goal.objective, project: goal.project },
        });

        return {
          message: `Goal created: ${goal.objective}\nStatus: ${goal.status}\nNext action: ${formatNextAction(options.store.nextAction(goal.id))}`,
        };
      }

      if (normalized === "status") return statusResponse(currentGoal(), options.store);
      if (normalized === "plan") return planResponse(requireCurrentGoal());
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

function planResponse(goal: GoalRecord): GoalCommandResponse {
  return {
    message: [
      `Plan for goal: ${goal.objective}`,
      "Phases: master PRD/plan generation, slice execution, PR review, waiting for merge, final verification.",
      "Detailed master artifacts are created by the next Goal Mode slice.",
    ].join("\n"),
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
