import fs from "node:fs";
import path from "node:path";

/**
 * Piezas de aislamiento compartidas por los tests OpenCode que preparan un
 * HOME/XDG/TMP privado: solo lo que es idéntico entre consumidores y no depende
 * de sus contratos de entorno. Cada test conserva su propia lista de claves,
 * su raíz temporal y su orden de `vi.resetModules()`; aquí no se esconde un
 * esquema de opciones.
 */

/**
 * Captura el valor actual de `keys` y devuelve la restauración exacta
 * (reponiendo `undefined` como borrado). Preserva el contrato de entorno de cada
 * consumidor sin imponerle qué claves usa.
 */
export function snapshotEnv(keys: readonly string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export interface FakeEngram {
  bin: string;
  invokedMarker: string;
  setupMarker: string;
}

/**
 * Fake Engram en un HOME aislado: registra cualquier invocación y marca el
 * subcomando `setup`. Nunca se ejecuta contra el Engram real.
 */
export function seedFakeEngram(home: string): FakeEngram {
  const bin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const invokedMarker = `${bin}.invoked`;
  const setupMarker = `${bin}.setup`;
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${quoted(invokedMarker)}`,
      `if [ "$1" = "setup" ]; then printf 'setup\\n' >> ${quoted(setupMarker)}; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit no aplica.
  }
  return { bin, invokedMarker, setupMarker };
}

/** Archivos de backup propios de Stack bajo un HOME aislado. */
export function backupFiles(home: string): string[] {
  const root = path.join(home, ".jorgex-stack", "backups");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const filesDir = path.join(root, entry, "files");
    if (!fs.existsSync(filesDir)) continue;
    for (const name of fs.readdirSync(filesDir)) out.push(path.join(filesDir, name));
  }
  return out;
}

/** ¿Algún backup contiene exactamente `bytes`? */
export function backupContains(home: string, bytes: Buffer): boolean {
  return backupFiles(home).some((file) => fs.readFileSync(file).equals(bytes));
}
