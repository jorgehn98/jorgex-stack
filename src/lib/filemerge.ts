/**
 * Merge idempotente (PRD D3): secciones marcadas en markdown y upsert
 * quirúrgico en JSON. Re-aplicar dos veces produce exactamente el mismo
 * resultado; el contenido del usuario fuera de lo gestionado se preserva.
 */

function markers(name: string): { open: string; close: string } {
  return { open: `<!-- jorgex:${name} -->`, close: `<!-- /jorgex:${name} -->` };
}

/**
 * Repara marcadores rotos (editados a mano): pares incompletos, en orden
 * inverso, duplicados o incrustados en una línea con más contenido. En esos
 * casos elimina TODOS los marcadores conservando el contenido, y el upsert
 * re-añade un bloque limpio. Sin esto, un upsert sobre un par roto duplicaría
 * la sección o, peor, trataría texto del usuario como interior de la sección
 * y lo borraría al reemplazar.
 */
function repairOrphanMarkers(existing: string, name: string): string {
  const { open, close } = markers(name);
  const count = (marker: string): number => existing.split(marker).length - 1;
  const opens = count(open);
  const closes = count(close);
  if (opens === 0 && closes === 0) return existing;
  const onOwnLine = (marker: string): boolean => existing.split("\n").some((line) => line.trim() === marker);
  const healthy =
    opens === 1 && closes === 1 && existing.indexOf(close) > existing.indexOf(open) && onOwnLine(open) && onOwnLine(close);
  if (healthy) return existing;
  return existing
    .split("\n")
    .map((line) => (line.trim() === open || line.trim() === close ? null : line.split(open).join("").split(close).join("")))
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function upsertMarkdownSection(existing: string | null, name: string, content: string): string {
  const { open, close } = markers(name);
  const block = `${open}\n${content.trim()}\n${close}`;
  if (existing === null || existing.trim() === "") return block + "\n";
  existing = repairOrphanMarkers(existing, name);

  const start = existing.indexOf(open);
  const end = existing.indexOf(close);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + close.length);
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}

