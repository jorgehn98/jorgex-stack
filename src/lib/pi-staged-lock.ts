import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface StagedPiRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface InspectStagedPiNpmInput {
  stageDir: string;
  tarballPath: string;
  release: StagedPiRelease;
}

export interface StagedPiDependency {
  name: string;
  version: string;
  integrity: string;
}

export interface InspectStagedPiNpmResult {
  lockSha256: string;
  treeSha256: string;
  dependencies: StagedPiDependency[];
}

/**
 * T06 stage inspector: read-only evidence check of an isolated staged npm
 * tree (`pi install npm:jorgex-pi@file:<tgz>`) before activation.
 *
 * What it verifies, fail-closed with `pi-staged-lock: ...`:
 * - the exact validated release (stable version, canonical registry tarball
 *   URL, canonical sha512 SRI);
 * - the staged tarball bytes re-hashed bounded/streaming match the release
 *   SRI (wrong parent identity or TOCTOU-swapped bytes reject);
 * - the lock v3 root alias and the parent `resolved` are `file:` specs that
 *   resolve EXACTLY to that tarball (never a foreign path);
 * - root identity (`pi-extensions`) in lock and `npm/package.json`;
 * - installed `jorgex-pi` manifest identity/version and its six declared
 *   `*` companions;
 * - each hoisted companion: canonical registry URL plus canonical sha512
 *   SRI in the lock, matching installed manifest identity/version;
 * - singleton: no nested second copy of an active companion under
 *   `node_modules/jorgex-pi/node_modules` (lock keys and filesystem).
 *
 * Digests for receipt v2: `lockSha256` is the sha256 of the raw lock bytes;
 * `treeSha256` is a deterministic sorted inventory of the staged npm tree
 * (paths, entry kinds, regular-file bytes, raw safe relative symlink
 * targets). The tarball SRI is NOT claimed to equal unpacked bytes; the
 * tree digest only records the observed tree.
 *
 * Real-layout assumptions (see report): the six companion names below mirror
 * the frozen `bundledDependencies` shape; extra top-level hoisted packages
 * (e.g. transitive closure manifests) are allowed and only inventoried;
 * staged `.bin` symlinks are accepted as internal relative links; the tree
 * root is `stageDir/npm` (sibling `downloads/` is out of the inventory).
 */

const REGISTRY_HOST = "registry.npmjs.org";
const PARENT_NAME = "jorgex-pi";
const LOCK_ROOT_NAME = "pi-extensions";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

// Shape-only names frozen with tests/fixtures/pi-runtime.ts
// (`bundledDependencies`); versions/hashes are always observed, never pinned.
const EXPECTED_COMPANIONS = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

function fail(message: string): never {
  throw new Error(`pi-staged-lock: ${message}`);
}

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

function canonicalParentTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

function canonicalDepUrl(name: string, version: string): string {
  const unscoped = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
}

function assertCanonicalSha512(integrity: unknown, label: string): Buffer {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail(`${label} must be canonical sha512 SRI`);
  }
  const b64 = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    fail(`${label} must be canonical sha512 SRI`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    fail(`${label} must be canonical sha512 SRI`);
  }
  if (bytes.length !== 64 || bytes.toString("base64") !== b64) {
    fail(`${label} must be canonical sha512 SRI`);
  }
  return bytes;
}

function validateRelease(release: unknown): { expectedSha512: Buffer; version: string } {
  if (!isRecord(release)) fail("release must be an object");
  const { version, tarballUrl, integrity } = release;
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) {
    fail(`invalid release version ${String(version)}`);
  }
  if (typeof tarballUrl !== "string") fail("foreign release tarball URL");
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl);
  } catch {
    fail("foreign release tarball URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== REGISTRY_HOST ||
    tarballUrl !== canonicalParentTarballUrl(version)
  ) {
    fail("foreign release tarball URL");
  }
  return { expectedSha512: assertCanonicalSha512(integrity, "release integrity"), version };
}

