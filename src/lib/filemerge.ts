/**
 * Merge idempotente (PRD D3): secciones marcadas en markdown y upsert
 * quirúrgico en JSON. Re-aplicar dos veces produce exactamente el mismo
 * resultado; el contenido del usuario fuera de lo gestionado se preserva.
 */

import { isDeepStrictEqual } from "node:util";
import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, SyntaxKind, type ParseError } from "jsonc-parser";

type JsoncPath = (string | number)[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface JsoncParseResult {
  value: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Parsea JSONC (comentarios y comas finales permitidos). Falla cerrado ante
 * cualquier error de sintaxis: nunca se opera sobre un árbol parcialmente
 * parseado. Solo acepta un objeto en la raíz.
 */
export function parseJsoncObject(text: string): JsoncParseResult {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    return { value: null, error: `${printParseErrorCode(first.error)}@${first.offset}` };
  }
  if (!isPlainObject(value)) return { value: null, error: "la raíz no es un objeto JSON" };
  return { value, error: null };
}

/** Diferencias mínimas original→target: set en hojas añadidas/cambiadas, remove en las ausentes. */
function collectJsoncEdits(
  original: unknown,
  target: unknown,
  path: JsoncPath,
  ops: { path: JsoncPath; value: unknown }[],
): void {
  if (isPlainObject(original) && isPlainObject(target)) {
    for (const key of Object.keys(target)) {
      if (!(key in original)) ops.push({ path: [...path, key], value: target[key] });
      else collectJsoncEdits(original[key], target[key], [...path, key], ops);
    }
    for (const key of Object.keys(original)) {
      if (!(key in target)) ops.push({ path: [...path, key], value: undefined });
    }
    return;
  }
  if (!isDeepStrictEqual(original, target)) ops.push({ path, value: target });
}

/**
 * Edita un JSONC preservando comentarios, orden y formato ajeno: aplica solo
 * las rutas realmente cambiadas con modify/applyEdits. `mutate` recibe una
 * copia del root parseado; el texto original se edita de forma quirúrgica.
 * Falla cerrado si el archivo no es JSONC válido.
 */
export function editJsonc(existing: string, mutate: (root: Record<string, unknown>) => void): string {
  const parsed = parseJsoncObject(existing);
  if (parsed.value === null) {
    throw new Error(`JSONC inválido: ${parsed.error ?? "no se pudo parsear"}`);
  }
  const target = structuredClone(parsed.value);
  mutate(target);
  const expected = pruneUndefined(target) as Record<string, unknown>;
  const ops: { path: JsoncPath; value: unknown }[] = [];
  collectJsoncEdits(parsed.value, expected, [], ops);
  let text = existing;
  try {
    for (const op of ops) {
      const edits = modify(text, op.path, op.value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
      text = applyEdits(text, edits);
    }
  } catch (error) {
    throw new Error(`JSONC: no se pudo aplicar una edición en una ruta ambigua o duplicada; corrige el archivo antes de reintentar (${error instanceof Error ? error.message : String(error)}).`);
  }
  // Postcondición: el texto editado debe re-parsear exactamente al objeto
  // objetivo. Una clave duplicada en la ruta mutada haría que `modify` editara
  // un miembro distinto del efectivo; se bloquea sin write/claim en vez de
  // aceptar una edición parcial o normalizar datos ajenos en silencio.
  const verified = parseJsoncObject(text);
  if (verified.value === null || !isDeepStrictEqual(verified.value, expected)) {
    throw new Error("JSONC: la edición no se pudo acreditar de forma exacta (clave duplicada en una ruta mutada); corrige el archivo antes de reintentar.");
  }
  return text;
}

/** Elimina claves con valor undefined: no representables en JSON, cuentan como ausencia. */
function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = pruneUndefined(entry);
    }
    return out;
  }
  return value;
}