/** Inversa de upsertMarkdownSection: elimina la sección marcada si existe. */
export function removeMarkdownSection(existing: string, name: string): string {
  existing = repairOrphanMarkers(existing, name);
  const { open, close } = markers(name);
  const start = existing.indexOf(open);
  const end = existing.indexOf(close);
  if (start === -1 || end === -1 || end < start) return existing;
  const before = existing.slice(0, start).replace(/\n+$/, "\n");
  const after = existing.slice(end + close.length).replace(/^\n+/, "\n");
  const joined = before + after;
  return joined.trim() === "" ? "" : joined.replace(/^\n+/, "");
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

function tomlRootEnd(lines: string[]): number {
  const mask = multilineStringMask(lines);
  const index = lines.findIndex((line, lineIndex) => !mask[lineIndex] && headerName(line) !== null);
  return index === -1 ? lines.length : index;
}

function rootKeyLineIndex(lines: string[], key: string): number {
  const end = tomlRootEnd(lines);
  const mask = multilineStringMask(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*=`);
  return lines.slice(0, end).findIndex((line, index) => !mask[index] && pattern.test(line));
}

export function hasTomlRootKey(existing: string | null, key: string): boolean {
  if (existing === null || existing === "") return false;
  return rootKeyLineIndex(existing.replace(/\r\n/g, "\n").split("\n"), key) !== -1;
}

/** Añade una clave escalar al root TOML solo cuando el usuario aún no la tiene. */
export function upsertTomlRootKeyIfMissing(existing: string | null, key: string, value: string): string {
  if (hasTomlRootKey(existing, key)) return existing!;
  const normalized = (existing ?? "").replace(/\r\n/g, "\n");
  const lines = normalized === "" ? [] : normalized.split("\n");

  const index = tomlRootEnd(lines);
  lines.splice(index, 0, `${key} = ${value}`);
  return lines.join("\n");
}

/** Retira una clave del root TOML solo si conserva exactamente el valor canónico. */
export function removeTomlRootKeyIfExact(existing: string, key: string, value: string): string {
  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const index = rootKeyLineIndex(lines, key);
  if (index === -1) return normalized;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`^\\s*(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')\\s*=\\s*${escapedValue}\\s*(?:#.*)?$`);
  if (!exact.test(lines[index]!)) return normalized;

  lines.splice(index, 1);
  return lines.join("\n");
}

/**
 * Normaliza el nombre de tabla de una línea-header TOML para comparar:
 * `[ mcp_servers."engram" ] # nota` → `mcp_servers.engram`. Devuelve null si
 * la línea no es un header.
 */
function headerName(line: string): string | null {
  const match = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  if (!match) return null;
  return match[1]!
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

/**
 * Marca qué líneas están DENTRO de un string multilínea (''' o """) del
 * usuario: ahí una línea `[x]` es texto, no un header de sección.
 */
function multilineStringMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inside: string | null = null;
  for (const line of lines) {
    if (inside !== null) {
      mask.push(true);
      if (line.includes(inside)) inside = null;
      continue;
    }
    mask.push(false);
    for (const delim of ["'''", '"""']) {
      if ((line.split(delim).length - 1) % 2 === 1) {
        inside = delim;
        break;
      }
    }
  }
  return mask;
}

/** Localiza una sección TOML: [start, end) en líneas, o null si no existe. */
function findTomlSection(lines: string[], section: string): { start: number; end: number } | null {
  const mask = multilineStringMask(lines);
  const start = lines.findIndex((line, i) => !mask[i] && headerName(line) === section);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (mask[end] || headerName(lines[end]!) === null)) end++;
  return { start, end };
}

/**
 * Upsert quirúrgico de UNA sección TOML por texto (PRD D3): reemplaza desde el
 * header `[section]` hasta el siguiente header (o EOF); si no existe, la añade
 * al final. Todo lo demás — otras secciones, comentarios, orden — se preserva
 * byte a byte. `body` son las líneas clave=valor SIN el header.
 */
export function upsertTomlSection(existing: string | null, section: string, body: string): string {
  const header = `[${section}]`;
  const block = `${header}\n${body.trim()}\n`;
  if (existing === null || existing.trim() === "") return block;

  const lines = existing.split(/\r?\n/);
  const found = findTomlSection(lines, section);

  if (found === null) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return existing + sep + block;
  }

  // Las líneas en blanco al final de la sección son separación con lo que
  // sigue: quedan fuera del reemplazo para que re-aplicar sea byte-idéntico.
  let sectionEnd = found.end;
  while (sectionEnd > found.start + 1 && lines[sectionEnd - 1]!.trim() === "") sectionEnd--;
  const result = [...lines.slice(0, found.start), block.trimEnd(), ...lines.slice(sectionEnd)].join("\n");
  return result.endsWith("\n") ? result : result + "\n";
}

/** Inversa de upsertTomlSection: elimina la sección (y su separación) si existe. */
export function removeTomlSection(existing: string, section: string): string {
  const lines = existing.split(/\r?\n/);
  const found = findTomlSection(lines, section);
  if (found === null) return existing;
  // Absorbe también las líneas en blanco previas al header eliminado.
  let realStart = found.start;
  while (realStart > 0 && lines[realStart - 1]!.trim() === "") realStart--;
  const result = [...lines.slice(0, realStart), ...lines.slice(found.end)].join("\n");
  if (result.trim() === "") return "";
  return result.endsWith("\n") ? result : result + "\n";
}

/** Extrae el texto crudo de una sección TOML (sin header), o null si no existe. */
export function readTomlSection(existing: string | null, section: string): string | null {
  if (existing === null) return null;
  const lines = existing.split(/\r?\n/);
  const found = findTomlSection(lines, section);
  if (found === null) return null;
  return lines.slice(found.start + 1, found.end).join("\n");
}
