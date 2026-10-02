import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_CONTROL_PACKAGE,
  readBrowserControlRelayVersion,
  resolveBrowserControlRelayPort,
} from "./browser-control-runtime.js";
import {
  loadVerifiedRetainedBrowserRelease,
  loadVerifiedRetainedBrowserReleaseByBinding,
  planManagedBrowserInvocation,
  planManagedBrowserInvocationForRetainedRelease,
  type ManagedBrowserInvocationPlan,
  type VerifiedRetainedBrowserRelease,
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

// ---------------------------------------------------------------------------
// Supervisor Linux opt-in (Spec T13): prueba de readiness del servicio de
// usuario. Reutiliza el transporte HTTP acotado y el verificador estricto de la
// release retenida; no parsea `ExecStart`, no adquiere nada y no toca unidades
// ajenas. Todas las fronteras externas (manager) pasan por `systemctlRunner`,
// cuyo default de producción es un `systemctl` absoluto verificado.
// ---------------------------------------------------------------------------

/** Borde externo del proceso manager: argv in, salida acotada out. */
export interface BrowserControlSystemctlRunner {
  (args: readonly string[]): Promise<{ status: number; stdout: string }>;
}

const SYSTEMCTL_TIMEOUT_MS = 10_000;
const SYSTEMCTL_MAX_OUTPUT_BYTES = 64 * 1024;
/** Rutas absolutas de sistema; nunca se resuelve `systemctl` por PATH. */
const SYSTEMCTL_CANDIDATES = ["/usr/bin/systemctl", "/bin/systemctl"] as const;

const SHOW_PROPERTIES = [
  "Id",
  "LoadState",
  "FragmentPath",
  "DropInPaths",
  "NeedDaemonReload",
  "ActiveState",
  "SubState",
] as const;

function systemctlShowArgs(withMainPid: boolean): string[] {
  const properties = withMainPid ? [...SHOW_PROPERTIES, "MainPID"] : [...SHOW_PROPERTIES];
  return [
    "--user",
    "--no-pager",
    "--all",
    `--property=${properties.join(",")}`,
    "show",
    BROWSER_CONTROL_SERVICE_UNIT_FILENAME,
  ];
}

/** `systemctl` absoluto y ejecutable de rutas verificadas; nunca PATH. */
function resolveSystemctlBin(): string | null {
  for (const candidate of SYSTEMCTL_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Siguiente candidato fijo.
    }
  }
  return null;
}

/**
 * Runner de producción: binario absoluto verificado, `shell: false`, deadline y
 * tope de bytes. La salida capturada nunca se incluye en los errores (solo el
 * estado/código), así que no se filtran valores del manager.
 */
export function createSystemctlRunner(): BrowserControlSystemctlRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      const bin = resolveSystemctlBin();
      if (bin === null) {
        reject(new Error("systemctl no está disponible en las rutas de sistema verificadas"));
        return;
      }
      const child = spawn(bin, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let bytes = 0;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const overflow = (): void => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("la salida de systemctl superó el límite acotado")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("systemctl superó el tiempo de espera")));
      }, SYSTEMCTL_TIMEOUT_MS);
      timer.unref();
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > SYSTEMCTL_MAX_OUTPUT_BYTES) {
          overflow();
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > SYSTEMCTL_MAX_OUTPUT_BYTES) overflow();
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => resolve({ status: code ?? 1, stdout })));
    });
}

interface RunnerOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly stdout: string;
  readonly reason?: string;
}

async function runSystemctl(
  runner: BrowserControlSystemctlRunner,
  args: readonly string[],
): Promise<RunnerOutcome> {
  let result: { status: number; stdout: string };
  try {
    result = await runner(args);
  } catch (error) {
    return { ok: false, status: 1, stdout: "", reason: error instanceof Error ? error.message : String(error) };
  }
  if (typeof result.status !== "number" || typeof result.stdout !== "string") {
    return { ok: false, status: 1, stdout: "", reason: "respuesta inválida del runner de systemctl" };
  }
  return { ok: true, status: result.status, stdout: result.stdout };
}