export type JsoncArrayOperation =
  | { readonly kind: "insert"; readonly path: JsoncPath; readonly index: number; readonly value: unknown }
  | { readonly kind: "remove"; readonly path: JsoncPath; readonly index: number }
  | { readonly kind: "prune"; readonly path: JsoncPath };

function valueAtPath(root: unknown, path: JsoncPath): unknown {
  let node = root;
  for (const segment of path) {
    if (Array.isArray(node) && typeof segment === "number") node = node[segment];
    else if (isPlainObject(node) && typeof segment === "string") node = node[segment];
    else return undefined;
  }
  return node;
}

function deletePath(root: Record<string, unknown>, path: JsoncPath): void {
  const parent = valueAtPath(root, path.slice(0, -1));
  const key = path[path.length - 1]!;
  if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
  else if (isPlainObject(parent) && typeof key === "string") delete parent[key];
}

/** El nodo del array contiene comentarios propios: no se poda a ciegas. */
function arrayNodeHasComments(text: string, path: JsoncPath): boolean {
  const root = parseTree(text);
  const node = root === undefined ? undefined : findNodeAtLocation(root, path);
  if (node === undefined) return false;
  const raw = text.slice(node.offset, node.offset + node.length);
  return raw.includes("//") || raw.includes("/*");
}

/**
 * Edita UN array JSONC por posición preservando comentarios y entradas ajenas:
 * inserta en `index`, retira el elemento en `index`, o poda la clave si quedó
 * como array vacío sin comentarios, sin reescribir el array completo. La
 * remoción recorta solo el span del valor y un token coma elegido por scanner,
 * preservando toda la trivia ajena (comentarios de línea/bloque). Postcondición:
 * el texto debe reparsear exactamente al objeto esperado, sin claves duplicadas
 * ni ediciones parciales.
 */
export function editJsoncArray(existing: string, operation: JsoncArrayOperation): string {
  const parsed = parseJsoncObject(existing);
  if (parsed.value === null) throw new Error(`JSONC inválido: ${parsed.error ?? "no se pudo parsear"}`);
  const expected = structuredClone(parsed.value) as Record<string, unknown>;
  let text = existing;
  try {
    if (operation.kind === "prune") {
      const current = valueAtPath(expected, operation.path);
      if (Array.isArray(current) && current.length === 0 && !arrayNodeHasComments(existing, operation.path)) {
        text = applyEdits(existing, modify(existing, operation.path, undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }));
        deletePath(expected, operation.path);
      }
    } else if (operation.kind === "insert") {
      const array = valueAtPath(expected, operation.path);
      if (!Array.isArray(array)) throw new Error("la ruta no resuelve a un array");
      text = applyEdits(existing, modify(existing, [...operation.path, operation.index], operation.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
        isArrayInsertion: true,
      }));
      array.splice(operation.index, 0, operation.value);
    } else {
      const rootNode = parseTree(existing);
      const arrayNode = rootNode === undefined ? undefined : findNodeAtLocation(rootNode, operation.path);
      const children = arrayNode?.type === "array" ? arrayNode.children : undefined;
      if (children === undefined || operation.index < 0 || operation.index >= children.length) {
        throw new Error(`índice ${operation.index} fuera del array`);
      }
      const target = children[operation.index]!;
      const previous = operation.index === 0 ? undefined : children[operation.index - 1]!;
      // Retira SOLO el span del valor y UN token coma, elegido con el scanner
      // nativo (que salta trivia): la coma siguiente si existe entre el fin del
      // valor y el siguiente hijo/cierre; si no, la coma precedente. Así se
      // preserva TODA la trivia ajena (comentarios de línea/bloque), no solo
      // cuando el entry owned está al final.
      const scanner = createScanner(existing, true);
      scanner.setPosition(target.offset + target.length);
      let commaOffset = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : -1;
      if (commaOffset < 0 && previous !== undefined) {
        scanner.setPosition(previous.offset + previous.length);
        if (scanner.scan() === SyntaxKind.CommaToken) commaOffset = scanner.getTokenOffset();
      }
      const edits = [{ offset: target.offset, length: target.length, content: "" }];
      if (commaOffset >= 0) edits.push({ offset: commaOffset, length: 1, content: "" });
      text = applyEdits(existing, edits);
      const array = valueAtPath(expected, operation.path);
      if (!Array.isArray(array)) throw new Error("la ruta no resuelve a un array");
      array.splice(operation.index, 1);
    }
  } catch (error) {
    throw new Error(`JSONC: no se pudo aplicar una edición de array en una ruta ambigua; corrige el archivo antes de reintentar (${error instanceof Error ? error.message : String(error)}).`);
  }
  const verified = parseJsoncObject(text);
  if (verified.value === null || !isDeepStrictEqual(verified.value, expected)) {
    throw new Error("JSONC: la edición de array no se pudo acreditar de forma exacta (clave duplicada o ruta ambigua); corrige el archivo antes de reintentar.");
  }
  return text;
}

