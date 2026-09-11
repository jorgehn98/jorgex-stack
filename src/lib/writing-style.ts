import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

export interface WritingStyleSnapshot {
  sourcePath: string;
  content: string | null;
}

export function resolveWritingStyleFile(options: { stateDir?: string; targetDir?: string } = {}): string {
  return path.join(options.targetDir ?? options.stateDir ?? dataDir(), "writing-style.md");
}

export function readWritingStyle(sourcePath: string, options: { rootDir?: string } = {}): WritingStyleSnapshot {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sourcePath, content: null };
    throw new Error(`No se puede leer el estilo ${sourcePath}. Revisa los permisos del archivo.`, { cause: error });
  }
  if (options.rootDir !== undefined) {
    const relative = path.relative(fs.realpathSync(options.rootDir), fs.realpathSync(sourcePath));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`El enlace de estilo ${sourcePath} sale del destino aislado.`);
    }
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
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n").trim();
  } catch {
    throw new Error(`La fuente de estilo ${sourcePath} debe usar UTF-8 válido.`);
  }
  if (content.includes("jorgex:")) throw new Error(`La fuente de estilo ${sourcePath} contiene marcadores jorgex: reservados.`);
  return { sourcePath, content: content || null };
}