/**
 * Parser cerrado de la salida `Nombre=Valor` de `systemctl show`: separa por el
 * primer `=`, exige cada propiedad solicitada exactamente una vez y no depende
 * del orden. Una línea sin `=` o una propiedad duplicada es un estado incierto,
 * nunca ausencia.
 */
function parseShowProperties(
  stdout: string,
  required: readonly string[],
): { ok: true; props: Record<string, string> } | { ok: false; reason: string } {
  const props: Record<string, string> = {};
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator < 0) return { ok: false, reason: "la salida de systemctl contiene una línea sin `=`" };
    const name = line.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(props, name)) {
      return { ok: false, reason: `la salida de systemctl repite la propiedad ${name}` };
    }
    props[name] = line.slice(separator + 1);
  }
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(props, name)) {
      return { ok: false, reason: `la salida de systemctl omite la propiedad ${name}` };
    }
  }
  return { ok: true, props };
}

export interface BrowserControlServicePreflightInput {
  readonly runner: BrowserControlSystemctlRunner;
  /** Puerto efectivo de la unidad/MCP; la ausencia se exige en ese destino exacto. */
  readonly port: number;
}

export type BrowserControlServicePreflightResult =
  | { readonly kind: "clear" }
  | { readonly kind: "pending"; readonly reason: string };

/**
 * Preflight de una activación inicial: exige ausencia puntual del relay en el
 * puerto efectivo Y ausencia conocida de la unidad en el manager. Presente o
 * incierto no autoriza ninguna mutación.
 */
export async function preflightBrowserControlServiceUnit(
  input: BrowserControlServicePreflightInput,
): Promise<BrowserControlServicePreflightResult> {
  const relay = await readBrowserControlRelayVersion(input.port);
  if (relay.status !== "absent") {
    return {
      kind: "pending",
      reason: relay.status === "present"
        ? "el relay de Browser Control responde en el puerto gestionado; no se crea ni arranca el servicio"
        : `no se pudo comprobar la ausencia del relay en el puerto gestionado (${relay.reason})`,
    };
  }
  const outcome = await runSystemctl(input.runner, systemctlShowArgs(false));
  if (!outcome.ok) return { kind: "pending", reason: `no se pudo consultar el manager (${outcome.reason})` };
  if (outcome.status !== 0) return { kind: "pending", reason: `systemctl show devolvió estado ${outcome.status}` };
  const parsed = parseShowProperties(outcome.stdout, SHOW_PROPERTIES);
  if (!parsed.ok) return { kind: "pending", reason: parsed.reason };
  const props = parsed.props;
  const identityError = ownUnitIdError(props);
  if (identityError !== null) return { kind: "pending", reason: identityError };
  const absent = props["LoadState"] === "not-found"
    && props["FragmentPath"] === ""
    && props["DropInPaths"] === ""
    && props["NeedDaemonReload"] === "no"
    && props["ActiveState"] === "inactive"
    && props["SubState"] === "dead";
  if (!absent) {
    return {
      kind: "pending",
      reason: `el manager no acredita la ausencia de la unidad (LoadState=${props["LoadState"]}, NeedDaemonReload=${props["NeedDaemonReload"]}, ActiveState=${props["ActiveState"]}, SubState=${props["SubState"]})`,
    };
  }
  return { kind: "clear" };
}

interface OperationalReadback {
  readonly mainPid: number;
}

/**
 * Identidad declarada por el manager: debe ser exactamente la unidad propia. Un
 * `Id` ajeno contradice tanto la ausencia como el readback operativo de la
 * unidad propia; la regla se comparte para no duplicarla en cada comprobación.
 */
function ownUnitIdError(props: Record<string, string>): string | null {
  if (props["Id"] !== BROWSER_CONTROL_SERVICE_UNIT_FILENAME) {
    return `la unidad consultada no declara la identidad propia (Id=${props["Id"]})`;
  }
  return null;
}

/** Guardas comunes: la unidad propia está cargada, sin drop-ins ni recarga pendiente. */
function ownUnitLoadedError(props: Record<string, string>, unitPath: string): string | null {
  const idError = ownUnitIdError(props);
  if (idError !== null) return idError;
  if (props["LoadState"] !== "loaded") return `la unidad no está cargada (LoadState=${props["LoadState"]})`;
  if (props["FragmentPath"] !== unitPath) return "FragmentPath no coincide literalmente con la unidad propia";
  if (props["DropInPaths"] !== "") return "la unidad propia tiene drop-ins ajenos";
  if (props["NeedDaemonReload"] !== "no") return "el manager exige recargar definiciones (NeedDaemonReload)";
  return null;
}

