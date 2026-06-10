import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalMcp } from "../lib/canonical.js";

export function planMcp(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return adapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx);
}
