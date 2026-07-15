import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { DEVTOOLS_MCP_SERVER } from "../lib/canonical.js";
import { readTextIfExists } from "../lib/fsx.js";
import { removeMarkdownSection, stripLeadingHtmlComments, upsertMarkdownSection } from "../lib/filemerge.js";
import { composeProgrammaticSystemPrompt } from "../lib/mode-composition.js";

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

/**
 * Inyecta el system prompt global, el protocolo Engram y la guía de navegador
 * como secciones marcadas en el archivo del runtime (CLAUDE.md / AGENTS.md).
 * Lo que el usuario tenga fuera de los marcadores se preserva.
 */
export function planSystemPrompt(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const target = adapter.paths(ctx.configDir).systemPromptFile;
  const agentsMd = normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", "AGENTS.md"), "utf8"));
  const protocol = stripLeadingHtmlComments(
    normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", "engram-protocol.md"), "utf8")),
  );
  const composedAgentsMd = composeProgrammaticSystemPrompt(ctx.stackDir, agentsMd, ctx.mode);
  const browser = [
    ctx.playwrightCliEnabled ? "browser-playwright.md" : null,
    ctx.enabledMcpServers?.has(DEVTOOLS_MCP_SERVER) ? "browser-chrome-devtools.md" : null,
  ]
    .filter((file): file is string => file !== null)
    .map((file) => normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", file), "utf8")))
    .join("\n\n");

  let content = readTextIfExists(target);
  content = upsertMarkdownSection(content, "system-prompt", composedAgentsMd);
  if (adapter.injectEngramProtocol(ctx)) {
    content = upsertMarkdownSection(content, "engram-protocol", protocol);
  } else {
    // La integración oficial de Engram del runtime ya inyecta el protocolo:
    // se retira la sección si quedó de una instalación anterior.
    content = removeMarkdownSection(content, "engram-protocol");
  }
  content = browser === ""
    ? removeMarkdownSection(content, "browser")
    : upsertMarkdownSection(content, "browser", browser);
  return [{ kind: "write", target, content }];
}
