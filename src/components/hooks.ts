import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalHooks } from "../lib/canonical.js";

export function planHooks(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return adapter.planHooks(loadCanonicalHooks(ctx.stackDir), ctx);
}
