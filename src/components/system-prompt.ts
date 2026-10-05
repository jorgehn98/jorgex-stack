import path from "node:path";
import fs from "node:fs";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../adapters/types.js";
import { LEGACY_SYSTEM_PROMPT_SECTIONS } from "../adapters/types.js";
import { removeMarkdownSection, stripLeadingHtmlComments, upsertMarkdownSection } from "../lib/filemerge.js";
import { assertSystemPromptMarkers, readSystemPromptFile, SYSTEM_PROMPT_SECTIONS, type SystemPromptSections } from "../lib/system-prompt-sections.js";

const normalize = (s: string): string => s.replace(/\r\n/g, "\n");

/**
 * Proyecta la política y las capacidades en secciones gestionadas, adaptándolas
 * cuando el runtime requiere un formato legado.
 * Lo que el usuario tenga fuera de los marcadores se preserva.
 */
export function planSystemPrompt(adapter: SharedProjectionAdapter, ctx: InstallContext): FileAction[] {
  const paths = adapter.paths(ctx.configDir);
  const target = paths.sharedPromptFile ?? paths.systemPromptFile;
  const existing = readSystemPromptFile(target);
  assertSystemPromptMarkers(existing, target);
  const readModule = (file: string): string => stripLeadingHtmlComments(
    normalize(fs.readFileSync(path.join(ctx.stackDir, "system-prompt", file), "utf8")),
  );
  const modules: SystemPromptSections = {
    "system-prompt": readModule("AGENTS.md"),
    context7: readModule("context7.md"),
    browser: readModule("browser-use.md"),
    "writing-style": ctx.writingStyle?.content ?? undefined,
  };
  const sections = adapter.adaptSystemPromptSections?.(modules) ?? modules;
  let content = existing ?? "";
  for (const section of SYSTEM_PROMPT_SECTIONS) {
    const body = sections[section];
    content = body ? upsertMarkdownSection(content, section, body) : removeMarkdownSection(content, section);
  }
  // Las secciones retiradas ya no se inyectan; los bloques que
  // versiones anteriores instalaron se eliminan idempotentemente aquí (y en
  // uninstall vía removeSystemPromptSections).
  for (const section of LEGACY_SYSTEM_PROMPT_SECTIONS) {
    content = removeMarkdownSection(content, section);
  }
  const actions: FileAction[] = [{ kind: "write", target, content }];
  if (paths.sharedPromptFile) {
    let bridge = readSystemPromptFile(paths.systemPromptFile) ?? "";
    assertSystemPromptMarkers(bridge, paths.systemPromptFile);
    for (const section of [...SYSTEM_PROMPT_SECTIONS, ...LEGACY_SYSTEM_PROMPT_SECTIONS]) bridge = removeMarkdownSection(bridge, section);
    bridge = upsertMarkdownSection(bridge, "system-prompt", `@${path.relative(path.dirname(paths.systemPromptFile), paths.sharedPromptFile).replace(/\\/g, "/").replace(/ /g, "\\ ")}`);
    actions.push({ kind: "write", target: paths.systemPromptFile, content: bridge });
  }
  return actions;
}
