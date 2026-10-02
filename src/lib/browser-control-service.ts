import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BROWSER_CONTROL_PACKAGE, resolveBrowserControlRelayPort } from "./browser-control-runtime.js";
import {
  loadVerifiedRetainedBrowserRelease,
  loadVerifiedRetainedBrowserReleaseByBinding,
  planManagedBrowserInvocation,
  planManagedBrowserInvocationForRetainedRelease,
  type ManagedBrowserInvocationPlan,
} from "./browser-managed.js";
import type { ManagedBrowserControlServiceBinding } from "./manifest.js";

/**
 * T13 (vertical artifact): renderer/creación de la unidad de usuario Linux del
 * relay Browser Control. El artifact solo materializa el archivo fijo a partir
 * del active verificado; no invoca manager, no habilita/arranca y no emite el
 * marcador `BROWSER_CONTROL_AUTOSTART=false`. El supervisor/endpoint pertenecen
 * al siguiente vertical.
 */

export const BROWSER_CONTROL_SERVICE_UNIT_FILENAME = "jorgex-stack-browser-control.service";

/**
 * Base XDG config efectiva: `XDG_CONFIG_HOME` absoluto o el fallback
 * `HOME/.config`. Un valor relativo/vacío no se reinterpreta (null) para no
 * tocar un perfil personal incierto. Independiente del configDir de OpenCode.
 */
export function resolveBrowserControlServiceConfigBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== "") {
    if (!path.isAbsolute(xdg)) return null;
    return path.resolve(xdg);
  }
  const home = env.HOME;
  if (home === undefined || home.trim() === "" || !path.isAbsolute(home)) return null;
  return path.resolve(home, ".config");
}

/** Ruta fija de la unidad gestionada bajo el XDG config efectivo (o HOME fallback). */
export function resolveBrowserControlServiceUnitPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = resolveBrowserControlServiceConfigBase(env);
  return base === null ? null : path.join(base, "systemd", "user", BROWSER_CONTROL_SERVICE_UNIT_FILENAME);
}

/**
 * Serializa un argv literal para `ExecStart` con la sintaxis de systemd: comillas
 * dobles + escapes C (`\\`, `\"`, `\n`, `\r`, `\t`) y `%` duplicado para impedir
 * la expansión de especificadores. El prefijo `:` del caller desactiva además la
 * sustitución de variables; nunca se usa shell, prefijos de elevación ni `|`.
 */
function systemdQuoteArg(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\": escaped += "\\\\"; break;
      case "\"": escaped += "\\\""; break;
      case "\n": escaped += "\\n"; break;
      case "\r": escaped += "\\r"; break;
      case "\t": escaped += "\\t"; break;
      case "%": escaped += "%%"; break;
      default: escaped += char;
    }
  }
  return `"${escaped}"`;
}

