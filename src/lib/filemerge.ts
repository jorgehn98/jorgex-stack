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
