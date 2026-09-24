import { downloadVerifiedNpmPackageTarball, isStableSemverVersion, resolveLatestNpmPackageRelease } from "./npm-provider.js";

export interface PiReleaseCandidate {
  version: string;
  tarballUrl: string;
  integrity: string;
}

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;


function fail(message: string): never {
  throw new Error(`pi-release-resolver: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/**
 * T06 acquisition tracer: fetch the exact release tarball, verify SHA-512
 * SRI before publishing, and publish race-free without ever overwriting a
 * preexisting destination. No install, receipt, or staging (T07 owns it).
 *
 * Thin wrapper over the generic npm provider; maps provider errors to the
 * prior `pi-release-resolver:` prefix.
 */
export async function downloadVerifiedPiTarball(
  release: PiReleaseCandidate,
  destination: string,
  fetchImpl: typeof fetch,
): Promise<PiTarballArtifact> {
  try {
    return await downloadVerifiedNpmPackageTarball("jorgex-pi", release, destination, fetchImpl);
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
  if (!isStableSemverVersion(version)) fail("invalid producer version");
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
