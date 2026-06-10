/**
 * Merge idempotente (PRD D3): secciones marcadas en markdown y upsert
 * quirúrgico en JSON. Re-aplicar dos veces produce exactamente el mismo
 * resultado; el contenido del usuario fuera de lo gestionado se preserva.
 */

function markers(name: string): { open: string; close: string } {
  return { open: `<!-- jorgex:${name} -->`, close: `<!-- /jorgex:${name} -->` };
}

export function upsertMarkdownSection(existing: string | null, name: string, content: string): string {
  const { open, close } = markers(name);
  const block = `${open}\n${content.trim()}\n${close}`;
  if (existing === null || existing.trim() === "") return block + "\n";

  const start = existing.indexOf(open);
  const end = existing.indexOf(close);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + close.length);
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}

/** Quita comentarios HTML iniciales (notas meta de los archivos canónicos). */
export function stripLeadingHtmlComments(md: string): string {
  let out = md.trimStart();
  while (out.startsWith("<!--")) {
    const end = out.indexOf("-->");
    if (end === -1) break;
    out = out.slice(end + 3).trimStart();
  }
  return out;
}

/**
 * Upsert sobre un archivo JSON: parsea (u objeto vacío), aplica la mutación
 * solo sobre las claves gestionadas y re-serializa con indentación 2.
 * Limitación documentada: JSON puro (los comentarios JSONC se perderían).
 */
export function upsertJson(existing: string | null, mutate: (root: Record<string, unknown>) => void): string {
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    root = JSON.parse(existing) as Record<string, unknown>;
  }
  mutate(root);
  return JSON.stringify(root, null, 2) + "\n";
}

/**
 * Upsert quirúrgico de UNA sección TOML por texto (PRD D3): reemplaza desde el
 * header exacto `[section]` hasta el siguiente header (o EOF); si no existe,
 * la añade al final. Todo lo demás — otras secciones, comentarios, orden — se
 * preserva byte a byte. `body` son las líneas clave=valor SIN el header.
 */
export function upsertTomlSection(existing: string | null, section: string, body: string): string {
  const header = `[${section}]`;
  const block = `${header}\n${body.trim()}\n`;
  if (existing === null || existing.trim() === "") return block;

  const lines = existing.split(/\r?\n/);
  const isHeader = (line: string): boolean => /^\s*\[.+\]\s*(#.*)?$/.test(line);
  const start = lines.findIndex((line) => line.trim() === header || line.trim().startsWith(`${header} `));

  if (start === -1) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return existing + sep + block;
  }

  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end]!)) end++;
  // Las líneas en blanco al final de la sección son separación con lo que
  // sigue: quedan fuera del reemplazo para que re-aplicar sea byte-idéntico.
  let sectionEnd = end;
  while (sectionEnd > start + 1 && lines[sectionEnd - 1]!.trim() === "") sectionEnd--;
  const result = [...lines.slice(0, start), block.trimEnd(), ...lines.slice(sectionEnd)].join("\n");
  return result.endsWith("\n") ? result : result + "\n";
}

/** Extrae el texto crudo de una sección TOML (sin header), o null si no existe. */
export function readTomlSection(existing: string | null, section: string): string | null {
  if (existing === null) return null;
  const header = `[${section}]`;
  const lines = existing.split(/\r?\n/);
  const isHeader = (line: string): boolean => /^\s*\[.+\]\s*(#.*)?$/.test(line);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end]!)) end++;
  return lines.slice(start + 1, end).join("\n");
}
