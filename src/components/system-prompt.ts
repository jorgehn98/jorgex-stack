import path from "node:path";
import fs from "node:fs";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../adapters/types.js";
import { DEVTOOLS_MCP_SERVER } from "../lib/canonical.js";
import { removeMarkdownSection, stripLeadingHtmlComments, upsertMarkdownSection } from "../lib/filemerge.js";
import { composeProgrammaticSystemPrompt } from "../lib/mode-composition.js";
import { assertSystemPromptMarkers, readSystemPromptFile, SYSTEM_PROMPT_SECTIONS, type SystemPromptSections } from "../lib/system-prompt-sections.js";

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

/**
 * Proyecta la política y cada capacidad como secciones gestionadas independientes.
 * Lo que el usuario tenga fuera de los marcadores se preserva.
 */
export function planSystemPrompt(adapter: SharedProjectionAdapter, ctx: InstallContext): FileAction[] {
  const target = adapter.paths(ctx.configDir).systemPromptFile;
  const existing = readSystemPromptFile(target);
  assertSystemPromptMarkers(existing, target);
  const readModule = (file: string): string => stripLeadingHtmlComments(
    normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", file), "utf8")),
  );
  const modules: SystemPromptSections = {
    "system-prompt": composeProgrammaticSystemPrompt(ctx.stackDir, readModule("AGENTS.md"), ctx.mode),
    "engram-protocol": adapter.injectEngramProtocol(ctx) ? readModule("engram-protocol.md") : undefined,
    context7: readModule("context7.md"),
    playwright: ctx.playwrightCliEnabled ? readModule("browser-playwright.md") : undefined,
    "chrome-devtools": ctx.enabledMcpServers?.has(DEVTOOLS_MCP_SERVER) ? readModule("browser-chrome-devtools.md") : undefined,
    "writing-style": ctx.mode === "programmatic" ? undefined : ctx.writingStyle?.content ?? undefined,
  };
  const sections = adapter.adaptSystemPromptSections?.(modules) ?? modules;
  let content = existing ?? "";
  for (const section of SYSTEM_PROMPT_SECTIONS) {
    const body = sections[section];
    content = body ? upsertMarkdownSection(content, section, body) : removeMarkdownSection(content, section);
  }
  return [{ kind: "write", target, content }];
}
