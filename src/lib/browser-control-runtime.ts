import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  activateVerifiedBrowserArtifact,
  prepareVerifiedBrowserRelease,
  type BrowserPackageRelease,
} from "./browser-provider.js";
import {
  activateManagedBrowserTree,
  loadVerifiedManagedBrowserReceipt,
  planManagedBrowserInvocation,
  resolveStagedBrowserEntry,
  rollbackManagedBrowserActivation,
  type ManagedBrowserInvocationPlan,
  type ManagedBrowserReceipt,
} from "./browser-managed.js";
import type { StageVerifiedBrowserTreeResult } from "./browser-stage.js";

/**
 * Browser Control (Spec T13): adquisición verificada del complemento externo y
 * sondeo cerrado del relay. El namespace candidato es fijo y se deriva dentro
 * del state root verificado; el pointer que escribe selecciona SOLO un
 * candidato, nunca el active operativo, y el caller MCP/CLI/skill no lo usa
 * como fallback.
 */
export const BROWSER_CONTROL_PACKAGE = "@opencode-ai/browser-control";
export const BROWSER_CONTROL_CANDIDATE_DIRNAME = ".browser-control-candidate";

const RELAY_HOST = "127.0.0.1";
const RELAY_DEFAULT_PORT = 19_989;
const RELAY_VERSION_PATH = "/version";
const RELAY_DEADLINE_MS = 2_000;
const RELAY_MAX_RESPONSE_BYTES = 64 * 1024;

/** Ausencia comprobada, presencia con respuesta válida, o estado incierto. */
export type BrowserControlRelayStatus = "absent" | "present" | "unknown";

export interface BrowserControlCandidate {
  readonly candidateDir: string;
  readonly receipt: ManagedBrowserReceipt;
  readonly release: BrowserPackageRelease;
}

export function browserControlCandidateDir(stateDir: string): string {
  return path.join(stateDir, BROWSER_CONTROL_CANDIDATE_DIRNAME);
}

/**
 * Puerto efectivo que usarán CLI/MCP/unidad: `BROWSER_CONTROL_PORT` entero, con
 * 19989 por defecto SOLO cuando la variable está ausente. Un valor presente pero
 * en blanco, no entero o fuera de rango no se reinterpreta ni se escanea: la
 * procedencia es incierta.
 */
export function resolveBrowserControlRelayPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.BROWSER_CONTROL_PORT;
  if (raw === undefined) return RELAY_DEFAULT_PORT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/**
 * Sondeo HTTP Node directo y acotado a `http://127.0.0.1:<puerto>/version`, sin
 * proxy/redirects/credenciales ni SDK. Solo `ECONNREFUSED` directo contra ese
 * destino significa ausencia puntual; una respuesta 200 con un registro JSON que
 * declara `version` como string no vacío es presencia; cualquier otro error,
 * timeout, aborto o schema inválido es incierto. Nunca registra cuerpos ni URLs
 * de sesión.
 */
export function probeBrowserControlRelay(env: NodeJS.ProcessEnv = process.env): Promise<BrowserControlRelayStatus> {
  const port = resolveBrowserControlRelayPort(env);
  if (port === null) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    // Agente propio: nunca el global, de modo que NODE_USE_ENV_PROXY no pueda
    // reclasificar ECONNREFUSED a través de un proxy implícito.
    const agent = new http.Agent({ keepAlive: false });
    let settled = false;
    let request: http.ClientRequest | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (status: BrowserControlRelayStatus): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (request !== null) request.destroy();
      agent.destroy();
      resolve(status);
    };
    request = http.request(
      {
        host: RELAY_HOST,
        port,
        path: RELAY_VERSION_PATH,
        method: "GET",
        agent,
        headers: { accept: "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > RELAY_MAX_RESPONSE_BYTES) {
            finish("unknown");
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => finish("unknown"));
        response.on("end", () => {
          if (settled) return;
          if (response.statusCode !== 200) {
            finish("unknown");
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            const version =
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as { version?: unknown }).version
                : undefined;
            finish(typeof version === "string" && version.trim() !== "" ? "present" : "unknown");
          } catch {
            finish("unknown");
          }
        });
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "absent" : "unknown");
    });
    request.on("close", () => {
      if (timer !== null) clearTimeout(timer);
    });
    timer = setTimeout(() => finish("unknown"), RELAY_DEADLINE_MS);
    timer.unref();
    request.end();
  });
}

