import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveLatestNpmPackageRelease } from "./npm-provider.js";

export interface PiReleaseCandidate {
  version: string;
  tarballUrl: string;
  integrity: string;
}

const REGISTRY_HOST = "registry.npmjs.org";
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message: string): never {
  throw new Error(`pi-release-resolver: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) fail("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Fail closed at exactly MAX (not MAX+1): any further byte would
      // overflow, and cancelling here — without dequeuing another chunk —
      // guarantees the source is never drained past MAX + one chunk.
      if (total >= MAX_METADATA_BYTES) {
        await reader.cancel().catch(() => {});
        fail("metadata exceeds 4 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function assertCanonicalIntegrity(integrity: unknown): asserts integrity is string {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail("invalid integrity (expected canonical sha512 SRI)");
  }
  const b64 = (integrity as string).slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail("invalid integrity (expected canonical sha512 SRI)");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    fail("invalid integrity (expected canonical sha512 SRI)");
  }
  if (bytes.length !== 64 || bytes.toString("base64") !== b64) {
    fail("invalid integrity (expected canonical sha512 SRI)");
  }
}

/**
 * T06 tracer: resolve the exact stable `dist-tags.latest` candidate from the
 * official npm packument. Metadata only — no download, install, or staging.
 * Thin wrapper over the generic npm provider; maps provider errors to the
 * prior `pi-release-resolver:` prefix.
 */
export async function resolveLatestPiRelease(
  fetchImpl: typeof fetch,
): Promise<PiReleaseCandidate> {
  try {
    return await resolveLatestNpmPackageRelease("jorgex-pi", fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-release-resolver: ")) throw error;
    if (error instanceof Error) {
      const detail = error.message.startsWith("npm-provider: ")
        ? error.message.slice("npm-provider: ".length)
        : error.message;
      throw new Error(`pi-release-resolver: ${detail}`);
    }
    throw new Error(`pi-release-resolver: ${String(error)}`);
  }
}

export interface PiTarballArtifact {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
}

// Tracer bound: covers the verified historical jorgex-pi@0.8.24 artifact
// (89,140,631 bytes) with headroom while still capping unbounded streams.
// T07 owns staging/activation.
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const TARBALL_FETCH_TIMEOUT_MS = 120_000;

function expectedSha512Digest(integrity: unknown): Buffer {
  assertCanonicalIntegrity(integrity);
  return Buffer.from(integrity.slice("sha512-".length), "base64");
}

function assertCanonicalReleaseInput(release: unknown): {
  tarballUrl: string;
  expectedSha512: Buffer;
} {
  if (!isRecord(release)) fail("invalid release");
  const { version, tarballUrl, integrity } = release;
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) fail("invalid release version");
  if (typeof tarballUrl !== "string") fail("foreign tarball URL");
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl);
  } catch {
    fail("foreign tarball URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== REGISTRY_HOST ||
    tarballUrl !== canonicalTarballUrl(version)
  ) {
    fail("foreign tarball URL");
  }
  return { tarballUrl, expectedSha512: expectedSha512Digest(integrity) };
}

function readExistingArtifact(file: string): { bytes: number; sha256: string; sha512: string } | null {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (!stat.isFile()) fail("destination is not a regular file");
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    fail("cannot read existing destination");
  }
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes >= MAX_TARBALL_BYTES) fail("existing destination exceeds tarball bound");
      sha256.update(buffer.subarray(0, read));
      sha512.update(buffer.subarray(0, read));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors on a read-only descriptor.
    }
  }
  return { bytes, sha256: sha256.digest("hex"), sha512: sha512.digest("hex") };
}

/**
 * T06 acquisition tracer: fetch the exact release tarball, verify SHA-512
 * SRI before publishing, and publish race-free without ever overwriting a
 * preexisting destination. No install, receipt, or staging (T07 owns it).
 */
export async function downloadVerifiedPiTarball(
  release: PiReleaseCandidate,
  destination: string,
  fetchImpl: typeof fetch,
): Promise<PiTarballArtifact> {
  const { tarballUrl, expectedSha512 } = assertCanonicalReleaseInput(release);
  if (typeof destination !== "string" || destination === "") fail("invalid destination");

  const existing = readExistingArtifact(destination);
  if (existing !== null) {
    const existing512 = Buffer.from(existing.sha512, "hex");
    if (existing512.length === expectedSha512.length && timingSafeEqual(existing512, expectedSha512)) {
      return { path: destination, bytes: existing.bytes, sha256: existing.sha256, sha512: existing.sha512 };
    }
    fail("destination bytes do not match requested integrity");
  }

  let response: Response;
  try {
    response = await fetchImpl(tarballUrl, {
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`tarball fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`tarball responded ${response.status}`);
  if (response.url !== tarballUrl) fail(`unexpected tarball response URL ${response.url}`);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const trimmed = declared.trim();
    if (!/^\d+$/.test(trimmed)) fail("invalid tarball content-length");
    if (Number(trimmed) > MAX_TARBALL_BYTES) fail("tarball exceeds 128 MiB");
  }
  if (response.body === null) fail("missing tarball body");

  const tempPath = path.join(
    path.dirname(destination),
    `jorgex-pi-partial-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let fd: number;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
  } catch {
    fail("cannot stage tarball temp");
  }
  let fdClosed = false;
  const closeFd = (): void => {
    if (fdClosed) return;
    fdClosed = true;
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors; unlink below still cleans the temp.
    }
  };
  const discardStaged = (): void => {
    closeFd();
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp removal; destination was never touched.
    }
  };

  try {
    const reader = response.body.getReader();
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        // Conservative early trigger: one more same-sized chunk would reach
        // the bound, so cancel now instead of dequeuing it. Detecting on the
        // dequeued chunk itself is too late — its dequeue already schedules
        // the next source pull ahead of cancellation, draining a full extra
        // chunk. This keeps the source under MAX + one chunk either way.
        if (bytes + value.byteLength >= MAX_TARBALL_BYTES) {
          await reader.cancel().catch(() => {});
          fail("tarball exceeds 128 MiB");
        }
        sha256.update(value);
        sha512.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          offset += fs.writeSync(fd, value, offset, value.byteLength - offset);
        }
      }
    } finally {
      reader.releaseLock();
    }
    closeFd();
    const actual512 = sha512.digest();
    if (!timingSafeEqual(actual512, expectedSha512)) fail("tarball integrity mismatch");
    try {
      // No-replace publish: link fails when destination exists, so a raced
      // install or a preexisting file is never overwritten. Same directory
      // means same device, so the link is atomic.
      fs.linkSync(tempPath, destination);
    } catch {
      fail("tarball publish raced with existing destination");
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Published; temp unlink is best-effort hygiene only.
    }
    return { path: destination, bytes, sha256: sha256.digest("hex"), sha512: actual512.toString("hex") };
  } catch (error) {
    discardStaged();
    if (error instanceof Error && error.message.startsWith("pi-release-resolver: ")) throw error;
    fail(`tarball download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const PRODUCER_REF_API = "https://api.github.com/repos/jorgehn98/jorgex-pi/git/ref/tags";
const PRODUCER_ACCEPT = "application/vnd.github+json";
const SHA40_HEX = /^[0-9a-f]{40}$/;

function producerTagUrl(version: string): string {
  return `${PRODUCER_REF_API}/v${version}`;
}

/**
 * T06 provenance tracer: INFORMATIONAL producer tag commit for the exact
 * stable version, read from the official public GitHub ref API. A lightweight
 * tag pointing at a commit is the only accepted shape; annotated tags resolve
 * to a tag object and fail closed. The result feeds `provenance.commit` as
 * context only — never as an integrity attestation, never a static fallback.
 */
export async function resolvePiProducerCommit(
  version: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) fail("invalid producer version");
  const url = producerTagUrl(version);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: PRODUCER_ACCEPT },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`producer ref fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`producer ref responded ${response.status}`);
  if (response.url !== url) fail(`unexpected producer ref response URL ${response.url}`);
  const text = await readBoundedText(response);
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    fail("malformed producer ref JSON");
  }
  if (!isRecord(data) || data["ref"] !== `refs/tags/v${version}`) fail("producer ref mismatch");
  const object = data["object"];
  if (!isRecord(object) || object["type"] !== "commit") fail("producer ref is not a lightweight tag commit");
  const sha = object["sha"];
  if (typeof sha !== "string" || !SHA40_HEX.test(sha)) fail("invalid producer commit sha");
  return sha;
}
