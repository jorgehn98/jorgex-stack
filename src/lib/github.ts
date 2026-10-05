import fs from "node:fs";
import path from "node:path";
import { lookPath, runDetectedBin } from "./detect.js";

let cachedToken: string | null | undefined;

/**
 * Token de GitHub para subir el rate limit (sin auth: 60/h + límite de ráfaga
 * que tumba consultas en paralelo). Orden: GH_TOKEN/GITHUB_TOKEN del entorno →
 * `gh auth token` si el CLI de GitHub está autenticado. Cacheado por proceso;
 * solo viaja en el header Authorization — nunca se loguea ni se persiste.
 */
function githubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const env = process.env["GH_TOKEN"]?.trim() || process.env["GITHUB_TOKEN"]?.trim();
  if (env) return (cachedToken = env);
  const gh = lookPath("gh");
  if (gh) {
    const fromGh = runDetectedBin(gh, ["auth", "token"], 5_000)?.trim();
    if (fromGh) return (cachedToken = fromGh);
  }
  return (cachedToken = null);
}

/** SOLO para tests: resetea el estado de módulo (token cacheado y flags). */
export function __resetGithubState(): void {
  cachedToken = undefined;
}

function authHeaders(): Record<string, string> {
  const token = githubToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Cabeceras base para llamadas a api.github.com. */
function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "jorgex-stack",
    ...authHeaders(),
  };
}

/** Repo oficial del binario Engram. */
export const ENGRAM_REPO = "Gentleman-Programming/engram";

/** Endpoint `latest`: GitHub excludes drafts and prereleases; the caller validates the tag format. */
export const ENGRAM_RELEASES_LATEST_URL = `https://api.github.com/repos/${ENGRAM_REPO}/releases/latest`;

/** Prefijo oficial de descargas del release Engram. */
export const ENGRAM_DOWNLOAD_PREFIX = `https://github.com/${ENGRAM_REPO}/releases/download/`;

/**
 * Nombre exacto del asset Engram para versión + plataforma + arquitectura.
 * Retorna null ante plataforma o arquitectura no soportada.
 */
export function expectedEngramAssetName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const osPart =
    platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  const archPart = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (osPart === null || archPart === null) return null;
  const ext = osPart === "windows" ? "zip" : "tar.gz";
  return `engram_${version}_${osPart}_${archPart}.${ext}`;
}

/**
 * Obtiene el `releases/latest` de un repo con las cabeceras GitHub del CLI.
 * GitHub excluye drafts y prereleases de este endpoint.
 * Returns the response and lets network errors reach the caller.
 */
export async function fetchLatestGithubRelease(
  repo: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  return res;
}

/**
 * Resuelve el ejecutable tar según la plataforma.
 * En Windows con Git-MSYS instalado, "tar" del PATH interpreta "C:" como hostname
 * de red y falla con rutas Windows nativas. System32 contiene bsdtar (Windows 10+)
 * que sí acepta esas rutas. Si no existe, fallback a "tar" del PATH.
 * Linux/macOS → "tar" directamente.
 * Exportada para tests (permite verificar la rama de fallback sin un Windows real).
 */
export function resolveTarBin(): string {
  if (process.platform !== "win32") return "tar";
  const winTar = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(winTar) ? winTar : "tar";
}