/**
 * Resuelve el `latest` publicado del proveedor, verifica el SRI del tarball raíz
 * y retiene el árbol verificado como candidato bajo el namespace fijo. Si ya
 * existe un candidato verificado que coincide en paquete/versión/SRI, reutiliza
 * su clausura certificada sin re-staging ni nueva resolución transitiva, sin
 * reescribir pointer/launcher. Un estado candidato corrupto u huérfano bloquea.
 * La URL del tarball proviene siempre de metadata fresca, nunca del receipt.
 */
export async function retainVerifiedBrowserControlCandidate(options: {
  stateDir: string;
  pnpmBin: string;
  fetchImpl: typeof fetch;
  stageParent?: string;
}): Promise<BrowserControlCandidate> {
  const candidateDir = browserControlCandidateDir(options.stateDir);
  const existing = loadVerifiedManagedBrowserReceipt(candidateDir, BROWSER_CONTROL_PACKAGE);
  let receipt: ManagedBrowserReceipt | null = existing;
  const release = await prepareVerifiedBrowserRelease(BROWSER_CONTROL_PACKAGE, {
    fetchImpl: options.fetchImpl,
    ...(options.stageParent === undefined ? {} : { stageParent: options.stageParent }),
    withVerifiedArtifact: async (context) => {
      if (
        receipt !== null &&
        receipt.version === context.release.version &&
        receipt.integrity === context.release.integrity
      ) {
        return;
      }
      receipt = await activateVerifiedBrowserArtifact(context, {
        stateDir: candidateDir,
        pnpmBin: options.pnpmBin,
        fetchImpl: options.fetchImpl,
      });
    },
  });
  if (receipt === null) {
    throw new Error("browser-control: la activación del candidato no produjo un receipt");
  }
  return { candidateDir, receipt, release };
}

const BROWSER_CONTROL_SERVER = "browser-control";

/** Skill oficial dentro del paquete físico de la release activa (no el canon compartido). */
export function browserControlSkillPath(receipt: ManagedBrowserReceipt): string {
  return path.join(
    receipt.treePath,
    ...BROWSER_CONTROL_PACKAGE.split("/"),
    "skills",
    BROWSER_CONTROL_SERVER,
    "SKILL.md",
  );
}

/**
 * Resultado discriminado del controlador Browser Control. El caller nunca
 * recibe receipts/stages crudos: `ready` describe únicamente la proyección del
 * active operativo ya autenticado, `pending` retiene un candidato verificado sin
 * sustituir al active, y `unavailable` conserva un diagnóstico accionable.
 */
export interface BrowserControlReady {
  readonly kind: "ready";
  readonly version: string;
  /** Invocación MCP completa del launcher `active` (sus args ya incluyen `mcp`). */
  readonly invocation: ManagedBrowserInvocationPlan;
  /** Ruta absoluta del SKILL.md retenido en la release activa, byte-identical. */
  readonly skillSource: string;
  /**
   * Recuperación acotada: solo si esta llamada promovió una release nueva,
   * restaura el active previo (o lo retira) cuando la proyección del caller
   * falla. No es un receipt; el candidato retenido nunca se toca.
   */
  readonly rollback?: () => Promise<void>;
}

export interface BrowserControlPending {
  readonly kind: "pending";
  readonly candidateVersion: string;
  readonly reason: string;
  /** Versión del active previo aún utilizable, si existe. Nunca convierte el pending en ready. */
  readonly activeVersion?: string;
}

export interface BrowserControlUnavailable {
  readonly kind: "unavailable";
  readonly reason: string;
}

export type BrowserControlRuntimeResult = BrowserControlReady | BrowserControlPending | BrowserControlUnavailable;

