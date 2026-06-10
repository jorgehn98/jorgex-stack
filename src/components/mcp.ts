import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import type { CanonicalMcp } from "../lib/canonical.js";

export function planMcp(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const raw = fs.readFileSync(path.join(ctx.stackDir, "mcp", "servers.json"), "utf8");
  const canonical = JSON.parse(raw) as CanonicalMcp;
  return adapter.planMainConfig(canonical, ctx);
}
