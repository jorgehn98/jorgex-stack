import type { RuntimeId } from "../../src/adapters/types.js";
import { DEFAULT_MODEL_MAP, type RuntimeModelMap } from "../../src/lib/model-map.js";

export const OPEN_CODE_TEST_MODELS: RuntimeModelMap = {
  strong: { model: "provider/strong", variant: "high" },
  standard: { model: "provider/standard", variant: "medium" },
  cheap: { model: "provider/cheap" },
};

export function testModelsForRuntime(runtime: RuntimeId): RuntimeModelMap {
  return runtime === "opencode" ? OPEN_CODE_TEST_MODELS : DEFAULT_MODEL_MAP[runtime]!;
}