async function inspectInactiveOwnUnit(
  runner: BrowserControlSystemctlRunner,
  unitPath: string,
): Promise<string | null> {
  const outcome = await runSystemctl(runner, systemctlShowArgs(false));
  if (!outcome.ok) return `no se pudo consultar el manager (${outcome.reason})`;
  if (outcome.status !== 0) return `systemctl show devolvió estado ${outcome.status}`;
  const parsed = parseShowProperties(outcome.stdout, SHOW_PROPERTIES);
  if (!parsed.ok) return parsed.reason;
  const common = ownUnitLoadedError(parsed.props, unitPath);
  if (common !== null) return common;
  const props = parsed.props;
  if (props["ActiveState"] !== "inactive" || props["SubState"] !== "dead") {
    return `la unidad no quedó inactiva (ActiveState=${props["ActiveState"]}, SubState=${props["SubState"]})`;
  }
  return null;
}

async function inspectOperationalUnit(
  runner: BrowserControlSystemctlRunner,
  unitPath: string,
): Promise<{ ok: true; readback: OperationalReadback } | { ok: false; reason: string }> {
  const outcome = await runSystemctl(runner, systemctlShowArgs(true));
  if (!outcome.ok) return { ok: false, reason: `no se pudo consultar el manager (${outcome.reason})` };
  if (outcome.status !== 0) return { ok: false, reason: `systemctl show devolvió estado ${outcome.status}` };
  const parsed = parseShowProperties(outcome.stdout, [...SHOW_PROPERTIES, "MainPID"]);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const props = parsed.props;
  const common = ownUnitLoadedError(props, unitPath);
  if (common !== null) return { ok: false, reason: common };
  if (props["ActiveState"] !== "active" || props["SubState"] !== "running") {
    return { ok: false, reason: `la unidad no está operativa (ActiveState=${props["ActiveState"]}, SubState=${props["SubState"]})` };
  }
  const mainPidRaw = props["MainPID"] ?? "";
  if (!/^\d+$/.test(mainPidRaw)) return { ok: false, reason: "MainPID no es decimal" };
  const mainPid = Number(mainPidRaw);
  if (!Number.isInteger(mainPid) || mainPid < 1 || mainPid > 0xffff_ffff) {
    return { ok: false, reason: "MainPID fuera del rango uint32 positivo" };
  }
  return { ok: true, readback: { mainPid } };
}

export interface BrowserControlServiceInactiveProbeInput {
  readonly runner: BrowserControlSystemctlRunner;
  readonly unitPath: string;
  /** Puerto propio de la unidad; la ausencia del relay se exige en ese destino exacto. */
  readonly port: number;
}

export type BrowserControlServiceInactiveProbeResult =
  | { readonly kind: "inactive" }
  | { readonly kind: "pending"; readonly reason: string };

/**
 * Introspección de SOLO LECTURA para decidir la retirada del entorno gestionado
 * en una rotación A→B: exige la unidad propia cargada/canónica e inactiva
 * (`inactive`/`dead`/`MainPID=0`, sin drop-ins ni recarga pendiente) Y ausencia
 * puntual del relay en el puerto propio. Nunca recarga, arranca, para ni
 * reescribe la unidad; una observación incierta o no inactiva es `pending`.
 */
