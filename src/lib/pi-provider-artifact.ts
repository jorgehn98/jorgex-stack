import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  isCanonicalSha512Integrity,
  isStableSemverVersion,
  type NpmPackageRelease,
  type NpmTarballArtifact,
} from "./npm-provider.js";

const PROVIDER_PACKAGE_NAME = "gentle-engram";
const UPSTREAM_PR = 1567;
const UPSTREAM_COMMIT = "5455dc245044589445e7d7a83fdff8c84dfb9689";
const TYPEBOX_PIN = "^1.1.38";
const MANIFEST_ENTRY = "package/package.json";
const PACKAGE_PREFIX = "package/";
const REGISTRY_HOST = "registry.npmjs.org";
// Closed ceiling for this provider (Spec T02): ~1 MiB / ~1.3 MiB / 1672 bytes
// observed. Exceeding any cap must block, never fall back to another artifact.
const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_TAR_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const TAR_BLOCK = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export interface DerivedProviderArtifactInput {
  readonly packageName: string;
  readonly release: NpmPackageRelease;
  readonly official: NpmTarballArtifact;
  readonly destination: string;
}

export interface DerivedProviderOriginalEvidence {
  readonly integrity: string;
  readonly sha256: string;
  readonly sha512: string;
  readonly bytes: number;
  readonly manifestSha256: string;
  /** Original `package/package.json` payload, bounded and base64-encoded. */
  readonly manifestBase64: string;
}

export interface DerivedProviderDerivedArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sha512: string;
  readonly integrity: string;
  readonly manifestSha256: string;
}

export type DerivedProviderArtifactEvidence =
  | {
      readonly origin: "registry";
      readonly packageName: string;
      readonly version: string;
      readonly upstreamPr: number;
      readonly upstreamCommit: string;
      readonly original: DerivedProviderOriginalEvidence;
      readonly derived?: undefined;
    }
  | {
      readonly origin: "derived";
      readonly packageName: string;
      readonly version: string;
      readonly upstreamPr: number;
      readonly upstreamCommit: string;
      readonly original: DerivedProviderOriginalEvidence;
      readonly derived: DerivedProviderDerivedArtifact;
    };

/** Persisted provenance: identical to the builder evidence without the stage path. */
export interface DerivedProviderProvenanceDerived {
  readonly bytes: number;
  readonly sha256: string;
  readonly sha512: string;
  readonly integrity: string;
  readonly manifestSha256: string;
}

export type DerivedProviderProvenance =
  | {
      readonly origin: "registry";
      readonly packageName: string;
      readonly version: string;
      readonly upstreamPr: number;
      readonly upstreamCommit: string;
      readonly original: DerivedProviderOriginalEvidence;
      readonly derived?: undefined;
    }
  | {
      readonly origin: "derived";
      readonly packageName: string;
      readonly version: string;
      readonly upstreamPr: number;
      readonly upstreamCommit: string;
      readonly original: DerivedProviderOriginalEvidence;
      readonly derived: DerivedProviderProvenanceDerived;
    };

