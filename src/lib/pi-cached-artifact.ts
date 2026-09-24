import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isStableSemverVersion } from "./npm-provider.js";

export interface VerifyCachedPiArtifactInput {
  receipt: unknown;
  homeDir: unknown;
  downloadsDir: unknown;
}

const PACKAGE_NAME = "jorgex-pi";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function equalHex(aHex: string, bHex: string): boolean {
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(aHex, "hex");
    b = Buffer.from(bHex, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * T07 offline cached-artifact helper: verify cached tgz bytes against a
 * locally coherent schemaVersion 1 managed receipt. Pure offline filesystem
 * callback (no network, no repair, no HOME access beyond the provided
 * isolated boundary). Returns false on any drift or filesystem error.
 *
 * Explicit limit: a coherent local receipt under the same account can mimic
 * a managed install; this only proves cached bytes match the receipt, not
 * cryptographic ownership of the raw receipt. The caller must have
 * authenticated manifest/link etc. separately.
 */
export function verifyCachedPiArtifact(input: VerifyCachedPiArtifactInput): boolean {
  try {
    if (!isRecord(input)) return false;
    const { receipt, homeDir, downloadsDir } = input as Record<string, unknown>;

    if (typeof homeDir !== "string" || homeDir === "" || !path.isAbsolute(homeDir)) return false;
    if (typeof downloadsDir !== "string" || downloadsDir === "" || !path.isAbsolute(downloadsDir)) {
      return false;
    }
    const homeResolved = path.resolve(homeDir);
    const downloadsResolved = path.resolve(downloadsDir);

    const homeStat = lstatOrNull(homeResolved);
    if (homeStat === null || !homeStat.isDirectory() || homeStat.isSymbolicLink()) return false;
    const downloadsStat = lstatOrNull(downloadsResolved);
    if (downloadsStat === null || !downloadsStat.isDirectory() || downloadsStat.isSymbolicLink()) {
      return false;
    }
    if (!isStrictChild(downloadsResolved, homeResolved)) return false;

    const rel = path.relative(homeResolved, downloadsResolved);
    const parts = rel.split(path.sep);
    let cursor = homeResolved;
    for (const part of parts) {
      if (part === "" || part === "." || part === "..") return false;
      cursor = path.join(cursor, part);
      const st = lstatOrNull(cursor);
      if (st === null || !st.isDirectory() || st.isSymbolicLink()) return false;
    }

    if (!isRecord(receipt)) return false;
    if (receipt["schemaVersion"] !== 1) return false;
    if (!isRecord(receipt["managedPackage"])) return false;
    const candidate = receipt["candidate"];
    if (!isRecord(candidate)) return false;
    const pkg = candidate["package"];
    if (!isRecord(pkg)) return false;
    if (pkg["name"] !== PACKAGE_NAME) return false;
    const version = pkg["version"];
    if (!isStableSemverVersion(version)) return false;
    if (pkg["source"] !== `npm:${PACKAGE_NAME}@${version}`) return false;
    const tarball = candidate["tarball"];
    if (!isRecord(tarball)) return false;
    const bytes = tarball["bytes"];
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > MAX_TARBALL_BYTES) {
      return false;
    }
    const sha256 = tarball["sha256"];
    const sha512 = tarball["sha512"];
    if (typeof sha256 !== "string" || !HEX64.test(sha256)) return false;
    if (typeof sha512 !== "string" || !HEX128.test(sha512)) return false;

    const fileName = `${PACKAGE_NAME}-${version}.tgz`;
    const target = path.join(downloadsResolved, fileName);
    if (path.dirname(target) !== downloadsResolved) return false;

    const st = lstatOrNull(target);
    if (st === null) return false;
    if (st.isSymbolicLink()) return false;
    if (!st.isFile()) return false;
    if (st.size !== bytes) return false;
    if (st.size > MAX_TARBALL_BYTES) return false;

    let fd: number;
    try {
      fd = fs.openSync(target, "r");
    } catch {
      return false;
    }
    const sha256Hash = createHash("sha256");
    const sha512Hash = createHash("sha512");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    try {
      for (;;) {
        let read: number;
        try {
          read = fs.readSync(fd, buffer, 0, buffer.length, null);
        } catch {
          return false;
        }
        if (read === 0) break;
        total += read;
        if (total > MAX_TARBALL_BYTES) return false;
        sha256Hash.update(buffer.subarray(0, read));
        sha512Hash.update(buffer.subarray(0, read));
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors on a read-only descriptor.
      }
    }
    if (total !== bytes) return false;

    const actual256 = sha256Hash.digest("hex");
    const actual512 = sha512Hash.digest("hex");
    if (!equalHex(actual256, sha256)) return false;
    if (!equalHex(actual512, sha512)) return false;
    return true;
  } catch {
    return false;
  }
}
