import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isContainedIn } from "./fsx.js";
import { lookPath, runDetectedBin } from "./detect.js";

let cachedToken: string | null | undefined;
let ghTokenFailed = false;

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
    // gh está pero no dio token (sesión caducada, sin login, timeout): el
    // hint de rate limit debe distinguirlo de "no hay gh".
    ghTokenFailed = true;
  }
  return (cachedToken = null);
}

/** true si gh CLI está instalado pero `gh auth token` no devolvió credencial. */
export function ghPresentButTokenFailed(): boolean {
  return ghTokenFailed;
}

/** SOLO para tests: resetea el estado de módulo (token cacheado y flags). */
export function __resetGithubState(): void {
  cachedToken = undefined;
  ghTokenFailed = false;
  rateLimitHit = false;
}

function authHeaders(): Record<string, string> {
  const token = githubToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let rateLimitHit = false;

/** true si alguna consulta devolvió 403/429 — GitHub está limitando las peticiones. */
export function githubRateLimited(): boolean {
  return rateLimitHit;
}

/** Cabeceras base para llamadas a api.github.com. */
function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "jorgex-stack",
    ...authHeaders(),
  };
}

/**
 * Devuelve la versión del último release publicado en un repo de GitHub,
 * sin el prefijo "v". Retorna null si falla la red o el repo no tiene releases.
 */
export async function latestGithubRelease(repo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) rateLimitHit = true;
      return null;
    }
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

/**
 * Devuelve el SHA del commit más reciente en el branch por defecto.
 * Retorna null si falla la red.
 */
export async function latestGithubCommit(repo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) rateLimitHit = true;
      return null;
    }
    const data = (await res.json()) as { sha?: string }[];
    return data[0]?.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Valida el árbol extraído en destDir: rechaza symlinks y rutas que escapen del dir.
 * Exportada para tests unitarios. Fail-closed: devuelve false ante cualquier problema.
 */
export function validateExtractedTree(destDir: string): boolean {
  const resolved = path.resolve(destDir);
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Rechazar symlinks (primitiva de exfiltración / zip-slip).
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      // Rechazar rutas que escapen de destDir.
      if (!isContainedIn(full, resolved)) return false;
      if (entry.isDirectory()) {
        if (!walk(full)) return false;
      }
    }
    return true;
  };
  return walk(resolved);
}

export type TarballResult = { ok: true; validated: boolean } | { ok: false; reason: string };

/**
 * Resuelve el ejecutable tar según la plataforma.
 * En Windows con Git-MSYS instalado, "tar" del PATH interpreta "C:" como hostname
 * de red y falla con rutas Windows nativas. System32 contiene bsdtar (Windows 10+)
 * que sí acepta esas rutas. Si no existe, fallback a "tar" del PATH.
 * Linux/macOS → "tar" directamente.
 */
function resolveTarBin(): string {
  if (process.platform !== "win32") return "tar";
  const winTar = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(winTar) ? winTar : "tar";
}

/**
 * Descarga el tarball de un repo en el SHA indicado y lo extrae en destDir.
 * El cuerpo se hace streaming a disco (los tarballs de monorepos como vercel/ai
 * pesan decenas de MB) con timeout de 120s. Usa `tar -xzf --strip-components=1`
 * (bsdtar de System32 en Windows, tar nativo en Linux/macOS) y valida el árbol extraído
 * (symlinks, path-escape). Con `validateSubdir`, la validación se limita al
 * subárbol que el caller va a consumir: un monorepo puede llevar symlinks
 * legítimos en zonas que nunca se leen (vercel/ai los tiene) y rechazar el
 * tarball entero sería un falso positivo. Si el subdir no existe, se omite la
 * validación (el caller decide qué hacer con un path ausente). En ese caso
 * el resultado incluye `validated: false`. Si el subdir existe y pasa la
 * validación, devuelve `validated: true`. Fail-closed: cualquier error limpia
 * destDir y devuelve { ok: false, reason }.
 */
export async function downloadRepoTarball(
  repo: string,
  sha: string,
  destDir: string,
  validateSubdir?: string,
): Promise<TarballResult> {
  const url = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
  const tmp = path.join(os.tmpdir(), `jorgex-tarball-${Date.now()}.tar.gz`);
  const fail = (reason: string): TarballResult => {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignorar */ }
    return { ok: false, reason };
  };

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "jorgex-stack", ...authHeaders() },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) rateLimitHit = true;
      return fail(
        `HTTP ${res.status}${res.status === 403 || res.status === 429 ? " — rate limit; define GH_TOKEN o inicia sesión en gh" : ""}`,
      );
    }
    if (!res.body) return fail("respuesta HTTP sin cuerpo");

    // Streaming a disco — nunca el tarball entero en memoria.
    await pipeline(
      Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
      fs.createWriteStream(tmp),
    );

    // Prepara destDir limpio.
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    // Extrae con tar (strip-components elimina el prefijo repo-sha/).
    // bsdtar/tar resuelto por resolveTarBin() según la plataforma.
    try {
      execFileSync(resolveTarBin(), ["-xzf", tmp, "--strip-components=1", "-C", destDir], { stdio: "pipe" });
    } catch (err) {
      // "tar ausente" y "tarball corrupto" exigen acciones opuestas: dar la causa.
      const e = err as { stderr?: Buffer | string; message?: string };
      const detail = (e.stderr?.toString().trim() || e.message || "").split("\n")[0];
      return fail(detail ? `tar falló: ${detail}` : "tar no disponible o falló la extracción");
    }

    // Validación post-extracción: symlinks y rutas que escapen del árbol consumido.
    const resolvedDest = path.resolve(destDir);
    const validateRoot = validateSubdir ? path.resolve(resolvedDest, validateSubdir) : resolvedDest;
    // "." o "" resuelven al propio destDir → validar todo, no es escape.
    if (validateRoot !== resolvedDest && !isContainedIn(validateRoot, resolvedDest)) {
      return fail(`la ruta de validación "${validateSubdir}" escapa del destino`);
    }
    if (fs.existsSync(validateRoot) && !validateExtractedTree(validateRoot)) {
      return fail("el árbol extraído contiene symlinks o rutas fuera del destino");
    }
    // validated: true si validateRoot pasó validación, false si no existe (nada que validar).
    const validated = fs.existsSync(validateRoot);

    return { ok: true, validated };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail(timedOut ? "timeout de descarga (120s)" : err instanceof Error ? `fallo de red: ${err.message}` : "error desconocido");
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignorar */ }
  }
}