function fail(message: string): never {
  throw new Error(`pi-provider-artifact: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Hex(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("hex");
}

function sriFromSha512(sha512: string): string {
  return `sha512-${Buffer.from(sha512, "hex").toString("base64")}`;
}

function canonicalTarballUrl(packageName: string, version: string): string {
  const shortName = packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
  return `https://${REGISTRY_HOST}/${packageName}/-/${shortName}-${version}.tgz`;
}

function assertRelease(release: unknown): NpmPackageRelease {
  if (!isRecord(release)) fail("release must be an object");
  const { version, tarballUrl, integrity } = release;
  if (!isStableSemverVersion(version)) fail("release has an invalid version");
  if (!isCanonicalSha512Integrity(integrity)) fail("release has an invalid integrity");
  if (typeof tarballUrl !== "string" || tarballUrl !== canonicalTarballUrl(PROVIDER_PACKAGE_NAME, version)) {
    fail("release tarball URL is not the canonical gentle-engram URL");
  }
  return { version, tarballUrl, integrity };
}

function readVerifiedOfficial(
  official: unknown,
  release: NpmPackageRelease,
): { bytes: Buffer; sha256: string; sha512: string } {
  if (!isRecord(official)) fail("official artifact must be an object");
  const { path: officialPath, bytes, sha256, sha512 } = official;
  if (typeof officialPath !== "string" || officialPath === "") fail("official artifact has no path");
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    fail("official artifact has invalid bytes");
  }
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) fail("official artifact has invalid sha256");
  if (typeof sha512 !== "string" || !HEX128.test(sha512)) fail("official artifact has invalid sha512");
  const stat = fs.lstatSync(officialPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    fail("official artifact must be a regular file");
  }
  if (stat.size > MAX_TARBALL_BYTES) fail("official artifact exceeds the 16 MiB ceiling");
  const data = fs.readFileSync(officialPath);
  if (data.byteLength > MAX_TARBALL_BYTES) fail("official artifact exceeds the 16 MiB ceiling");
  if (data.byteLength !== stat.size || data.byteLength !== bytes) {
    fail("official artifact size does not match its evidence");
  }
  const actual256 = sha256Hex(data);
  const actual512 = sha512Hex(data);
  if (actual256 !== sha256) fail("official artifact sha256 does not match its evidence");
  if (actual512 !== sha512) fail("official artifact sha512 does not match its evidence");
  const expected = Buffer.from(release.integrity.slice("sha512-".length), "base64");
  const actual = Buffer.from(actual512, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("official artifact bytes do not match the release integrity");
  }
  return { bytes: data, sha256: actual256, sha512: actual512 };
}

function readCString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul === -1 ? bytes.length : nul).toString("utf8");
}

function isZeroBlock(block: Buffer): boolean {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length);
  if ((raw[0]! & 0x80) !== 0) fail("unsupported tar numeric encoding");
  let text = raw.toString("latin1");
  const nul = text.indexOf("\0");
  if (nul !== -1) text = text.slice(0, nul);
  text = text.trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) fail("invalid tar numeric field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid tar numeric field value");
  return value;
}

function headerChecksum(block: Buffer): number {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  return sum;
}

function readName(header: Buffer): string {
  const name = readCString(header.subarray(0, 100));
  const prefix = readCString(header.subarray(345, 500));
  return prefix === "" ? name : `${prefix}/${name}`;
}

function assertCanonicalEntryName(name: string, directory: boolean): void {
  if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
    fail(`unsupported tar entry name: ${name}`);
  }
  if (!name.startsWith(PACKAGE_PREFIX)) fail(`tar entry escapes the package root: ${name}`);
  let body = name;
  if (name.endsWith("/")) {
    if (!directory) fail(`regular file entry must not end with a slash: ${name}`);
    body = name.slice(0, -1);
  }
  for (const segment of body.split("/")) {
    if (segment === "") fail(`non-canonical empty path segment: ${name}`);
    if (segment === "." || segment === "..") fail(`tar entry traversal: ${name}`);
  }
}

type TarMember = { name: string; canonical: string; header: Buffer; data: Buffer; directory: boolean };

function canonicalName(name: string): string {
  return name.endsWith("/") ? name.slice(0, -1) : name;
}

function assertCanonicalStructure(members: readonly TarMember[]): void {
  const kinds = new Map<string, boolean>();
  for (const member of members) {
    const previous = kinds.get(member.canonical);
    if (previous !== undefined) {
      if (previous !== member.directory) fail(`file/directory conflict at ${member.canonical}`);
      fail(`duplicate tar member: ${member.canonical}`);
    }
    kinds.set(member.canonical, member.directory);
  }
  const files = new Set<string>();
  for (const member of members) {
    if (!member.directory) files.add(member.canonical);
  }
  for (const member of members) {
    const segments = member.canonical.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (files.has(ancestor)) {
        fail(`ancestor file/directory conflict at ${ancestor} for ${member.canonical}`);
      }
    }
  }
}

