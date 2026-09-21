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

export type EngramInstallResult = { ok: true; bin: string } | { ok: false; reason: string };

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
  try {
    const existing = fs.lstatSync(bin, { throwIfNoEntry: false });
    if (existing) {
      if (!fs.statSync(bin).isFile()) throw new Error(`El destino Engram no es un archivo: ${bin}`);
      fs.accessSync(bin, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return { ok: true, bin };
    }
    const fetchFn = options.fetch ?? globalThis.fetch;
    const releaseRes = await fetchLatestGithubRelease(ENGRAM_REPO, fetchFn);
    if (!releaseRes.ok) throw new Error(`Descarga Engram fallida: HTTP ${releaseRes.status}.`);
    let releaseJson: { tag_name?: unknown; assets?: unknown };
    try {
      releaseJson = (await releaseRes.json()) as { tag_name?: unknown; assets?: unknown };
    } catch {
      throw new Error("Engram: metadatos del release inválidos.");
    }
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
    // GitHub release metadata is the integrity authority; no static asset pin is used.
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
    const approvedSha = (asset.digest as string).slice("sha256:".length);
    const response = await fetchFn(asset.browser_download_url as string, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`Descarga Engram fallida: HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > approvedSize) throw new Error("El tamaño descargado de Engram supera el aprobado.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const archive = Buffer.concat(chunks);
    if (size !== approvedSize || createHash("sha256").update(archive).digest("hex") !== approvedSha) {
      throw new Error("Engram: tamaño o hash SHA-256 no coincide con el artefacto aprobado.");
    }
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    staging = fs.mkdtempSync(path.join(path.dirname(bin), ".engram-install-"));
    const archivePath = path.join(staging, expectedName);
    fs.writeFileSync(archivePath, archive, { flag: "wx", mode: 0o600 });
    // Stream only the literal binary member; archive paths are never extracted to the user's filesystem.
    const binary = execFileSync(resolveTarBin(), ["-xOf", archivePath, binaryName], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (binary.length === 0) throw new Error("El artefacto Engram no contiene un binario válido.");
    const stagedBin = path.join(staging, binaryName);
    fs.writeFileSync(stagedBin, binary, { flag: "wx", mode: 0o755 });
    // A hard link publishes complete bytes atomically and fails if another installer won the race.
    fs.linkSync(stagedBin, bin);
    return { ok: true, bin };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}
