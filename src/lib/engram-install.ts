import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import release from "./engram-release.json" with { type: "json" };
import { resolveTarBin } from "./github.js";

export interface EngramInstallOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof globalThis.fetch;
}

export type EngramInstallResult = { ok: true; bin: string } | { ok: false; reason: string };

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
    const key = `${platform === "win32" ? "windows" : platform}_${options.arch ?? process.arch}`;
    const asset = release.assets[key as keyof typeof release.assets];
    if (!asset) throw new Error(`Engram no dispone de un binario aprobado para ${key}.`);
    const response = await (options.fetch ?? globalThis.fetch)(
      `https://github.com/Gentleman-Programming/engram/releases/download/v${release.version}/${asset.name}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok || !response.body) throw new Error(`Descarga Engram fallida: HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > asset.size) throw new Error("El tamaño descargado de Engram supera el aprobado.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const archive = Buffer.concat(chunks);
    if (size !== asset.size || createHash("sha256").update(archive).digest("hex") !== asset.sha256) {
      throw new Error("Engram: tamaño o hash SHA-256 no coincide con el artefacto aprobado.");
    }
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    staging = fs.mkdtempSync(path.join(path.dirname(bin), ".engram-install-"));
    const archivePath = path.join(staging, asset.name);
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
