import http from "node:http";
import path from "node:path";
import {
  activateVerifiedBrowserArtifact,
  prepareVerifiedBrowserRelease,
  type BrowserPackageRelease,
} from "./browser-provider.js";
import { loadVerifiedManagedBrowserReceipt, type ManagedBrowserReceipt } from "./browser-managed.js";

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
