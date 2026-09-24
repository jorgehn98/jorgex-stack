export interface NpmPackageRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

const REGISTRY_HOST = "registry.npmjs.org";
const ACCEPT = "application/vnd.npm.install-v1+json";
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function fail(message: string): never {
  throw new Error(`npm-provider: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registryUrl(packageName: string): string {
  return `https://${REGISTRY_HOST}/${packageName}`;
}

function canonicalTarballUrl(packageName: string, version: string): string {
  const shortName = packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
  return `https://${REGISTRY_HOST}/${packageName}/-/${shortName}-${version}.tgz`;
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
 * Generic npm packument resolver for opt-in provider packages (for example
 * `@playwright/cli` and `chrome-devtools-mcp`). Metadata only — no download,
 * install, or staging. Selects the exact stable `dist-tags.latest` candidate
 * with the official canonical tarball URL and canonical `sha512-` SRI.
 */
export async function resolveLatestNpmPackageRelease(
  packageName: string,
  fetchImpl: typeof fetch,
): Promise<NpmPackageRelease> {
  if (typeof packageName !== "string" || !PACKAGE_NAME.test(packageName)) {
    fail("invalid package name");
  }
  const url = registryUrl(packageName);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: ACCEPT },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`registry fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`registry responded ${response.status}`);
  if (response.url !== url) fail(`unexpected response URL ${response.url}`);

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const trimmed = lengthHeader.trim();
    if (!/^\d+$/.test(trimmed)) fail("invalid content-length");
    if (Number(trimmed) > MAX_METADATA_BYTES) fail("metadata exceeds 4 MiB");
  }
  const text = await readBoundedText(response);

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    fail("malformed packument JSON");
  }
  if (!isRecord(data) || data["name"] !== packageName) fail("malformed packument name");

  const tags = data["dist-tags"];
  if (!isRecord(tags) || typeof tags["latest"] !== "string") fail("missing dist-tags.latest");
  const latest = tags["latest"] as string;
  if (!STABLE_SEMVER.test(latest)) fail(`unstable or malformed version ${latest}`);

  const versions = data["versions"];
  if (!isRecord(versions)) fail("missing versions map");
  const entry = versions[latest];
  if (!isRecord(entry)) fail(`missing versions[${latest}]`);
  if (entry["name"] !== packageName || entry["version"] !== latest) {
    fail("version mismatch in versions entry");
  }
  if (entry["deprecated"] !== undefined) fail(`version ${latest} is deprecated`);

  const dist = entry["dist"];
  if (!isRecord(dist)) fail("missing dist");
  const { tarball, integrity } = dist;
  if (typeof tarball !== "string" || typeof integrity !== "string") {
    fail("missing dist.tarball/integrity");
  }

  let parsed: URL;
  try {
    parsed = new URL(tarball);
  } catch {
    fail("foreign tarball URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== REGISTRY_HOST ||
    tarball !== canonicalTarballUrl(packageName, latest)
  ) {
    fail("foreign tarball URL");
  }

  assertCanonicalIntegrity(integrity);

  return { version: latest, tarballUrl: tarball, integrity };
}
