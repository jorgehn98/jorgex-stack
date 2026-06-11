import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { isContainedIn } from "./fsx.js";

/** Header Authorization Bearer si el usuario tiene GH_TOKEN o GITHUB_TOKEN en el entorno. */
function authHeaders(): Record<string, string> {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
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
    if (!res.ok) return null;
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
    if (!res.ok) return null;
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

/**
 * Descarga el tarball de un repo en el SHA indicado y lo extrae en destDir.
 * Usa `tar -xzf --strip-components=1` (tar nativo; en Windows es GNU tar de MSYS).
 * Tras extraer, valida el árbol (symlinks, path-escape); si falla, limpia y devuelve false.
 * Fail-closed: cualquier error limpia destDir y devuelve false.
 */
export async function downloadRepoTarball(repo: string, sha: string, destDir: string): Promise<boolean> {
  const url = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
  const tmp = path.join(os.tmpdir(), `jorgex-tarball-${Date.now()}.tar.gz`);

  try {
    // Descarga a archivo temporal.
    const res = await fetch(url, {
      headers: { "User-Agent": "jorgex-stack", ...authHeaders() },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return false;

    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmp, buf);

    // Prepara destDir limpio.
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    // Extrae con tar nativo (strip-components elimina el prefijo repo-sha/).
    execFileSync("tar", ["-xzf", tmp, "--strip-components=1", "-C", destDir], { stdio: "pipe" });

    // Validación post-extracción: symlinks y rutas que escapen de destDir.
    if (!validateExtractedTree(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return false;
    }

    return true;
  } catch {
    // Limpia restos parciales.
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignorar */ }
    return false;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignorar */ }
  }
}