export interface PrepareBrowserControlRuntimeOptions {
  readonly stateDir: string;
  readonly pnpmBin: string;
  readonly fetchImpl: typeof fetch;
  readonly stageParent?: string;
  readonly probeRelay?: () => Promise<BrowserControlRelayStatus>;
}

function runtimeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relayPendingReason(status: Exclude<BrowserControlRelayStatus, "absent">): string {
  return status === "present"
    ? "el relay de Browser Control está presente y no se puede acreditar que esté inactivo; coordina manualmente con quien lo opera antes de reintentar"
    : "no se pudo determinar si el relay de Browser Control está presente; compruébalo y coordina antes de reintentar";
}

/**
 * Reconstruye la evidencia mínima que conserva el receipt de un candidato
 * verificado y la promueve al namespace operativo real con el activador
 * compartido. `nodeModulesPath = receipt.treePath`; el root físico del paquete
 * es `nodeModules/<pkg>` (confinado, metadata/bin verificados) y el bin
 * declarado debe coincidir con `receipt.entryPath`. La URL de release proviene
 * de la adquisición fresca, nunca del receipt (que no guarda tarballUrl).
 */
async function promoteVerifiedBrowserControlCandidate(
  stateDir: string,
  candidate: BrowserControlCandidate,
  previous: ManagedBrowserReceipt | null,
): Promise<ManagedBrowserReceipt> {
  const receipt = candidate.receipt;
  const nodeModulesPath = receipt.treePath;
  const treePath = path.join(nodeModulesPath, ...BROWSER_CONTROL_PACKAGE.split("/"));
  const staged: StageVerifiedBrowserTreeResult = {
    treePath,
    nodeModulesPath,
    treeSha256: receipt.treeSha256,
    closure: [...receipt.closure],
  };
  const entryPath = resolveStagedBrowserEntry(staged, BROWSER_CONTROL_PACKAGE);
  if (entryPath !== receipt.entryPath) {
    throw new Error("browser-control: el binario del candidato no coincide con su receipt verificado");
  }
  return activateManagedBrowserTree({
    stateDir,
    packageName: BROWSER_CONTROL_PACKAGE,
    release: {
      version: receipt.version,
      tarballUrl: candidate.release.tarballUrl,
      integrity: receipt.integrity,
    },
    staged,
    entryPath,
  });
}

/**
 * Valida el SKILL.md oficial de una release verificada y devuelve su ruta. Un
 * árbol con SRI correcto pero sin skill regular, confinada y UTF-8 estricto no
 * es una release funcional: se reutiliza tanto para el candidato (antes de
 * publicar) como para el active (al construir `ready`).
 */
function assertBrowserControlSkill(receipt: ManagedBrowserReceipt): string {
  const skillSource = browserControlSkillPath(receipt);
  let skillStat: fs.Stats;
  try {
    skillStat = fs.lstatSync(skillSource);
  } catch {
    throw new Error(`la release verificada no contiene la skill oficial (${skillSource})`);
  }
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error(`la skill oficial de la release verificada no es un archivo regular (${skillSource})`);
  }
  // Confinamiento físico: el SKILL.md debe resolver dentro del árbol verificado.
  let realSkill: string;
  try {
    realSkill = fs.realpathSync(skillSource);
  } catch {
    throw new Error(`la skill oficial de la release verificada no se puede resolver (${skillSource})`);
  }
  const relative = path.relative(path.resolve(receipt.treePath), path.resolve(realSkill));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`la skill oficial de la release verificada escapa de su árbol (${skillSource})`);
  }
  // UTF-8 estricto: la proyección byte-identical es texto, no bytes opacos.
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(realSkill);
  } catch {
    throw new Error(`la skill oficial de la release verificada no se puede leer (${skillSource})`);
  }
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new Error(`la skill oficial de la release verificada no es UTF-8 estricto (${skillSource})`);
  }
  return skillSource;
}

function browserControlReadyFromReceipt(
  stateDir: string,
  receipt: ManagedBrowserReceipt,
  rollback?: () => Promise<void>,
): BrowserControlReady {
  const skillSource = assertBrowserControlSkill(receipt);
  return {
    kind: "ready",
    version: receipt.version,
    invocation: planManagedBrowserInvocation(stateDir, BROWSER_CONTROL_PACKAGE, ["mcp"]),
    skillSource,
    ...(rollback === undefined ? {} : { rollback }),
  };
}

