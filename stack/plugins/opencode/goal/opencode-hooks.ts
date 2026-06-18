import { randomUUID } from "node:crypto";
import type { GoalStore } from "./types.js";
import { createGoalCommandHandlers } from "./command.js";
import {
  GOAL_MODE_MARKER_END,
  GOAL_MODE_MARKER_START,
  createGoalSupervisor,
} from "./supervisor.js";

type HookOutput = Record<string, unknown>;

interface GoalSessionClient {
  promptAsync?: (input: { prompt: string; sessionID?: string }) => Promise<unknown> | unknown;
}

interface GoalLogger {
  warn?: (message: string, details?: unknown) => void;
  error?: (message: string, details?: unknown) => void;
}

export interface OpenCodeGoalHooksDeps {
  store: GoalStore;
  project: string;
  artifactsRootDir?: string;
  sessionClient?: GoalSessionClient;
  logger?: GoalLogger;
}

export interface OpenCodeGoalHooks {
  event?: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  "command.execute.before"?: (input: unknown, output: HookOutput) => Promise<void>;
  "experimental.chat.system.transform"?: (input: unknown, output: { system: string[] }) => Promise<void>;
  "experimental.session.compacting"?: (input: { sessionID?: string }, output: { context: string[] }) => Promise<void>;
}

