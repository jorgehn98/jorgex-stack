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
    .map((f) => {
      const raw = fs.readFileSync(path.join(source, f), "utf8").replace(/\r\n/g, "\n");
      const rendered = adapter.renderCommand(f, raw);
      return { kind: "write", target: path.join(commandsDir, rendered.file), content: rendered.content };
    });
}
