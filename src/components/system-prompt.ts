import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { readTextIfExists } from "../lib/fsx.js";
import { stripLeadingHtmlComments, upsertMarkdownSection } from "../lib/filemerge.js";

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

/**
 * Inyecta el system prompt global y el protocolo Engram como dos secciones
 * marcadas en el archivo del runtime (CLAUDE.md / AGENTS.md). Lo que el
 * usuario tenga fuera de los marcadores se preserva.
 */
export function planSystemPrompt(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const target = adapter.paths(ctx.configDir).systemPromptFile;
  const agentsMd = normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", "AGENTS.md"), "utf8"));
  const protocol = stripLeadingHtmlComments(
    normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", "engram-protocol.md"), "utf8")),
  );

  let content = readTextIfExists(target);
  content = upsertMarkdownSection(content, "system-prompt", agentsMd);
  content = upsertMarkdownSection(content, "engram-protocol", protocol);
  return [{ kind: "write", target, content }];
}