export function createOpenCodeGoalHooks(deps: OpenCodeGoalHooksDeps): OpenCodeGoalHooks {
  const commands = createGoalCommandHandlers({
    store: deps.store,
    project: deps.project,
    artifactsRootDir: deps.artifactsRootDir,
  });
  const supervisor = createGoalSupervisor({
    store: deps.store,
    project: deps.project,
  });

  return {
    "command.execute.before": async (input, output) => {
      const command = extractCommandName(input);
      if (command !== "goal") return;

      const response = commands.handleGoalCommand(extractCommandArguments(input));
      replaceGoalCommandPrompt(input, output, response.message);
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const block = supervisor.renderSystemContext();
      if (!block) return;

      if (output.system.length === 0) {
        output.system.push(block);
        return;
      }

      const lastIndex = output.system.length - 1;
      output.system[lastIndex] = upsertMarkedBlock(output.system[lastIndex]!, block);
    },

    "experimental.session.compacting": async (_input, output) => {
      const block = supervisor.renderSystemContext();
      if (!block) return;

      if (!output.context.some((entry) => entry.includes(GOAL_MODE_MARKER_START))) {
        output.context.push(block);
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const decision = supervisor.decide();
      if (!decision || decision.type === "pause_for_merge") return;
      if (decision.state.goal.status !== "active") return;
      const sessionID = extractSessionID(event.properties);
      const stateSequence = latestNonAutoContinueSequence(decision.state.events);
      if (hasAutoContinueEventForState(decision.state.events, "goal.auto_continue_requested", stateSequence)) {
        if (!hasAutoContinueEventForState(decision.state.events, "goal.auto_continue_deduped", stateSequence)) {
          deps.store.appendEvent(decision.state.goal.id, {
            type: "goal.auto_continue_deduped",
            message: "Auto-continue skipped because this goal state already requested a continuation.",
            data: { sessionID, stateSequence },
          });
        }
        return;
      }
      if (!deps.sessionClient?.promptAsync) {
        if (!hasAutoContinueEventForState(decision.state.events, "goal.auto_continue_unavailable", stateSequence)) {
          deps.store.appendEvent(decision.state.goal.id, {
            type: "goal.auto_continue_unavailable",
            message: "Auto-continue unavailable: session prompt client missing.",
            data: { sessionID, stateSequence },
          });
          deps.logger?.warn?.("Goal Mode auto-continue unavailable", {
            goalId: decision.state.goal.id,
            sessionID,
            stateSequence,
          });
        }
        return;
      }
      const prompt = supervisor.renderContinuationPrompt(decision.state.goal.id);
      if (!prompt?.trim()) {
        deps.store.appendEvent(decision.state.goal.id, {
          type: "goal.auto_continue_skipped",
          message: "Auto-continue skipped because the continuation prompt was empty.",
        });
        return;
      }
      const dedupeKey = `${decision.state.goal.id}:${sessionID ?? "unknown"}:${stateSequence}`;
      if (autoContinueInFlight.has(dedupeKey)) {
        deps.store.appendEvent(decision.state.goal.id, {
          type: "goal.auto_continue_deduped",
          message: "Auto-continue skipped because a continuation is already in flight.",
          data: { sessionID, stateSequence },
        });
        return;
      }
      autoContinueInFlight.add(dedupeKey);

      try {
        deps.store.appendEvent(decision.state.goal.id, {
          type: "goal.auto_continue_requested",
          message: `Auto-continue requested for session ${sessionID ?? "unknown"}.`,
          data: { sessionID, stateSequence },
        });
        await deps.sessionClient.promptAsync({
          sessionID,
          prompt,
        });
      } catch (error) {
        deps.store.appendEvent(decision.state.goal.id, {
          type: "goal.auto_continue_failed",
          message: `Auto-continue failed for session ${sessionID ?? "unknown"}.`,
          data: { error: error instanceof Error ? error.message : String(error), sessionID, stateSequence },
        });
        deps.logger?.error?.("Goal Mode auto-continue failed", error);
      } finally {
        autoContinueInFlight.delete(dedupeKey);
      }
    },
  };
}

const autoContinueInFlight = new Set<string>();

function extractCommandName(input: unknown): string {
  if (!isRecord(input)) return "";
  const command = input.command ?? input.name;
  return typeof command === "string" ? command.trim().toLowerCase() : "";
}

function extractCommandArguments(input: unknown): string {
  if (!isRecord(input)) return "";
  const direct = input.arguments ?? input.argument ?? input.input;
  if (typeof direct === "string") return direct;
  const args = input.args;
  if (!isRecord(args)) return "";
  const nested = args.arguments ?? args.argument ?? args.input;
  return typeof nested === "string" ? nested : "";
}

function replaceGoalCommandPrompt(input: unknown, output: HookOutput, text: string): void {
  const prompt = renderGoalCommandPrompt(input, text);

  if (Array.isArray(output.parts)) {
    output.parts.splice(0, output.parts.length, {
      id: createOpenCodeID("prt"),
      sessionID: extractHookSessionID(input, output),
      messageID: extractHookMessageID(input, output),
      type: "text",
      text: prompt,
      synthetic: true,
    });
    return;
  }
  if (typeof output.message === "string") {
    output.message = output.message ? `${output.message}\n\n${prompt}` : prompt;
    return;
  }
  if (typeof output.output === "string") {
    output.output = output.output ? `${output.output}\n\n${prompt}` : prompt;
    return;
  }
  if (Array.isArray(output.content)) {
    output.content.push({ type: "text", text: prompt });
    return;
  }
  throw new Error("Unsupported OpenCode command output contract for Goal Mode.");
}

function renderGoalCommandPrompt(input: unknown, commandResult: string): string {
  const args = extractCommandArguments(input).trim();
  const firstToken = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const isControlCommand = new Set(["status", "plan", "history", "pause", "resume", "cancel", "merged"]).has(firstToken);

  return [
    "Goal Mode command result (authoritative):",
    commandResult,
    "",
    "Instructions:",
    isControlCommand
      ? "Reply with the Goal Mode command result only. Do not inspect files, run tools, continue implementation, create branches, open PRs, or change repository state."
      : "A persistent Goal Mode objective has been created. Acknowledge the created goal, then continue only according to the injected Goal Mode context and the project work-lifecycle rules.",
  ].join("\n");
}

function extractHookSessionID(input: unknown, output: HookOutput): string {
  const inputRecord = isRecord(input) ? input : undefined;
  const outputRecord = output;
  const direct = inputRecord?.sessionID ?? inputRecord?.sessionId ?? outputRecord.sessionID ?? outputRecord.sessionId;
  if (typeof direct === "string" && direct.trim()) return direct;

  const message = outputRecord.message ?? outputRecord.info;
  if (isRecord(message)) {
    const sessionID = message.sessionID ?? message.sessionId;
    if (typeof sessionID === "string" && sessionID.trim()) return sessionID;
  }

  return createOpenCodeID("ses");
}

function extractHookMessageID(input: unknown, output: HookOutput): string {
  const inputRecord = isRecord(input) ? input : undefined;
  const outputRecord = output;
  const direct = inputRecord?.messageID ?? inputRecord?.messageId ?? outputRecord.messageID ?? outputRecord.messageId;
  if (typeof direct === "string" && direct.trim()) return direct;

  const message = outputRecord.message ?? outputRecord.info;
  if (isRecord(message)) {
    const id = message.id ?? message.messageID ?? message.messageId;
    if (typeof id === "string" && id.trim()) return id;
  }

  return createOpenCodeID("msg");
}

function upsertMarkedBlock(text: string, block: string): string {
  const start = text.indexOf(GOAL_MODE_MARKER_START);
  const end = text.indexOf(GOAL_MODE_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${text.slice(0, start).trimEnd()}\n\n${block}${text.slice(end + GOAL_MODE_MARKER_END.length)}`;
  }
  return `${text.trimEnd()}\n\n${block}`;
}

function extractSessionID(properties: unknown): string | undefined {
  if (!isRecord(properties)) return undefined;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  if (isRecord(info) && typeof info.id === "string") return info.id;
  return undefined;
}

const AUTO_CONTINUE_EVENT_PREFIX = "goal.auto_continue_";

function latestNonAutoContinueSequence(events: Array<{ type: string; sequence: number }>): number {
  return Math.max(
    0,
    ...events
      .filter((event) => !event.type.startsWith(AUTO_CONTINUE_EVENT_PREFIX))
      .map((event) => event.sequence),
  );
}

function hasAutoContinueEventForState(
  events: Array<{ type: string; data?: unknown }>,
  type: string,
  stateSequence: number,
): boolean {
  return events.some((event) => event.type === type && readEventStateSequence(event.data) === stateSequence);
}

function readEventStateSequence(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  return typeof data.stateSequence === "number" ? data.stateSequence : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// OpenCode validates entity IDs by prefix (parts: "prt", sessions: "ses", messages: "msg").
// A synthetic part injected with a "part_" id is rejected with: Expected a string starting with "prt".
function createOpenCodeID(prefix: "prt" | "ses" | "msg"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
