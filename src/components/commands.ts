import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";

export function planCommands(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { commandsDir } = adapter.paths(ctx.configDir);
  const source = path.join(ctx.stackDir, "commands");
  if (!fs.existsSync(source)) return [];
  return fs
    .readdirSync(source)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ kind: "copy", source: path.join(source, f), target: path.join(commandsDir, f) }));
}
