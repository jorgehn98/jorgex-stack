import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import type { CanonicalHooks } from "../lib/canonical.js";

export function planHooks(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const raw = fs.readFileSync(path.join(ctx.stackDir, "hooks", "hooks.json"), "utf8");
  const canonical = JSON.parse(raw) as CanonicalHooks;
  return adapter.planHooks(canonical, ctx);
}
