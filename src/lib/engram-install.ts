import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ENGRAM_DOWNLOAD_PREFIX,
  ENGRAM_REPO,
  expectedEngramAssetName,
  fetchLatestGithubRelease,
} from "./github.js";
import { resolveTarBin } from "./github.js";

export interface EngramInstallOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof globalThis.fetch;
}

export type EngramInstallResult =
  | { ok: true; bin: string; warning?: string }
  | { ok: false; reason: string };

/** Límite duro para el tamaño del asset aprobado antes de descargarlo. */
export const MAX_ENGRAM_ARCHIVE_BYTES = 64 * 1024 * 1024;

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

interface LiveAsset {
  name: unknown;
  size: unknown;
  state: unknown;
  browser_download_url: unknown;
  digest: unknown;
}

/** Installs only a missing binary; existing installations and Engram data are never replaced. */
export async function installMissingEngram(options: EngramInstallOptions = {}): Promise<EngramInstallResult> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  if (!path.isAbsolute(homeDir)) return { ok: false, reason: "El directorio personal debe ser absoluto." };
  const binaryName = platform === "win32" ? "engram.exe" : "engram";
  const bin = path.join(homeDir, ".local", "bin", binaryName);
  let staging: string | undefined;
  let outcome: EngramInstallResult | undefined;
  try {
    const existing = fs.lstatSync(bin, { throwIfNoEntry: false });
    if (existing) {
      if (!fs.statSync(bin).isFile()) throw new Error(`El destino Engram no es un archivo: ${bin}`);
      fs.accessSync(bin, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      outcome = { ok: true, bin };
    } else {
      const fetchFn = options.fetch ?? globalThis.fetch;
      let releaseRes: Response;
      try {
        releaseRes = await fetchLatestGithubRelease(ENGRAM_REPO, fetchFn);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Engram: error de red al consultar los metadatos del release (latest): ${cause}. Reintenta la instalación.`,
        );
      }
      if (!releaseRes.ok) {
        if (releaseRes.status === 429) {
          throw new Error(
            "Engram: metadatos del release no disponibles (HTTP 429 rate limit en la consulta latest/metadatos). " +
              "Espera y reintenta; define GH_TOKEN o inicia sesión con gh auth login para elevar el límite.",
          );
        }
        if (releaseRes.status === 403) {
          throw new Error(
            "Engram: metadatos del release no disponibles (HTTP 403 en la consulta latest/metadatos). " +
              "Posible rate limit o falta de autenticación; define GH_TOKEN o usa gh auth login y reintenta.",
          );
        }
        throw new Error(
          `Engram: metadatos del release no disponibles (HTTP ${releaseRes.status} en la consulta latest).`,
        );
      }
      let raw: unknown;
      try {
        raw = (await releaseRes.json()) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error("Engram: metadatos del release inválidos: JSON no parseable.");
        }
        const cause = error instanceof Error ? error.message : String(error);
        const hint = error instanceof Error && error.name === "AbortError" ? "interrumpida (red/cancelada)" : "de red";
        throw new Error(
          `Engram: lectura de metadatos del release ${hint}: ${cause}. Reintenta la instalación.`,
        );
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Engram: metadatos del release inválidos: se esperaba un objeto JSON.");
      }
      const releaseJson = raw as { tag_name?: unknown; assets?: unknown };
      const tag = releaseJson.tag_name;
      if (typeof tag !== "string" || !STABLE_TAG.test(tag)) {
        throw new Error(`Engram: tag del release inválido: ${String(tag)}.`);
      }
      const version = tag.slice(1);
      const expectedName = expectedEngramAssetName(version, platform, options.arch ?? process.arch);
      if (expectedName === null) {
        throw new Error(`Engram no dispone de un binario aprobado para ${platform}_${options.arch ?? process.arch}.`);
      }
      if (!Array.isArray(releaseJson.assets)) throw new Error("Engram: metadatos del release sin assets.");
      // La metadata del release aporta identidad y digest; no existe pin estático.
      const matches = (releaseJson.assets as LiveAsset[]).filter((asset) => asset?.name === expectedName);
      if (matches.length !== 1) throw new Error("Engram: asset exacto ausente o ambiguo en el release.");
      const asset = matches[0]!;
      if (asset.state !== "uploaded") throw new Error("Engram: asset no publicado.");
      if (!Number.isInteger(asset.size) || (asset.size as number) <= 0) {
        throw new Error("Engram: tamaño del asset inválido.");
      }
      const expectedUrl = `${ENGRAM_DOWNLOAD_PREFIX}${tag}/${expectedName}`;
      if (typeof asset.browser_download_url !== "string" || asset.browser_download_url !== expectedUrl) {
        throw new Error("Engram: URL del asset no oficial.");
      }
      if (typeof asset.digest !== "string" || !DIGEST_RE.test(asset.digest)) {
        throw new Error("Engram: digest del asset inválido.");
      }
      const approvedSize = asset.size as number;
      if (approvedSize > MAX_ENGRAM_ARCHIVE_BYTES) {
        throw new Error(
          `Engram: tamaño del asset aprobado (${approvedSize} bytes) excede el límite de 64 MiB (${MAX_ENGRAM_ARCHIVE_BYTES} bytes).`,
        );
      }
      const approvedSha = (asset.digest as string).slice("sha256:".length);
      const response = await fetchFn(asset.browser_download_url as string, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error(`Descarga Engram fallida: HTTP ${response.status}.`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let readError: unknown;
      try {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > approvedSize) throw new Error("El tamaño descargado de Engram supera el aprobado.");
            chunks.push(chunk.value);
          }
        } catch (error) {
          readError = error;
          throw error;
        }
      } finally {
        // Cancelar siempre para liberar el stream tras una descarga interrumpida.
        try {
          await reader.cancel();
        } catch (cancelError) {
          const cancelMsg = cancelError instanceof Error ? cancelError.message : String(cancelError);
          if (readError !== undefined) {
            const primaryMsg = readError instanceof Error ? readError.message : String(readError);
            throw new Error(`${primaryMsg} (además falló la cancelación del stream: ${cancelMsg})`);
          }
          throw cancelError;
        }
      }
      const archive = Buffer.concat(chunks);
      if (size !== approvedSize || createHash("sha256").update(archive).digest("hex") !== approvedSha) {
        throw new Error("Engram: tamaño o hash SHA-256 no coincide con el artefacto aprobado.");
      }
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      staging = fs.mkdtempSync(path.join(path.dirname(bin), ".engram-install-"));
      const archivePath = path.join(staging, expectedName);
      fs.writeFileSync(archivePath, archive, { flag: "wx", mode: 0o600 });
      // Extraer solo el miembro binario literal; nunca desplegar rutas del archive.
      const binary = execFileSync(resolveTarBin(), ["-xOf", archivePath, binaryName], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (binary.length === 0) throw new Error("El artefacto Engram no contiene un binario válido.");
      const stagedBin = path.join(staging, binaryName);
      fs.writeFileSync(stagedBin, binary, { flag: "wx", mode: 0o755 });
      // El hard link publica bytes completos de forma atómica y falla si otro installer ganó la carrera.
      fs.linkSync(stagedBin, bin);
      outcome = { ok: true, bin };
    }
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (staging !== undefined) {
    // Tras publicar el binario, un fallo de limpieza queda como warning accionable.
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      const cleanupMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (outcome !== undefined && outcome.ok) {
        outcome = {
          ok: true,
          bin: outcome.bin,
          warning: `Limpieza del directorio temporal ${staging} fallida tras instalar Engram: ${cleanupMsg}. El binario quedó instalado en ${outcome.bin}.`,
        };
      } else if (outcome !== undefined && !outcome.ok) {
        outcome = { ok: false, reason: `${outcome.reason} (además falló la limpieza temporal: ${cleanupMsg})` };
      }
    }
  }
  return outcome ?? { ok: false, reason: "Engram: instalación finalizó sin resultado verificable." };
}