/**
 * Controlador cerrado del complemento Browser Control: adquiere el `latest`
 * verificado (metadata + SRI del tarball raíz), lo retiene en el namespace
 * candidato, sondea el relay y decide `ready | pending | unavailable`.
 *
 * - Relay presente/incierto: nunca promueve ni reinicia; conserva el candidato y
 *   reporta pending (con el active previo si existe).
 * - Ausencia comprobada: reutiliza un active verificado que ya coincide en
 *   paquete/versión/SRI; si no, promueve el candidato validado al namespace real
 *   y devuelve la proyección del active.
 * - Corrupción/orfandad en cualquiera de los dos namespaces falla cerrado.
 */
export async function prepareBrowserControlRuntime(
  options: PrepareBrowserControlRuntimeOptions,
): Promise<BrowserControlRuntimeResult> {
  const probe = options.probeRelay ?? (() => probeBrowserControlRelay());
  const relay = await probe();

  let previousActive: ManagedBrowserReceipt | null;
  try {
    previousActive = loadVerifiedManagedBrowserReceipt(options.stateDir, BROWSER_CONTROL_PACKAGE);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `el namespace activo gestionado no es válido (${runtimeReason(error)}); no se muta ni se declara la capacidad`,
    };
  }

  let candidate: BrowserControlCandidate;
  try {
    candidate = await retainVerifiedBrowserControlCandidate({
      stateDir: options.stateDir,
      pnpmBin: options.pnpmBin,
      fetchImpl: options.fetchImpl,
      ...(options.stageParent === undefined ? {} : { stageParent: options.stageParent }),
    });
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `no se pudo verificar el candidato del proveedor (${runtimeReason(error)})`,
    };
  }

  const candidateVersion = candidate.receipt.version;
  if (relay !== "absent") {
    return {
      kind: "pending",
      candidateVersion,
      reason: relayPendingReason(relay),
      ...(previousActive === null ? {} : { activeVersion: previousActive.version }),
    };
  }

  if (
    previousActive !== null &&
    previousActive.version === candidate.receipt.version &&
    previousActive.integrity === candidate.receipt.integrity
  ) {
    try {
      return browserControlReadyFromReceipt(options.stateDir, previousActive);
    } catch (error) {
      return { kind: "unavailable", reason: runtimeReason(error) };
    }
  }

  // Pre-publicación: un árbol verificado sin la skill oficial no es una release
  // funcional. Se valida el candidato ANTES de tocar el pointer operativo, de
  // modo que un fallo aquí no publica un active roto.
  try {
    assertBrowserControlSkill(candidate.receipt);
  } catch (error) {
    return { kind: "unavailable", reason: runtimeReason(error) };
  }

  let promoted: ManagedBrowserReceipt;
  try {
    promoted = await promoteVerifiedBrowserControlCandidate(options.stateDir, candidate, previousActive);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `no se pudo publicar el candidato verificado (${runtimeReason(error)})`,
    };
  }

  const rollback = async (): Promise<void> => {
    await rollbackManagedBrowserActivation(
      options.stateDir,
      BROWSER_CONTROL_PACKAGE,
      promoted,
      previousActive,
    );
  };

  // La proyección del active puede fallar tras publicar el pointer (p.ej. el plan
  // de invocación). Se restaura el active previo (o se retira) con el rollback
  // existente; si el rollback también falla, el resultado lo hace observable sin
  // fabricar ausencia: conserva el error primario y la recuperación pendiente.
  try {
    return browserControlReadyFromReceipt(options.stateDir, promoted, rollback);
  } catch (error) {
    const primary = runtimeReason(error);
    try {
      await rollback();
    } catch (rollbackError) {
      return {
        kind: "unavailable",
        reason: `la release promovida no se pudo proyectar (${primary}); además el rollback al active previo falló (${runtimeReason(rollbackError)}); revisa el receipt gestionado antes de reintentar`,
      };
    }
    return { kind: "unavailable", reason: primary };
  }
}