export async function probeInactiveOwnedServiceUnit(
  input: BrowserControlServiceInactiveProbeInput,
): Promise<BrowserControlServiceInactiveProbeResult> {
  const unitPath = path.resolve(input.unitPath);
  const outcome = await runSystemctl(input.runner, systemctlShowArgs(true));
  if (!outcome.ok) return { kind: "pending", reason: `no se pudo consultar el manager (${outcome.reason})` };
  if (outcome.status !== 0) return { kind: "pending", reason: `systemctl show devolvió estado ${outcome.status}` };
  const parsed = parseShowProperties(outcome.stdout, [...SHOW_PROPERTIES, "MainPID"]);
  if (!parsed.ok) return { kind: "pending", reason: parsed.reason };
  const props = parsed.props;
  const common = ownUnitLoadedError(props, unitPath);
  if (common !== null) return { kind: "pending", reason: common };
  if (props["ActiveState"] !== "inactive" || props["SubState"] !== "dead") {
    return {
      kind: "pending",
      reason: `la unidad no está inactiva (ActiveState=${props["ActiveState"]}, SubState=${props["SubState"]})`,
    };
  }
  if (props["MainPID"] !== "0") {
    return { kind: "pending", reason: `MainPID no es 0 (${props["MainPID"]})` };
  }
  const relay = await readBrowserControlRelayVersion(input.port);
  if (relay.status !== "absent") {
    return {
      kind: "pending",
      reason: relay.status === "present"
        ? "el relay responde en el puerto propio; no se retira el entorno gestionado"
        : `no se pudo comprobar la ausencia del relay en el puerto propio (${relay.reason})`,
    };
  }
  return { kind: "inactive" };
}

/** Entry acotado y UTF-8 estricto; una sola asignación exacta de build id. */
const BUILD_ID_ASSIGNMENT = /^var browserControlBuildId = "([^"]+)";$/;
const MAX_BUILD_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * Extrae estáticamente `browserControlBuildId` del entry autenticado que el
 * guard ejecutará. No importa/eval y falla cerrado (`null`) ante ausencia,
 * duplicación, formato cambiado, bytes no UTF-8 o fecha que no sobrevive el
 * roundtrip `Date.toISOString`.
 */
function extractBrowserControlBuildId(entryPath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entryPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BUILD_ENTRY_BYTES) return null;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(entryPath);
  } catch {
    return null;
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  const matches = text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => BUILD_ID_ASSIGNMENT.test(line));
  if (matches.length !== 1) return null;
  const value = BUILD_ID_ASSIGNMENT.exec(matches[0]!)?.[1];
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return value;
}

export interface BrowserControlServiceSupervisorInput {
  readonly stateDir: string;
  readonly unitPath: string;
  /** Binding de la unidad creada/verificada; su `releaseDirectory`/`receiptSha256` autentican la release. */
  readonly binding: ManagedBrowserControlServiceBinding;
  readonly runner: BrowserControlSystemctlRunner;
}

export type BrowserControlServiceSupervisorResult =
  | { readonly kind: "ready"; readonly port: number; readonly version: string; readonly buildId: string }
  | { readonly kind: "pending"; readonly reason: string };

/**
 * Supervisor de la activación inicial (`created`): autentica la release retenida
 * del binding y su build estático ANTES de tocar el manager; recarga
 * definiciones, verifica la unidad propia inactiva, revalida ausencia del relay,
 * habilita `--no-reload`, arranca y exige manager operativo + `/version`
 * coherente (pid==MainPID, version/build autenticados) + readback estable. Un
 * fallo en cualquier paso es `pending` honesto: nunca `ready`, nunca se declara
 * `BROWSER_CONTROL_AUTOSTART=false` de forma provisional.
 */