function assertRealDir(p: string, label: string): string {
  const resolved = path.resolve(p);
  const st = lstatOrNull(resolved);
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${p}`);
  }
  return resolved;
}

/** Bounded streaming read of a regular file that must not itself be a symlink. */
function readBoundedBytes(file: string, maxBytes: number, label: string): Buffer {
  const st = lstatOrNull(file);
  if (st === null) fail(`missing ${label}: ${file}`);
  if (st.isSymbolicLink()) fail(`${label} must not be a symlink: ${file}`);
  if (!st.isFile()) fail(`${label} must be a regular file: ${file}`);
  if (st.size > maxBytes) fail(`${label} exceeds size bound: ${file}`);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    fail(`cannot read ${label}: ${file}`);
  }
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;
  try {
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        fail(`cannot read ${label}: ${file}`);
      }
      if (read === 0) break;
      total += read;
      if (total > maxBytes) fail(`${label} exceeds size bound: ${file}`);
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors on a read-only descriptor.
    }
  }
  return Buffer.concat(chunks);
}

function readBoundedJson(file: string, maxBytes: number, label: string): unknown {
  const bytes = readBoundedBytes(file, maxBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail(`malformed ${label}: ${file}`);
  }
}

/** Bounded streaming sha512 of the staged tarball, compared in constant time. */
function assertTarballMatchesIntegrity(tarballPath: string, expectedSha512: Buffer): void {
  const st = lstatOrNull(tarballPath);
  if (st === null) fail(`missing staged tarball: ${tarballPath}`);
  if (st.isSymbolicLink()) fail(`staged tarball must not be a symlink: ${tarballPath}`);
  if (!st.isFile()) fail(`staged tarball must be a regular file: ${tarballPath}`);
  if (st.size > MAX_TARBALL_BYTES) fail(`staged tarball exceeds size bound: ${tarballPath}`);
  let fd: number;
  try {
    fd = fs.openSync(tarballPath, "r");
  } catch {
    fail(`cannot read staged tarball: ${tarballPath}`);
  }
  const hash = createHash("sha512");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;
  try {
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        fail(`cannot read staged tarball: ${tarballPath}`);
      }
      if (read === 0) break;
      total += read;
      if (total > MAX_TARBALL_BYTES) fail(`staged tarball exceeds size bound: ${tarballPath}`);
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors on a read-only descriptor.
    }
  }
  const actual = hash.digest();
  if (actual.length !== expectedSha512.length || !timingSafeEqual(actual, expectedSha512)) {
    fail("staged tarball bytes do not match release integrity");
  }
}

/** A lock `file:` spec must resolve EXACTLY to the verified tarball. */
function assertFileSpecResolves(
  spec: unknown,
  npmDir: string,
  tarballResolved: string,
  label: string,
): string {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    fail(`${label} must be a file: spec, got ${String(spec)}`);
  }
  const rest = spec.slice("file:".length);
  if (rest === "" || path.isAbsolute(rest)) {
    fail(`${label} must be a relative file: spec: ${spec}`);
  }
  if (path.resolve(npmDir, rest) !== tarballResolved) {
    fail(`${label} does not resolve to the verified tarball: ${spec}`);
  }
  return spec;
}

function depDirFor(nodeModules: string, name: string): string {
  return path.join(nodeModules, ...name.split("/"));
}

function assertRealDirStrict(p: string, label: string): void {
  const st = lstatOrNull(p);
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${p}`);
  }
}

/**
 * Physical symlink containment: walk the raw relative target component by
 * component from the link parent with lstat, never following. Rejects
 * absolute targets, lexical escapes, broken entries, and symlink chains.
 * Direct npm `.bin` links (`../pkg/bin/file` through real dirs) stay
 * accepted; the target is recorded raw, never followed.
 */
