import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fixture de binario OpenCode para tests.
 *
 * El gate v2 ejecuta el binario detectado (`--version`, argv directo), así que
 * una instalación real en tests necesita un ejecutable real, no un mock del
 * gate. Este helper escribe un script POSIX (o un `.cmd` en Windows, que
 * `planDetectedBinCommand` ya sabe interpretar) reutilizable por los fixtures
 * preexistentes.
 */

const tempDirs: string[] = [];

export interface OpenCodeBinaryOptions {
  /** Salida de `--version` (por defecto, un literal v2 realista). */
  output?: string;
  /** Si se indica, el fixture anexa sus argumentos a este archivo (POSIX). */
  markerFile?: string;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Escribe el ejecutable en `dir` y devuelve su ruta (sin registrar cleanup). */
export function writeOpenCodeBinary(dir: string, options: OpenCodeBinaryOptions = {}): string {
  const { output = "opencode v2.0.20", markerFile } = options;
  fs.mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") {
    const bin = path.join(dir, "opencode.cmd");
    fs.writeFileSync(bin, `@echo off\r\necho ${output}\r\n`);
    return bin;
  }

  const bin = path.join(dir, "opencode");
  const lines = [
    "#!/bin/sh",
    ...(markerFile === undefined ? [] : [`printf '%s\\n' "$@" >> ${shQuote(markerFile)}`]),
    `printf '%s\\n' ${shQuote(output)}`,
    "",
  ];
  fs.writeFileSync(bin, lines.join("\n"), { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Igual que `writeOpenCodeBinary` en un temp propio; se limpia con `cleanupOpenCodeBinaries`. */
export function opencodeV2Binary(options: OpenCodeBinaryOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-v2-bin-"));
  tempDirs.push(dir);
  return writeOpenCodeBinary(dir, options);
}

/** Elimina los temp creados por `opencodeV2Binary`. */
export function cleanupOpenCodeBinaries(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
