import { hasHealthyManagedMarkdownMarkers, removeMarkdownSection } from "./filemerge.js";
import { isContainedIn } from "./fsx.js";
import fs from "node:fs";
import path from "node:path";

export const SYSTEM_PROMPT_SECTIONS = [
  "system-prompt", "engram-protocol", "context7", "playwright", "chrome-devtools", "browser", "writing-style",
] as const;

export type SystemPromptSections = Partial<Record<typeof SYSTEM_PROMPT_SECTIONS[number], string>>;

/** La migración no puede atribuir contenido a marcadores rotos o anidados. */
export function assertSystemPromptMarkers(content: string | null, target: string): void {
  if (content === null) return;
  const ranges: { section: string; start: number; end: number }[] = [];
  for (const section of SYSTEM_PROMPT_SECTIONS) {
    const markers = [...content.matchAll(new RegExp(`<!--\\s*\\/?jorgex:${section}(?=[\\s>]|-->|$)`, "g"))];
    if (markers.length === 0) continue;
    if (markers.length !== 2 || !hasHealthyManagedMarkdownMarkers(content, section)) {
      throw new Error(`Marcadores jorgex:${section} ambiguos en ${target}. Repara el bloque antes de reintentar; su contenido se conserva.`);
    }
    ranges.push({
      section,
      start: content.indexOf(`<!-- jorgex:${section} -->`),
      end: content.indexOf(`<!-- /jorgex:${section} -->`) + `<!-- /jorgex:${section} -->`.length,
    });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]!.start < ranges[index - 1]!.end) {
      throw new Error(`Marcadores jorgex:${ranges[index]!.section} anidados en ${target}. Separa los bloques antes de reintentar; su contenido se conserva.`);
    }
  }
}

/** Un error de lectura no equivale a un prompt ausente que se pueda reemplazar. */
export function readSystemPromptFile(target: string, rootDir?: string): string | null {
  if (rootDir !== undefined) {
    const probe = fs.existsSync(target) ? target : path.dirname(target);
    if (fs.existsSync(probe) && fs.existsSync(rootDir)) {
      const resolved = fs.realpathSync(probe);
      const root = fs.realpathSync(rootDir);
      if (resolved !== root && !isContainedIn(resolved, root)) {
        throw new Error(`El prompt ${target} sale del destino aislado.`);
      }
    }
  }
  let bytes: Buffer;
  try { bytes = fs.readFileSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`No se puede leer el prompt ${target}. Revisa los permisos y el tipo de archivo.`, { cause: error });
  }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) { throw new Error(`El prompt ${target} debe usar UTF-8 válido.`, { cause: error }); }
}

export function assertSystemPromptFile(target: string, rootDir?: string): void {
  assertSystemPromptMarkers(readSystemPromptFile(target, rootDir), target);
}

export function removeSystemPromptSections(content: string): string {
  assertSystemPromptMarkers(content, "system prompt");
  return SYSTEM_PROMPT_SECTIONS.reduce((current, section) => removeMarkdownSection(current, section), content);
}