function readContainedLinkTarget(linkPath: string, allowedRoot: string): string {
  const linkParent = path.dirname(path.resolve(linkPath));
  let target: string;
  try {
    target = fs.readlinkSync(linkPath);
  } catch {
    fail(`staged symlink is broken or unreadable: ${linkPath}`);
  }
  if (target === "" || path.isAbsolute(target)) {
    fail(`staged symlink must be relative: ${linkPath}`);
  }
  const isStrictChild = (child: string): boolean => {
    const rel = path.relative(allowedRoot, child);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const ops = target.split("/").filter((part) => part !== "" && part !== ".");
  if (ops.length === 0) fail(`staged symlink escapes staged tree: ${linkPath} -> ${target}`);
  let cur = linkParent;
  for (let i = 0; i < ops.length; i++) {
    const part = ops[i] as string;
    const isLast = i === ops.length - 1;
    if (part === "..") {
      cur = path.dirname(cur);
      if (cur !== allowedRoot && !isStrictChild(cur)) {
        fail(`staged symlink escapes staged tree: ${linkPath} -> ${target}`);
      }
      const st = lstatOrNull(cur);
      if (st === null) fail(`staged symlink is broken: ${linkPath} -> ${target}`);
      if (st.isSymbolicLink()) fail(`staged symlink chain: ${linkPath} -> ${target}`);
      if (isLast) {
        if (!st.isDirectory()) fail(`staged symlink must point to a file or directory: ${linkPath}`);
      } else if (!st.isDirectory()) {
        fail(`staged symlink points through a non-directory: ${linkPath} -> ${target}`);
      }
      continue;
    }
    const next = path.join(cur, part);
    if (next !== allowedRoot && !isStrictChild(next)) {
      fail(`staged symlink escapes staged tree: ${linkPath} -> ${target}`);
    }
    const st = lstatOrNull(next);
    if (st === null) fail(`staged symlink is broken: ${linkPath} -> ${target}`);
    if (st.isSymbolicLink()) fail(`staged symlink chain: ${linkPath} -> ${target}`);
    if (isLast) {
      if (!st.isFile() && !st.isDirectory()) {
        fail(`staged symlink must point to a file or directory: ${linkPath}`);
      }
    } else {
      if (!st.isDirectory()) {
        fail(`staged symlink points through a non-directory: ${linkPath} -> ${target}`);
      }
      cur = next;
    }
  }
  return target;
}

type InventoryEntry =
  | { rel: string; kind: "dir" }
  | { rel: string; kind: "file" }
  | { rel: string; kind: "symlink"; target: string };

/** Deterministic sorted inventory of the staged npm tree for receipt v2. */
function inventoryTreeSha256(npmDir: string): string {
  const root = path.resolve(npmDir);
  const entries: InventoryEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      fail(`staged tree unreadable: ${dir}`);
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (dirent.isSymbolicLink()) {
        const target = readContainedLinkTarget(full, root);
        entries.push({ rel, kind: "symlink", target });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ rel, kind: "dir" });
        stack.push(full);
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ rel, kind: "file" });
        continue;
      }
      fail(`unsupported staged entry kind: ${full}`);
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  let total = 0;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  for (const entry of entries) {
    hash.update(entry.kind, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.rel, "utf8");
    hash.update("\0", "utf8");
    if (entry.kind === "symlink") {
      hash.update(entry.target, "utf8");
    } else if (entry.kind === "file") {
      const full = path.join(root, ...entry.rel.split("/"));
      let fd: number;
      try {
        fd = fs.openSync(full, "r");
      } catch {
        fail(`staged tree unreadable: ${full}`);
      }
      try {
        for (;;) {
          let read: number;
          try {
            read = fs.readSync(fd, buffer, 0, buffer.length, null);
          } catch {
            fail(`staged tree unreadable: ${full}`);
          }
          if (read === 0) break;
          total += read;
          if (total > MAX_TREE_BYTES) fail("staged tree exceeds size bound");
          hash.update(buffer.subarray(0, read));
        }
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors on a read-only descriptor.
        }
      }
    }
  }
  return hash.digest("hex");
}

