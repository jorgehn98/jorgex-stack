import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";

export function planCommands(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { commandsDir } = adapter.paths(ctx.configDir);
  const source = path.join(ctx.stackDir, "commands");
  if (!fs.existsSync(source)) return [];

  const commandFiles = [
    ...listMarkdownFiles(source),
    ...listMarkdownFiles(path.join(source, adapter.id)),
  ];

  return commandFiles.map(({ file, fullPath }): FileAction => {
    const raw = fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
    const rendered = adapter.renderCommand(file, raw);
    return { kind: "write", target: path.join(commandsDir, rendered.file), content: rendered.content };
  });
}

function listMarkdownFiles(dir: string): { file: string; fullPath: string }[] {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({ file: entry.name, fullPath: path.join(dir, entry.name) }));
}