function parseTarMembers(tar: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  let ended = false;
  while (offset < tar.length) {
    if (tar.length - offset < TAR_BLOCK) fail("truncated tar header");
    const header = Buffer.from(tar.subarray(offset, offset + TAR_BLOCK));
    if (isZeroBlock(header)) {
      const next = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK * 2);
      if (next.length < TAR_BLOCK || !isZeroBlock(next)) fail("truncated tar end-of-archive");
      const tail = tar.subarray(offset);
      if (tail.length % TAR_BLOCK !== 0) fail("trailing bytes after tar end-of-archive");
      for (const byte of tail) {
        if (byte !== 0) fail("non-zero bytes after tar end-of-archive");
      }
      ended = true;
      break;
    }
    if (headerChecksum(header) !== parseOctal(header, 148, 8)) fail("tar header checksum mismatch");
    // Accept both POSIX ustar ("ustar\0") and GNU old ("ustar  \0") magic; the
    // shared "ustar" prefix rejects arbitrary bytes without parsing extensions.
    if (header.subarray(257, 262).toString("latin1") !== "ustar") {
      fail("unsupported tar header magic");
    }
    const typeflag = header[156]!;
    if (typeflag !== 0x00 && typeflag !== 0x30 && typeflag !== 0x35) {
      fail(`unsupported tar member type 0x${typeflag.toString(16)}`);
    }
    const name = readName(header);
    const directory = typeflag === 0x35;
    assertCanonicalEntryName(name, directory);
    const size = parseOctal(header, 124, 12);
    offset += TAR_BLOCK;
    if (tar.length - offset < size) fail(`truncated tar member: ${name}`);
    const data = Buffer.from(tar.subarray(offset, offset + size));
    offset += size;
    const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
    if (tar.length - offset < padding) fail(`truncated tar padding: ${name}`);
    offset += padding;
    members.push({ name, canonical: canonicalName(name), header, data, directory });
  }
  if (!ended) fail("missing tar end-of-archive");
  assertCanonicalStructure(members);
  return members;
}

function writeOctalField(block: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) fail("tar numeric field overflow");
  block.write(text, offset, "latin1");
  block[offset + length - 1] = 0;
}

function rewriteHeader(header: Buffer, size: number): Buffer {
  const next = Buffer.from(header);
  writeOctalField(next, 124, 12, size);
  next.fill(0x20, 148, 156);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) sum += next[index]!;
  const checksum = sum.toString(8).padStart(6, "0");
  next.write(checksum, 148, "latin1");
  next[154] = 0;
  next[155] = 0x20;
  return next;
}

function rebuildTar(members: readonly TarMember[], manifestData: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    const isManifest = member.canonical === MANIFEST_ENTRY;
    const data = isManifest ? manifestData : member.data;
    parts.push(isManifest ? rewriteHeader(member.header, data.length) : member.header);
    parts.push(data);
    const padding = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}

function readSection(manifest: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = manifest[key];
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`manifest ${key} must be an object`);
  return value;
}

function ensureSection(manifest: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = manifest[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    manifest[key] = created;
    return created;
  }
  if (!isRecord(value)) fail(`manifest ${key} must be an object`);
  return value;
}

function isCorrectedManifest(manifest: Record<string, unknown>): boolean {
  const dependencies = readSection(manifest, "dependencies");
  const optionalDependencies = readSection(manifest, "optionalDependencies");
  const peerDependencies = readSection(manifest, "peerDependencies");
  const peerDependenciesMeta = readSection(manifest, "peerDependenciesMeta");
  const typeboxMeta = peerDependenciesMeta["typebox"];
  return (
    dependencies["typebox"] === undefined &&
    optionalDependencies["typebox"] === undefined &&
    peerDependencies["typebox"] === "*" &&
    isRecord(typeboxMeta) &&
    typeboxMeta["optional"] === true
  );
}