export function inspectStagedPiNpm(input: InspectStagedPiNpmInput): InspectStagedPiNpmResult {
  if (!isRecord(input)) fail("input must be an object");
  const { stageDir, tarballPath, release } = input as Record<string, unknown>;
  if (typeof stageDir !== "string" || stageDir === "") fail("stageDir must be a non-empty path");
  if (typeof tarballPath !== "string" || tarballPath === "") {
    fail("tarballPath must be a non-empty path");
  }
  const { expectedSha512, version } = validateRelease(release);

  const stageRoot = assertRealDir(stageDir, "stageDir");
  const npmDir = assertRealDir(path.join(stageRoot, "npm"), "staged npm tree");
  const nodeModules = assertRealDir(path.join(npmDir, "node_modules"), "staged node_modules");
  const tarballResolved = path.resolve(tarballPath);

  // Bind the exact release SRI to the staged bytes before trusting the lock.
  assertTarballMatchesIntegrity(tarballPath, expectedSha512);

  const lockPath = path.join(npmDir, "package-lock.json");
  const lockBytes = readBoundedBytes(lockPath, MAX_LOCK_BYTES, "staged lock");
  const lockSha256 = createHash("sha256").update(lockBytes).digest("hex");
  let lock: unknown;
  try {
    lock = JSON.parse(lockBytes.toString("utf8")) as unknown;
  } catch {
    fail(`malformed staged lock: ${lockPath}`);
  }
  if (!isRecord(lock)) fail(`malformed staged lock: ${lockPath}`);
  if (lock["name"] !== LOCK_ROOT_NAME) fail(`staged lock root must be named ${LOCK_ROOT_NAME}`);
  if (lock["lockfileVersion"] !== 3) fail("staged lock must be lockfileVersion 3");
  const packages = lock["packages"];
  if (!isRecord(packages)) fail(`malformed staged lock packages: ${lockPath}`);

  const rootEntry = packages[""];
  if (!isRecord(rootEntry)) fail("staged lock misses root package entry");
  const rootDeps = rootEntry["dependencies"];
  if (!isRecord(rootDeps)) fail("staged lock misses root jorgex-pi alias");
  const rootSpec = assertFileSpecResolves(
    rootDeps[PARENT_NAME],
    npmDir,
    tarballResolved,
    "staged lock root alias",
  );

  const rootManifestRaw = readBoundedJson(
    path.join(npmDir, "package.json"),
    MAX_MANIFEST_BYTES,
    "staged root manifest",
  );
  if (!isRecord(rootManifestRaw) || rootManifestRaw["name"] !== LOCK_ROOT_NAME) {
    fail("staged root manifest must be named pi-extensions");
  }
  const rootManifestDeps = rootManifestRaw["dependencies"];
  if (!isRecord(rootManifestDeps) || rootManifestDeps[PARENT_NAME] !== rootSpec) {
    fail("staged root manifest must declare the same jorgex-pi file: alias");
  }

  const parentEntry = packages[`node_modules/${PARENT_NAME}`];
  if (!isRecord(parentEntry)) fail("staged lock misses node_modules/jorgex-pi");
  if (parentEntry["version"] !== version) {
    fail(`staged parent version ${String(parentEntry["version"])} != release ${version}`);
  }
  if (typeof parentEntry["integrity"] !== "string") fail("staged parent misses integrity");
  assertCanonicalSha512(parentEntry["integrity"], "staged parent integrity");
  if (parentEntry["integrity"] !== (release as StagedPiRelease).integrity) {
    fail("staged parent integrity != release integrity");
  }
  const parentSpec = assertFileSpecResolves(
    parentEntry["resolved"],
    npmDir,
    tarballResolved,
    "staged parent resolved",
  );
  if (parentSpec !== rootSpec) fail("staged parent resolved != root file: alias");
  const parentDeps = parentEntry["dependencies"];
  if (!isRecord(parentDeps)) fail("staged parent misses companion declarations");
  const expectedNames = [...EXPECTED_COMPANIONS].sort();
  const lockDepNames = Object.keys(parentDeps).sort();
  if (
    lockDepNames.length !== expectedNames.length ||
    !lockDepNames.every((name, i) => name === expectedNames[i])
  ) {
    fail(`staged parent must declare exactly the six companions, got [${lockDepNames.join(", ")}]`);
  }
  for (const name of expectedNames) {
    if (parentDeps[name] !== "*") fail(`staged parent must declare ${name} as "*", got ${String(parentDeps[name])}`);
  }

  const parentManifestRaw = readBoundedJson(
    path.join(depDirFor(nodeModules, PARENT_NAME), "package.json"),
    MAX_MANIFEST_BYTES,
    "staged jorgex-pi manifest",
  );
  if (
    !isRecord(parentManifestRaw) ||
    parentManifestRaw["name"] !== PARENT_NAME ||
    parentManifestRaw["version"] !== version
  ) {
    fail("staged jorgex-pi manifest identity/version mismatch");
  }
  const parentManifestDeps = parentManifestRaw["dependencies"];
  if (!isRecord(parentManifestDeps)) fail("staged jorgex-pi manifest misses dependencies");
  const manifestDepNames = Object.keys(parentManifestDeps).sort();
  if (
    manifestDepNames.length !== expectedNames.length ||
    !manifestDepNames.every((name, i) => name === expectedNames[i])
  ) {
    fail("staged jorgex-pi manifest must declare exactly the six companions");
  }
  for (const name of expectedNames) {
    if (parentManifestDeps[name] !== "*") {
      fail(`staged jorgex-pi manifest must declare ${name} as "*"`);
    }
  }

  // Singleton: no nested second copy of an active companion, in lock or tree.
  for (const key of Object.keys(packages)) {
    if (key.startsWith(`node_modules/${PARENT_NAME}/node_modules/`)) {
      fail(`nested second copy under staged parent: ${key}`);
    }
    if (key.includes("/node_modules/")) {
      const last = key.split("/").pop() as string;
      if ((EXPECTED_COMPANIONS as readonly string[]).includes(last)) {
        fail(`nested second copy of staged companion: ${key}`);
      }
    }
  }
  const nestedRoot = path.join(nodeModules, PARENT_NAME, "node_modules");
  if (lstatOrNull(nestedRoot) !== null) {
    fail("nested second copy under staged parent: node_modules/jorgex-pi/node_modules");
  }

  const dependencies: StagedPiDependency[] = [];
  for (const name of expectedNames) {
    const entry = packages[`node_modules/${name}`];
    if (!isRecord(entry)) fail(`staged lock misses node_modules/${name}`);
    const depVersion = entry["version"];
    if (typeof depVersion !== "string" || depVersion === "" || /\s/.test(depVersion)) {
      fail(`staged companion ${name} has an invalid version`);
    }
    if (entry["resolved"] !== canonicalDepUrl(name, depVersion)) {
      fail(`staged companion ${name} has a foreign resolved URL: ${String(entry["resolved"])}`);
    }
    if (typeof entry["integrity"] !== "string") fail(`staged companion ${name} misses integrity`);
    assertCanonicalSha512(entry["integrity"], `staged companion ${name} integrity`);

    const dir = depDirFor(nodeModules, name);
    assertRealDirStrict(dir, `staged companion ${name}`);
    const manifestRaw = readBoundedJson(
      path.join(dir, "package.json"),
      MAX_MANIFEST_BYTES,
      `staged companion ${name} manifest`,
    );
    if (
      !isRecord(manifestRaw) ||
      manifestRaw["name"] !== name ||
      manifestRaw["version"] !== depVersion
    ) {
      fail(`staged companion ${name} manifest identity/version mismatch`);
    }
    dependencies.push({ name, version: depVersion, integrity: entry["integrity"] });
  }

  const treeSha256 = inventoryTreeSha256(npmDir);
  return { lockSha256, treeSha256, dependencies };
}