export async function superviseBrowserControlServiceUnit(
  input: BrowserControlServiceSupervisorInput,
): Promise<BrowserControlServiceSupervisorResult> {
  const unitPath = path.resolve(input.unitPath);
  const port = input.binding.port;

  let release: VerifiedRetainedBrowserRelease;
  try {
    release = loadVerifiedRetainedBrowserReleaseByBinding(input.stateDir, BROWSER_CONTROL_PACKAGE, {
      releaseDirectory: input.binding.releaseDirectory,
      receiptSha256: input.binding.receiptSha256,
    });
  } catch (error) {
    return {
      kind: "pending",
      reason: `no se pudo autenticar la release retenida de la unidad (${error instanceof Error ? error.message : String(error)}); el servicio queda pendiente`,
    };
  }
  const buildId = extractBrowserControlBuildId(release.receipt.entryPath);
  if (buildId === null) {
    return {
      kind: "pending",
      reason: "no se pudo extraer un browserControlBuildId único y válido del entry autenticado; el servicio queda pendiente sin activar",
    };
  }
  const expectedVersion = release.receipt.version;

  const reload = await runSystemctl(input.runner, ["--user", "--no-pager", "daemon-reload"]);
  if (!reload.ok || reload.status !== 0) {
    return { kind: "pending", reason: `daemon-reload falló (${reload.reason ?? `estado ${reload.status}`})` };
  }

  const inactiveError = await inspectInactiveOwnUnit(input.runner, unitPath);
  if (inactiveError !== null) {
    return { kind: "pending", reason: `la unidad no quedó cargada e inactiva tras recargar definiciones: ${inactiveError}` };
  }

  const relay = await readBrowserControlRelayVersion(port);
  if (relay.status !== "absent") {
    return {
      kind: "pending",
      reason: relay.status === "present"
        ? "el relay responde en el puerto gestionado antes de habilitar; no se arranca el servicio"
        : `no se pudo revalidar la ausencia del relay (${relay.reason})`,
    };
  }

  const enable = await runSystemctl(input.runner, [
    "--user",
    "--no-pager",
    "--no-reload",
    "enable",
    BROWSER_CONTROL_SERVICE_UNIT_FILENAME,
  ]);
  if (!enable.ok || enable.status !== 0) {
    return { kind: "pending", reason: `enable falló (${enable.reason ?? `estado ${enable.status}`})` };
  }

  const start = await runSystemctl(input.runner, [
    "--user",
    "--no-pager",
    "start",
    BROWSER_CONTROL_SERVICE_UNIT_FILENAME,
  ]);
  if (!start.ok || start.status !== 0) {
    return { kind: "pending", reason: `start falló (${start.reason ?? `estado ${start.status}`}); el servicio no se declara operativo` };
  }

  const operational = await inspectOperationalUnit(input.runner, unitPath);
  if (!operational.ok) {
    return { kind: "pending", reason: `readback operativo incierto: ${operational.reason}` };
  }
  const firstPid = operational.readback.mainPid;

  const version = await readBrowserControlRelayVersion(port);
  if (version.status !== "present") {
    return {
      kind: "pending",
      reason: version.status === "absent"
        ? "el endpoint /version no responde tras arrancar el servicio"
        : `no se pudo verificar /version (${version.reason})`,
    };
  }
  const reportedPid = version.payload.pid;
  const reportedVersion = version.payload.version;
  const reportedBuild = version.payload.buildId;
  if (typeof reportedPid !== "number" || !Number.isInteger(reportedPid) || reportedPid < 1 || reportedPid > 0xffff_ffff) {
    return { kind: "pending", reason: "/version no declara un pid uint32 positivo" };
  }
  if (reportedPid !== firstPid) {
    return { kind: "pending", reason: "el pid de /version no coincide con el MainPID de la unidad" };
  }
  if (reportedVersion !== expectedVersion) {
    return { kind: "pending", reason: "la version de /version no coincide con la release autenticada de la unidad" };
  }
  if (reportedBuild !== buildId) {
    return { kind: "pending", reason: "el buildId de /version no coincide con el entry autenticado" };
  }

  const stable = await inspectOperationalUnit(input.runner, unitPath);
  if (!stable.ok) {
    return { kind: "pending", reason: `segundo readback operativo incierto: ${stable.reason}` };
  }
  if (stable.readback.mainPid !== firstPid) {
    return { kind: "pending", reason: "el MainPID cambió entre readbacks; el servicio no es estable" };
  }

  return { kind: "ready", port, version: expectedVersion, buildId };
}

/** Proyección canónica de entorno del servicio verificado: solo los dos campos propios. */
export function browserControlAutostartEnvironment(port: number): Record<string, string> {
  return { BROWSER_CONTROL_AUTOSTART: "false", BROWSER_CONTROL_PORT: String(port) };
}

/**
 * SHA-256 de la proyección gestionada que autoriza la estampa de autostart:
 * forma local + comando completo del guard + puerto literal + AUTOSTART=false.
 */
export function browserControlAutostartProjectionSha256(
  invocation: { command: string; args: readonly string[] },
  port: number,
): string {
  const projection = JSON.stringify({
    type: "local",
    command: [invocation.command, ...invocation.args],
    environment: browserControlAutostartEnvironment(port),
  });
  return createHash("sha256").update(projection, "utf8").digest("hex");
}
