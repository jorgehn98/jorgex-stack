import type { RuntimeId } from "../../src/adapters/types.js";
import { DEFAULT_MODEL_MAP, type ModelMap, type RuntimeModelMap } from "../../src/lib/model-map.js";

export const OPEN_CODE_TEST_MODELS: RuntimeModelMap = {
  strong: { model: "provider/strong", variant: "high" },
  standard: { model: "provider/standard", variant: "medium" },
  cheap: { model: "provider/cheap" },
};

export const TEST_MODEL_MAP: ModelMap = {
  ...DEFAULT_MODEL_MAP,
  opencode: OPEN_CODE_TEST_MODELS,
};

export function testModelsForRuntime(runtime: RuntimeId): RuntimeModelMap {
  return runtime === "opencode" ? OPEN_CODE_TEST_MODELS : DEFAULT_MODEL_MAP[runtime]!;
}