function markers(name: string): { open: string; close: string } {
  return { open: `<!-- jorgex:${name} -->`, close: `<!-- /jorgex:${name} -->` };
}

/** Pure health check shared by marker writers and capability diagnostics. */
export function hasHealthyManagedMarkdownMarkers(existing: string, name: string): boolean {
  const { open, close } = markers(name);
  const count = (marker: string): number => existing.split(marker).length - 1;
  const onOwnLine = (marker: string): boolean => existing.split("\n").some((line) => line.trim() === marker);
  return count(open) === 1
    && count(close) === 1
    && existing.indexOf(close) > existing.indexOf(open)
    && onOwnLine(open)
    && onOwnLine(close);
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
  if (hasHealthyManagedMarkdownMarkers(existing, name)) return existing;
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
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
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
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const normalized = (existing ?? "").replace(/\r\n/g, "\n");
  const lines = normalized === "" ? [] : normalized.split("\n");

  const index = tomlRootEnd(lines);
  lines.splice(index, 0, `${key} = ${value}`);
  return lines.join(eol);
}

/** Retira una clave del root TOML solo si conserva exactamente el valor canónico. */
export function removeTomlRootKeyIfExact(existing: string, key: string, value: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const index = rootKeyLineIndex(lines, key);
  if (index === -1) return existing;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`^\\s*(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')\\s*=\\s*${escapedValue}\\s*(?:#.*)?$`);
  if (!exact.test(lines[index]!)) return existing;

  lines.splice(index, 1);
  return lines.join(eol);
}

/**
 * Normaliza el nombre de tabla de una línea-header TOML para comparar:
 * `[ mcp_servers."engram" ] # nota` → `mcp_servers.engram`. Devuelve null si
 * la línea no es un header.
 */
export function headerName(line: string): string | null {
  const match = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  if (!match) return null;
  return match[1]!
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

type MultilineDelimiter = "'''" | '"""';

function quoteRunLength(line: string, start: number, quote: '"' | "'"): number {
  let end = start + 1;
  while (end < line.length && line[end] === quote) end++;
  return end - start;
}

/** Omite una string de una línea sin validar su contenido ni arrastrar estado. */
function skipShortString(line: string, start: number, quote: '"' | "'"): number {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === quote) return index + 1;
    if (quote === '"' && line[index] === "\\") {
      index += 2;
      continue;
    }
    index++;
  }
  return line.length;
}

/** Consume una línea y devuelve el delimitador multilínea abierto para la siguiente. */
function scanTomlLine(line: string, initial: MultilineDelimiter | null): MultilineDelimiter | null {
  let inside = initial;
  let index = 0;

  while (index < line.length) {
    if (inside !== null) {
      const quote = inside === '"""' ? '"' : "'";
      if (line[index] === quote) {
        const run = quoteRunLength(line, index, quote);
        if (run >= 3) {
          // Consume toda la secuencia: en un cierre válido de 4/5, las
          // comillas extra son contenido, no el inicio de otra string.
          inside = null;
        }
        index += run;
        continue;
      }
      if (inside === '"""' && line[index] === "\\") {
        // Trata la barra y el carácter siguiente como pareja opaca;
        // no interpreta ni valida el escape.
        index += 2;
        continue;
      }
      index++;
      continue;
    }

    const char = line[index];
    if (char === "#") break;
    if (char !== '"' && char !== "'") {
      index++;
      continue;
    }

    const run = quoteRunLength(line, index, char);
    if (run >= 3) {
      inside = char === '"' ? '"""' : "'''";
      index += 3;
    } else {
      index = skipShortString(line, index, char);
    }
  }

  return inside;
}