function assertVariantPreconditions(manifest: Record<string, unknown>): void {
  const dependencies = readSection(manifest, "dependencies");
  const optionalDependencies = readSection(manifest, "optionalDependencies");
  const peerDependencies = readSection(manifest, "peerDependencies");
  const peerDependenciesMeta = readSection(manifest, "peerDependenciesMeta");
  const dependencyKeys = Object.keys(dependencies);
  if (dependencyKeys.length !== 1 || dependencies["typebox"] !== TYPEBOX_PIN) {
    fail(`unsupported dependencies: #1567 requires exactly typebox ${TYPEBOX_PIN}`);
  }
  if (optionalDependencies["typebox"] !== undefined) {
    fail("optionalDependencies.typebox is not part of #1567");
  }
  if (peerDependencies["typebox"] !== undefined) {
    fail("conflicting peerDependencies.typebox");
  }
  if (peerDependenciesMeta["typebox"] !== undefined) {
    fail("conflicting peerDependenciesMeta.typebox");
  }
}

function applyUpstreamDelta(manifest: Record<string, unknown>): Buffer {
  delete manifest["dependencies"];
  ensureSection(manifest, "peerDependencies")["typebox"] = "*";
  ensureSection(manifest, "peerDependenciesMeta")["typebox"] = { optional: true };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Shared pure #1567 recipe. Both the builder and offline receipt verification
 * call it on the original `package/package.json` bytes so the transform is
 * never reimplemented: registry means the delta is already present, derived
 * returns the transformed manifest bytes.
 */
export function resolveProviderManifestRecipe(
  originalManifest: Buffer,
  packageName: string,
  version: string,
): { readonly origin: "registry" } | { readonly origin: "derived"; readonly manifest: Buffer } {
  if (!Buffer.isBuffer(originalManifest)) fail("manifest payload must be a buffer");
  if (originalManifest.byteLength === 0 || originalManifest.byteLength > MAX_MANIFEST_BYTES) {
    fail("manifest payload exceeds the 64 KiB ceiling");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(originalManifest.toString("utf8")) as unknown;
  } catch {
    fail("package manifest is not valid JSON");
  }
  if (!isRecord(manifest)) fail("package manifest must be an object");
  if (manifest["name"] !== packageName || manifest["version"] !== version) {
    fail("package manifest identity does not match the release");
  }
  if (isCorrectedManifest(manifest)) return { origin: "registry" };
  assertVariantPreconditions(manifest);
  const derived = applyUpstreamDelta(manifest);
  if (derived.byteLength > MAX_MANIFEST_BYTES) fail("derived manifest exceeds the 64 KiB ceiling");
  return { origin: "derived", manifest: derived };
}

function assertHexDigest(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is not a canonical hex digest`);
  return value;
}

function assertBoundedBytes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TARBALL_BYTES) {
    fail(`${label} has invalid bytes`);
  }
  return value;
}

function assertProvenanceOriginal(value: unknown): DerivedProviderOriginalEvidence {
  if (!isRecord(value)) fail("provenance original must be an object");
  if (!isCanonicalSha512Integrity(value.integrity)) fail("provenance original integrity is not canonical sha512");
  const sha256 = assertHexDigest(value.sha256, HEX64, "provenance original sha256");
  const sha512 = assertHexDigest(value.sha512, HEX128, "provenance original sha512");
  const bytes = assertBoundedBytes(value.bytes, "provenance original");
  const manifestSha256 = assertHexDigest(value.manifestSha256, HEX64, "provenance original manifestSha256");
  if (sriFromSha512(sha512) !== value.integrity) fail("provenance original integrity does not match its sha512");
  if (typeof value.manifestBase64 !== "string") fail("provenance original manifestBase64 is missing");
  const manifest = Buffer.from(value.manifestBase64, "base64");
  if (manifest.byteLength === 0 || manifest.byteLength > MAX_MANIFEST_BYTES) {
    fail("provenance original manifest exceeds the 64 KiB ceiling");
  }
  if (manifest.toString("base64") !== value.manifestBase64) fail("provenance original manifestBase64 is not canonical");
  if (sha256Hex(manifest) !== manifestSha256) fail("provenance original manifest does not match its digest");
  return { integrity: value.integrity, sha256, sha512, bytes, manifestSha256, manifestBase64: value.manifestBase64 };
}

function assertProvenanceDerived(value: unknown): DerivedProviderProvenanceDerived {
  if (!isRecord(value)) fail("provenance derived must be an object");
  if (!isCanonicalSha512Integrity(value.integrity)) fail("provenance derived integrity is not canonical sha512");
  const sha256 = assertHexDigest(value.sha256, HEX64, "provenance derived sha256");
  const sha512 = assertHexDigest(value.sha512, HEX128, "provenance derived sha512");
  const bytes = assertBoundedBytes(value.bytes, "provenance derived");
  const manifestSha256 = assertHexDigest(value.manifestSha256, HEX64, "provenance derived manifestSha256");
  if (sriFromSha512(sha512) !== value.integrity) fail("provenance derived integrity does not match its sha512");
  return { bytes, sha256, sha512, integrity: value.integrity, manifestSha256 };
}

/**
 * Offline, read-only verification of builder provenance. It re-derives the
 * manifest from the bounded original payload with the shared recipe and rejects
 * any incoherent digest or SRI. The persisted receipt layer additionally
 * rejects an ephemeral stage path. This proves local coherence and past
 * acquisition traceability, never publisher authentication.
 */
export function assertProviderArtifactProvenance(value: unknown): DerivedProviderProvenance {
  if (!isRecord(value)) fail("provenance must be an object");
  const packageName = value.packageName;
  const version = value.version;
  if (packageName !== PROVIDER_PACKAGE_NAME) fail("provenance package is not gentle-engram");
  if (!isStableSemverVersion(version)) fail("provenance version is invalid");
  if (value.upstreamPr !== UPSTREAM_PR || value.upstreamCommit !== UPSTREAM_COMMIT) {
    fail("provenance upstream reference mismatch");
  }
  const original = assertProvenanceOriginal(value.original);
  const recipe = resolveProviderManifestRecipe(Buffer.from(original.manifestBase64, "base64"), packageName, version);
  if (value.origin === "registry") {
    if (value.derived !== undefined) fail("registry provenance must not carry a derived artifact");
    if (recipe.origin !== "registry") fail("registry provenance does not describe the corrected manifest");
    return { origin: "registry", packageName, version, upstreamPr: UPSTREAM_PR, upstreamCommit: UPSTREAM_COMMIT, original };
  }
  if (value.origin !== "derived") fail(`unknown provenance origin: ${String(value.origin)}`);
  const derived = assertProvenanceDerived(value.derived);
  if (recipe.origin !== "derived") fail("derived provenance original already carries the corrected manifest");
  if (sha256Hex(recipe.manifest) !== derived.manifestSha256) {
    fail("derived provenance manifest does not match the shared recipe");
  }
  return {
    origin: "derived",
    packageName,
    version,
    upstreamPr: UPSTREAM_PR,
    upstreamCommit: UPSTREAM_COMMIT,
    original,
    derived,
  };
}

function cleanupOwnedPaths(targets: readonly string[], causes: readonly unknown[], label: string): never {
  const errors = [...causes];
  const remaining: string[] = [];
  for (const target of targets) {
    try {
      fs.rmSync(target, { force: true });
    } catch (error) {
      errors.push(error);
      remaining.push(target);
    }
  }
  if (remaining.length === 0) {
    throw new Error(`${label}: ${causes.map(errorMessage).join("; ")}`, { cause: causes[0] });
  }
  throw new AggregateError(
    errors,
    `${label}: cleanup failed; remaining own paths: ${remaining.join(", ")}`,
    { cause: causes[0] },
  );
}

function writeExclusive(destination: string, sourcePath: string, bytes: Buffer): void {
  const resolved = path.resolve(destination);
  if (resolved === path.resolve(sourcePath)) fail("destination must not overwrite the official source");
  if (fs.lstatSync(resolved, { throwIfNoEntry: false }) !== undefined) {
    fail("destination already exists");
  }
  const temp = path.join(
    path.dirname(resolved),
    `derived-provider-partial-${process.pid}-${randomBytes(8).toString("hex")}`,
  );

  let fd: number;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
  } catch (error) {
    fail(`cannot stage the derived artifact: ${errorMessage(error)}`);
  }

  let writeError: unknown;
  try {
    fs.writeFileSync(fd, bytes);
  } catch (error) {
    writeError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(fd);
  } catch (error) {
    closeError = error;
  }
  if (writeError !== undefined || closeError !== undefined) {
    const errors: unknown[] = [];
    if (writeError !== undefined) errors.push(writeError);
    if (closeError !== undefined) errors.push(closeError);
    cleanupOwnedPaths([temp], errors, "cannot write the derived artifact");
  }

  try {
    // No-replace publish: link fails when destination exists, so a raced
    // writer or a preexisting file is never overwritten.
    fs.linkSync(temp, resolved);
  } catch (error) {
    cleanupOwnedPaths([temp], [error], "cannot publish the derived artifact exclusively");
  }

  try {
    fs.rmSync(temp, { force: true });
  } catch (error) {
    // The temp is the only path we may delete. The published destination may
    // already have been replaced by another actor, so it is reported for
    // inspection, never removed and never claimed to still hold our bytes.
    cleanupOwnedPaths(
      [temp],
      [error],
      `derived artifact cleanup failed; publication destination retained for inspection: ${resolved}`,
    );
  }
}

/**
 * Build the verifiable upstream #1567 variant from an official gentle-engram
 * tarball already acquired through the verified npm seam. The official file
 * bytes are re-read and re-hashed here; the mutable `official` evidence alone
 * never authenticates the current file. Only `package/package.json` is
 * rewritten in memory; every other tar member is copied byte-identical.
 */
export async function buildDerivedProviderArtifact(
  input: DerivedProviderArtifactInput,
): Promise<DerivedProviderArtifactEvidence> {
  if (!isRecord(input)) fail("input must be an object");
  const { packageName, official, destination } = input;
  if (packageName !== PROVIDER_PACKAGE_NAME) fail(`unsupported package: ${String(packageName)}`);
  const release = assertRelease(input.release);
  const source = readVerifiedOfficial(official, release);

  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(source.bytes, { maxOutputLength: MAX_UNCOMPRESSED_TAR_BYTES });
  } catch {
    fail("official artifact is not a bounded gzip archive");
  }

  const members = parseTarMembers(tar);
  const manifestMembers = members.filter((member) => member.canonical === MANIFEST_ENTRY);
  if (manifestMembers.length !== 1) fail("tar must contain exactly one package/package.json");
  const manifestMember = manifestMembers[0]!;
  if (manifestMember.directory) fail("package/package.json must be a regular file");
  if (manifestMember.data.byteLength > MAX_MANIFEST_BYTES) fail("manifest exceeds the 64 KiB ceiling");

  const recipe = resolveProviderManifestRecipe(manifestMember.data, packageName, release.version);
  const original: DerivedProviderOriginalEvidence = {
    integrity: release.integrity,
    sha256: source.sha256,
    sha512: source.sha512,
    bytes: source.bytes.byteLength,
    manifestSha256: sha256Hex(manifestMember.data),
    manifestBase64: manifestMember.data.toString("base64"),
  };

  if (recipe.origin === "registry") {
    return {
      origin: "registry",
      packageName,
      version: release.version,
      upstreamPr: UPSTREAM_PR,
      upstreamCommit: UPSTREAM_COMMIT,
      original,
    };
  }

  const derivedManifest = recipe.manifest;
  const derivedTar = rebuildTar(members, derivedManifest);
  if (derivedTar.byteLength > MAX_UNCOMPRESSED_TAR_BYTES) fail("derived tar exceeds the 32 MiB ceiling");
  const derivedBytes = zlib.gzipSync(derivedTar);
  if (derivedBytes.byteLength > MAX_TARBALL_BYTES) fail("derived artifact exceeds the 16 MiB ceiling");
  if (typeof destination !== "string" || destination === "") fail("invalid destination");
  writeExclusive(destination, official.path, derivedBytes);

  const sha256 = sha256Hex(derivedBytes);
  const sha512 = sha512Hex(derivedBytes);
  return {
    origin: "derived",
    packageName,
    version: release.version,
    upstreamPr: UPSTREAM_PR,
    upstreamCommit: UPSTREAM_COMMIT,
    original,
    derived: {
      path: destination,
      bytes: derivedBytes.byteLength,
      sha256,
      sha512,
      integrity: sriFromSha512(sha512),
      manifestSha256: sha256Hex(derivedManifest),
    },
  };
}
