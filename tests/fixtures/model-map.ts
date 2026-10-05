import type { RuntimeId } from "../../src/adapters/types.js";
import type { AgentModelChoices } from "../../src/lib/agent-model.js";

export const OPEN_CODE_TEST_MODELS: AgentModelChoices = {};
export const TEST_MODEL_MAP: Record<RuntimeId, AgentModelChoices> = {
  "claude-code": {}, codex: {}, opencode: {}, pi: {},
};
export function testModelsForRuntime(runtime: RuntimeId): AgentModelChoices {
  return TEST_MODEL_MAP[runtime];
}