/**
 * Marca qué líneas están DENTRO de un string multilínea (''' o """) del
 * usuario: ahí una línea `[x]` es texto, no un header de sección. La marca se
 * calcula según el estado al comenzar cada línea. Es un detector léxico
 * acotado, no un parser ni un validador TOML: solo mantiene el delimitador
 * multilínea, omite strings de una línea y pares barra+carácter en strings
 * básicas, y corta en comentarios fuera de una string.
 */
export function multilineStringMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inside: MultilineDelimiter | null = null;
  for (const line of lines) {
    mask.push(inside !== null);
    inside = scanTomlLine(line, inside);
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
  // Casa por nombre normalizado (igual que los headers del archivo): un
  // segmento entrecomillado con puntos (Codex `[….":workspace_roots"]`)
  // debe encontrar su sección. Sin comillas es identidad.
  const target = headerName(header) ?? section;
  const block = `${header}\n${body.trim()}\n`;
  if (existing === null || existing.trim() === "") return block;

  // No normaliza el contenido ajeno: `rawLines`/`lineStarts` calculan offsets
  // sobre el texto crudo, mientras `lines` solo sirve para localizar límites.
  const rawLines = existing.split("\n");
  const lines = rawLines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const lineStarts: number[] = [];
  let offset = 0;
  for (let index = 0; index < rawLines.length; index++) {
    lineStarts.push(offset);
    offset += rawLines[index]!.length;
    if (index < rawLines.length - 1) offset++;
  }
  const found = findTomlSection(lines, target);

  if (found === null) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return existing + sep + block;
  }

  // Las líneas en blanco al final de la sección separan lo gestionado de lo
  // que sigue: quedan fuera del reemplazo para que una segunda aplicación del
  // mismo bloque sea byte-idéntica.
  let sectionEnd = found.end;
  while (sectionEnd > found.start + 1 && lines[sectionEnd - 1]!.trim() === "") sectionEnd--;
  const startOffset = lineStarts[found.start]!;
  const endOffset = lineStarts[sectionEnd] ?? existing.length;
  return existing.slice(0, startOffset) + block.trimEnd() + "\n" + existing.slice(endOffset);
}

/** Inversa de upsertTomlSection: elimina la sección (y su separación) si existe. */
export function removeTomlSection(existing: string, section: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const found = findTomlSection(lines, section);
  if (found === null) return existing;
  // Absorbe también las líneas en blanco previas al header eliminado.
  let realStart = found.start;
  while (realStart > 0 && lines[realStart - 1]!.trim() === "") realStart--;
  const result = [...lines.slice(0, realStart), ...lines.slice(found.end)].join(eol);
  if (result.trim() === "") return "";
  return result.endsWith(eol) ? result : result + eol;
}

/** Extrae el texto crudo de una sección TOML (sin header), o null si no existe. */
export function readTomlSection(existing: string | null, section: string): string | null {
  if (existing === null) return null;
  const lines = existing.split(/\r?\n/);
  const found = findTomlSection(lines, section);
  if (found === null) return null;
  return lines.slice(found.start + 1, found.end).join("\n");
}

export function hasTomlChildSection(existing: string | null, section: string): boolean {
  if (existing === null) return false;
  const lines = existing.split(/\r?\n/);
  const mask = multilineStringMask(lines);
  return lines.some((line, index) => !mask[index] && headerName(line)?.startsWith(`${section}.`) === true);
}
