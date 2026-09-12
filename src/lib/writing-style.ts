import fs from "node:fs";
import path from "node:path";
import { dataDir, stackRoot } from "./paths.js";
import { createBackup } from "./backup.js";
import { hasHealthyManagedMarkdownMarkers, upsertMarkdownSection } from "./filemerge.js";
import { writeText } from "./fsx.js";

export interface WritingStyleSnapshot {
  readonly sourcePath: string;
  readonly content: string | null;
}

export interface WritingStylePlan extends WritingStyleSnapshot {
  readonly content: string;
  readonly canonicalPath: string;
  readonly originalContent: string | null;
  readonly installedContent: string;
  readonly backupRoot?: string;
  readonly rootDir?: string;
}

const DEFAULT_SECTION = "writing-style-default";
const DEFAULT_OPEN = `<!-- jorgex:${DEFAULT_SECTION} -->`;
const DEFAULT_CLOSE = `<!-- /jorgex:${DEFAULT_SECTION} -->`;

function assertContained(file: string, rootDir: string): void {
  const relative = path.relative(fs.realpathSync(rootDir), fs.realpathSync(file));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`La ruta de estilo ${file} sale del destino aislado.`);
  }
}

function validateBackupRoot(rootDir: string | undefined): void {
  if (rootDir === undefined) return;
  const backupRoot = path.join(rootDir, "backups");
  try {
    fs.lstatSync(backupRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertContained(backupRoot, rootDir);
  if (!fs.statSync(backupRoot).isDirectory()) throw new Error(`El destino de backups ${backupRoot} no es un directorio.`);
}

export function resolveWritingStyleFile(options: { stateDir?: string; targetDir?: string } = {}): string {
  return path.join(options.targetDir ?? options.stateDir ?? dataDir(), "writing-style.md");
}

function readStyleText(sourcePath: string, options: { rootDir?: string } = {}): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`No se puede leer el estilo ${sourcePath}. Revisa los permisos del archivo.`, { cause: error });
  }
  if (options.rootDir !== undefined) {
    assertContained(sourcePath, options.rootDir);
  }
  if (!(stat.isSymbolicLink() ? fs.statSync(sourcePath) : stat).isFile()) {
    throw new Error(`La fuente de estilo ${sourcePath} debe ser un archivo.`);
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(sourcePath);
  } catch (error) {
    throw new Error(`No se puede leer el estilo ${sourcePath}. Revisa los permisos del archivo.`, { cause: error });
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`La fuente de estilo ${sourcePath} debe usar UTF-8 válido.`);
  }
  return content;
}

export function readWritingStyle(sourcePath: string, options: { rootDir?: string } = {}): WritingStyleSnapshot {
  const content = readStyleText(sourcePath, options)?.replace(/\r\n?/g, "\n").trim() ?? "";
  if (content.includes("jorgex:")) throw new Error(`La fuente de estilo ${sourcePath} contiene marcadores jorgex: reservados.`);
  return { sourcePath, content: content || null };
}

export function prepareWritingStyle(
  sourcePath: string,
  options: { rootDir?: string; stackDir?: string } = {},
): WritingStylePlan {
  const canonicalPath = path.join(options.stackDir ?? stackRoot(), "system-prompt", "writing-style.md");
  const canonical = readWritingStyle(canonicalPath).content;
  if (canonical === null) throw new Error(`Falta el estilo canónico o está vacío en ${canonicalPath}; repara la instalación de Stack.`);
  const originalContent = readStyleText(sourcePath, options);
  if (originalContent?.includes("jorgex:")) {
    if (!hasHealthyManagedMarkdownMarkers(originalContent, DEFAULT_SECTION)
      || originalContent.replace(DEFAULT_OPEN, "").replace(DEFAULT_CLOSE, "").includes("jorgex:")) {
      throw new Error(`Marcadores de estilo ambiguos o desconocidos en ${sourcePath}; revisa el bloque ${DEFAULT_SECTION}.`);
    }
  }
  const installedContent = upsertMarkdownSection(originalContent, DEFAULT_SECTION, canonical);
  if (originalContent !== null && originalContent !== installedContent) validateBackupRoot(options.rootDir);
  const content = installedContent.replace(DEFAULT_OPEN, "").replace(DEFAULT_CLOSE, "").replace(/\r\n?/g, "\n").trim();
  return {
    sourcePath, content, canonicalPath, originalContent, installedContent,
    rootDir: options.rootDir,
    backupRoot: options.rootDir === undefined ? undefined : path.join(options.rootDir, "backups"),
  };
}

export function applyWritingStyle(plan: WritingStylePlan, dryRun = false): void {
  if (dryRun) return;
  const current = readStyleText(plan.sourcePath, { rootDir: plan.rootDir });
  if (current === plan.installedContent) return;
  if (current !== plan.originalContent) {
    throw new Error(`El estilo ${plan.sourcePath} cambió durante la preparación; vuelve a ejecutar el comando.`);
  }
  if (current !== null) {
    validateBackupRoot(plan.rootDir);
    createBackup([plan.sourcePath], "writing-style", plan.backupRoot);
  }
  const mode = current === null ? 0o600 : fs.statSync(plan.sourcePath).mode & 0o777;
  writeText(plan.sourcePath, plan.installedContent, mode);
}
