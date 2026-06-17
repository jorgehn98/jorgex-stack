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
}

export interface OpenCodeGoalHooksDeps {
  store: GoalStore;
  project: string;
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
      appendHookText(output, response.message);
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
      if (event.type !== "session.idle" && event.type !== "session.status") return;

      const decision = supervisor.decide();
      if (!decision || decision.type === "pause_for_merge") return;
      if (decision.state.goal.status !== "active") return;
      if (!deps.sessionClient?.promptAsync) return;

      try {
        await deps.sessionClient.promptAsync({
          sessionID: extractSessionID(event.properties),
          prompt: supervisor.renderContinuationPrompt(decision.state.goal.id) ?? "",
        });
      } catch (error) {
        deps.logger?.warn?.("Goal Mode auto-continue failed", error);
      }
    },
  };
}

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

function appendHookText(output: HookOutput, text: string): void {
  if (typeof output.message === "string") {
    output.message = output.message ? `${output.message}\n\n${text}` : text;
    return;
  }
  if (typeof output.output === "string") {
    output.output = output.output ? `${output.output}\n\n${text}` : text;
    return;
  }
  if (Array.isArray(output.content)) {
    output.content.push({ type: "text", text });
    return;
  }
  output.message = text;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