/** Unidad canónica: Node + guard autenticado + launcher + el vector `serve` completo. */
export function renderBrowserControlServiceUnit(
  invocation: ManagedBrowserInvocationPlan,
  port: number,
): string {
  const execStart = `ExecStart=:${[invocation.command, ...invocation.args].map(systemdQuoteArg).join(" ")}`;
  return [
    "[Unit]",
    "Description=JorgeX Stack managed Browser Control relay",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    execStart,
    `Environment=BROWSER_CONTROL_PORT=${port}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface BrowserControlServiceCreated {
  readonly kind: "created" | "unchanged";
  readonly unitPath: string;
  readonly binding: ManagedBrowserControlServiceBinding;
}

export interface BrowserControlServicePreserved {
  readonly kind: "preserved";
  readonly unitPath: string;
  readonly reason: string;
}

export interface BrowserControlServiceError {
  readonly kind: "error";
  readonly reason: string;
}

export type BrowserControlServiceResult =
  | BrowserControlServiceCreated
  | BrowserControlServicePreserved
  | BrowserControlServiceError;

export interface EnsureBrowserControlServiceInput {
  readonly stateDir: string;
  readonly unitPath: string;
  /** Owned paths of the same manifest row: the ONLY authority for the unit claim. */
  readonly prevOwned: readonly string[];
  readonly prevBinding?: ManagedBrowserControlServiceBinding;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type ExistingUnit =
  | { readonly kind: "absent" }
  | { readonly kind: "regular"; readonly bytes: Buffer; readonly dev: number; readonly ino: number }
  | { readonly kind: "unsafe"; readonly reason: string };

function inspectExistingUnit(unitPath: string): ExistingUnit {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(unitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unsafe", reason: `no se pudo inspeccionar la unidad (${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"})` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "unsafe", reason: "la unidad no es un archivo regular" };
  if (stat.nlink > 1) return { kind: "unsafe", reason: "la unidad tiene enlaces duros" };
  try {
    return { kind: "regular", bytes: fs.readFileSync(unitPath), dev: stat.dev, ino: stat.ino };
  } catch {
    return { kind: "unsafe", reason: "la unidad no se puede leer" };
  }
}

interface OpenedUnitIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Identidad física del descriptor recién creado, capturada ANTES de escribir.
 * `null` (fstat falla o el objeto no es un archivo regular con `dev`/`ino`
 * enteros) significa identidad incierta: la ruta debe conservarse sin retirarla.
 */
function openedUnitIdentity(fd: number): OpenedUnitIdentity | null {
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * Retira la unidad recién creada SOLO si la ruta sigue nombrando exactamente el
 * mismo archivo regular de un único enlace que abrimos (`dev`/`ino`) y sus bytes
 * coinciden con la escritura esperada. Cualquier otro estado —sustitución por un
 * archivo ajeno, bytes modificados por un escritor externo, hardlink, symlink,
 * ruta ilegible o identidad incierta— conserva la ruta: borrar por ruta a ciegas
 * destruiría datos ajenos, y un archivo propio parcial es preferible a esa
 * pérdida. Devuelve `null` si la ruta quedó libre; el motivo si se conservó.
 */
function removeCreatedUnitIfUnchanged(
  unitPath: string,
  opened: OpenedUnitIdentity,
  expected: Buffer,
): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(unitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "no se pudo reinspeccionar la ruta antes de retirarla; se conserva por seguridad.";
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return "la ruta dejó de ser un archivo regular de un único enlace; se conserva por seguridad.";
  }
  if (stat.dev !== opened.dev || stat.ino !== opened.ino) {
    return "la ruta nombra un inodo distinto al recién creado (sustitución detectada); se conserva el archivo ajeno.";
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(unitPath);
  } catch {
    return "no se pudo leer la ruta para confirmar sus bytes; se conserva por seguridad.";
  }
  if (!bytes.equals(expected)) {
    return "los bytes de la ruta difieren de la escritura esperada (modificación externa o escritura parcial); se conserva sin reclamar.";
  }
  try {
    fs.rmSync(unitPath, { force: true });
    return null;
  } catch (error) {
    return `no se pudo retirar la unidad propia (${error instanceof Error ? error.message : String(error)}); se conserva.`;
  }
}

/** Rechaza symlinks/no-directorios en todos los ancestros existentes de la ruta. */
function inspectAncestors(unitPath: string): string | null {
  const chain: string[] = [];
  let current = path.dirname(unitPath);
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of chain.reverse()) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return `no se pudo inspeccionar el ancestro ${dir} (${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}).`;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return `el ancestro ${dir} no es un directorio real; no se publica la unidad.`;
    }
  }
  return null;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Autentica la evidencia `serviceUnit` de una unidad owned contra la release
 * retenida que la autorizó. No basta el digest del archivo: `receiptSha256`,
 * `releaseDirectory`, `nodePath` y `port` son un testigo físico ligado al active
 * retenido. Se reutiliza el loader/guard de `browser-managed`, nunca se parsea
 * `ExecStart` ni se acepta el digest del manifest editable como prueba plena.
 * Devuelve `null` si autentica; en caso contrario, el motivo del bloqueo.
 */
function authenticateOwnedServiceUnit(
  stateDir: string,
  binding: ManagedBrowserControlServiceBinding,
  actualBytes: Buffer,
): string | null {
  if (binding.schemaVersion !== 1) return "la evidencia serviceUnit no es schemaVersion 1";
  if (
    typeof binding.releaseDirectory !== "string" ||
    binding.releaseDirectory !== path.basename(binding.releaseDirectory) ||
    !binding.releaseDirectory.startsWith("release-") ||
    binding.releaseDirectory.includes("/") ||
    binding.releaseDirectory.includes("\\")
  ) {
    return "releaseDirectory no es un basename release-* retenido";
  }
  if (typeof binding.receiptSha256 !== "string" || !HASH.test(binding.receiptSha256)) return "receiptSha256 inválido";
  if (typeof binding.unitSha256 !== "string" || !HASH.test(binding.unitSha256)) return "unitSha256 inválido";
  if (!Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65_535) return "port inválido";
  if (binding.nodePath !== process.execPath) {
    return `nodePath no coincide con el Node efectivo autorizado (${process.execPath})`;
  }
  if (binding.unitSha256 !== sha256(actualBytes)) return "la unidad owned no coincide con unitSha256";

  let release;
  try {
    release = loadVerifiedRetainedBrowserReleaseByBinding(stateDir, BROWSER_CONTROL_PACKAGE, {
      releaseDirectory: binding.releaseDirectory,
      receiptSha256: binding.receiptSha256,
    });
  } catch (error) {
    return `no se pudo autenticar la release retenida del binding (${error instanceof Error ? error.message : String(error)})`;
  }
  if (release.releaseDirectory !== binding.releaseDirectory) {
    return "la release retenida autenticada no es la registrada en el binding";
  }

  let invocation: ManagedBrowserInvocationPlan;
  try {
    invocation = planManagedBrowserInvocationForRetainedRelease(release, ["serve"]);
  } catch (error) {
    return `no se pudo reconstruir la invocación \`serve\` autenticada del binding (${error instanceof Error ? error.message : String(error)})`;
  }
  const rendered = Buffer.from(renderBrowserControlServiceUnit(invocation, binding.port), "utf8");
  if (!rendered.equals(actualBytes) || sha256(rendered) !== binding.unitSha256) {
    return "los bytes de la unidad owned no reproducen el guard autenticado de la release retenida";
  }
  return null;
}

/**
 * Materializa la unidad fija sin clobber. Una unidad existente —ajena o manual,
 * incluso byte-idéntica— se conserva sin adoptarla. Una owned solo se reutiliza
 * si sus bytes coinciden con la autoridad registrada (`unitSha256`); un owned
 * modificado/ambiguo bloquea conservando el claim. La creación valida ancestros,
 * escribe con `wx`, hace readback y solo entonces autoriza el ownership.
 */
export function ensureBrowserControlServiceUnit(
  input: EnsureBrowserControlServiceInput,
): BrowserControlServiceResult {
  const unitPath = path.resolve(input.unitPath);
  const derivedUnitPath = resolveBrowserControlServiceUnitPath();
  if (derivedUnitPath === null || path.resolve(derivedUnitPath) !== unitPath) {
    return {
      kind: "error",
      reason: "la ruta de la unidad no es la ruta fija derivada del XDG config/HOME efectivo; no se opera sobre una ruta arbitraria.",
    };
  }
  const owned = input.prevOwned.some((file) => path.resolve(file) === unitPath);
  const existing = inspectExistingUnit(unitPath);

  if (existing.kind === "unsafe") {
    return owned
      ? { kind: "error", reason: `${unitPath}: ${existing.reason}; se conserva la unidad y su claim sin sobrescribir.` }
      : { kind: "preserved", unitPath, reason: existing.reason };
  }

  if (existing.kind === "regular") {
    if (!owned) {
      return {
        kind: "preserved",
        unitPath,
        reason: "ya existe una unidad manual/ajena en la ruta fija; se conserva sin adoptarla ni sobrescribirla.",
      };
    }
    const binding = input.prevBinding;
    if (binding === undefined) {
      return {
        kind: "error",
        reason: `${unitPath}: la unidad owned no tiene evidencia serviceUnit; se conserva sin reescribir.`,
      };
    }
    const ancestorError = inspectAncestors(unitPath);
    if (ancestorError !== null) {
      return {
        kind: "error",
        reason: `${unitPath}: ${ancestorError} Se conserva la unidad y su claim sin reescribir.`,
      };
    }
    const authError = authenticateOwnedServiceUnit(input.stateDir, binding, existing.bytes);
    if (authError !== null) {
      return {
        kind: "error",
        reason: `${unitPath}: ${authError}; se conserva la unidad y su claim sin reescribir.`,
      };
    }
    return { kind: "unchanged", unitPath, binding };
  }

  // Ausente: un claim owned sin archivo es drift; no se recrea a ciegas.
  if (owned) {
    return {
      kind: "error",
      reason: `${unitPath}: el manifest declara la unidad como owned pero el archivo no existe (drift); se conserva el claim sin recrear.`,
    };
  }

  let invocation: ManagedBrowserInvocationPlan;
  try {
    invocation = planManagedBrowserInvocation(input.stateDir, BROWSER_CONTROL_PACKAGE, ["serve"]);
  } catch (error) {
    return {
      kind: "error",
      reason: `no se pudo reconstruir la invocación \`serve\` autenticada (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const port = resolveBrowserControlRelayPort();
  if (port === null) {
    return {
      kind: "error",
      reason: "BROWSER_CONTROL_PORT no es un entero válido (1–65535); procedencia incierta y no se crea la unidad.",
    };
  }
  let release;
  try {
    release = loadVerifiedRetainedBrowserRelease(input.stateDir, BROWSER_CONTROL_PACKAGE);
  } catch (error) {
    return {
      kind: "error",
      reason: `no se pudo autenticar la release activa retenida (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  if (release === null) {
    return { kind: "error", reason: "no hay una release activa verificada que autorice la unidad." };
  }
  const bytes = Buffer.from(renderBrowserControlServiceUnit(invocation, port), "utf8");
  const binding: ManagedBrowserControlServiceBinding = {
    schemaVersion: 1,
    releaseDirectory: release.releaseDirectory,
    receiptSha256: release.receiptSha256,
    nodePath: invocation.command,
    port,
    unitSha256: sha256(bytes),
  };

  const ancestorError = inspectAncestors(unitPath);
  if (ancestorError !== null) return { kind: "error", reason: ancestorError };
  const parent = path.dirname(unitPath);
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  } catch (error) {
    return {
      kind: "error",
      reason: `no se pudo crear el directorio de la unidad ${parent} (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  // Revalidar tras crear ancestros, justo antes de publicar.
  const recheck = inspectAncestors(unitPath);
  if (recheck !== null) return { kind: "error", reason: recheck };

  let fd: number;
  try {
    fd = fs.openSync(unitPath, "wx", 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        kind: "preserved",
        unitPath,
        reason: "apareció una unidad en la ruta fija durante la creación; se conserva sin adoptarla.",
      };
    }
    return {
      kind: "error",
      reason: `no se pudo crear la unidad ${unitPath} (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  // Identidad física de la fd recién creada, capturada antes de cualquier
  // escritura: es la única prueba de que un inodo concreto es el nuestro. La
  // ruta puede ser sustituida por un archivo ajeno entre el open y el cleanup.
  const opened = openedUnitIdentity(fd);
  let fdClosed = false;
  const closeFd = (): string | null => {
    if (fdClosed) return null;
    try {
      fs.closeSync(fd);
      fdClosed = true;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  try {
    fs.writeFileSync(fd, bytes);
  } catch (error) {
    const closeNote = closeFd();
    const preserved = opened === null
      ? "no se pudo verificar la identidad de la fd recién creada; se conserva la ruta sin retirarla."
      : removeCreatedUnitIfUnchanged(unitPath, opened, bytes);
    return {
      kind: "error",
      reason: `no se pudo escribir la unidad ${unitPath} (${error instanceof Error ? error.message : String(error)}).${
        preserved === null ? "" : ` ${preserved}`
      }${closeNote === null ? "" : ` Además falló el cierre de la fd (${closeNote}); puede quedar un descriptor propio abierto.`}`,
    };
  }

  const closeNote = closeFd();
  if (closeNote !== null) {
    // Un cierre fallido deja el recurso propio en estado ambiguo: no se puede
    // garantizar readback ni retirada segura, así que se conserva sin reclamar.
    return {
      kind: "error",
      reason: `${unitPath}: la unidad se escribió pero no se pudo cerrar su descriptor (${closeNote}); se conserva sin reclamar ownership.`,
    };
  }

  const readback = inspectExistingUnit(unitPath);
  if (
    opened === null ||
    readback.kind !== "regular" ||
    readback.dev !== opened.dev ||
    readback.ino !== opened.ino ||
    !readback.bytes.equals(bytes)
  ) {
    const preserved = opened === null
      ? "no se pudo verificar la identidad de la fd recién creada; se conserva la ruta sin retirarla."
      : removeCreatedUnitIfUnchanged(unitPath, opened, bytes);
    return {
      kind: "error",
      reason: `${unitPath}: el readback de la unidad creada no coincide con el archivo recién escrito; no se reclama ownership.${
        preserved === null ? "" : ` ${preserved}`
      }`,
    };
  }
  return { kind: "created", unitPath, binding };
}
