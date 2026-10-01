import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTarBin } from "../src/lib/github.js";
import { buildDerivedProviderArtifact } from "../src/lib/pi-provider-artifact.js";
import { downloadVerifiedNpmPackageTarball, type NpmPackageRelease } from "../src/lib/npm-provider.js";

/**
 * Protection for the upstream #1567 derived provider artifact.
 *
 * The official gentle-engram tarball is acquired through the existing verified
 * npm seam, then transformed in memory: only `package/package.json` changes and
 * exactly as upstream #1567 (drop the package-owned typebox dependency, add the
 * wildcard optional peer). Every other tar member header and payload must stay
 * byte-identical, the variant records its own digest/SRI plus both manifest
 * digests, an already-corrected official manifest is returned untouched as
 * `origin: "registry"`, and unsupported preconditions, stale source evidence,
 * ambiguous/hostile archives and an existing destination all fail closed
 * without writing output.
 */

const PACKAGE_NAME = "gentle-engram";
const VERSION = "0.1.16";
const TYPEBOX_PIN = "^1.1.38";
const OFFICIAL_TARBALL_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${VERSION}.tgz`;
const MANIFEST_ENTRY = "package/package.json";

const DEFAULT_FILES: Record<string, Buffer> = {
  "cli.js": Buffer.from("// gentle-engram cli fixture - must stay byte-identical\n"),
  "index.ts": Buffer.from("// gentle-engram pi extension fixture - must stay byte-identical\nexport {};\n"),
};

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-derived-artifact-"));
  sandboxes.push(root);
  return root;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Representative gentle-engram@0.1.16 manifest; fixture only, never a runtime pin. */
function officialManifest(): Record<string, unknown> {
  return {
    name: PACKAGE_NAME,
    version: VERSION,
    type: "module",
    bin: { "pi-engram": "cli.js" },
    pi: { extensions: ["./index.ts"] },
    dependencies: { typebox: TYPEBOX_PIN },
    peerDependencies: {
      "pi-mcp-adapter": ">=2.5.0",
      "@earendil-works/pi-tui": ">=0.74.0",
      "@earendil-works/pi-coding-agent": "*",
    },
    peerDependenciesMeta: {
      "pi-mcp-adapter": { optional: true },
      "@earendil-works/pi-tui": { optional: true },
    },
  };
}

/** The same manifest once upstream #1567 has been applied. */
function correctedManifest(): Record<string, unknown> {
  const manifest = officialManifest();
  delete manifest.dependencies;
  (manifest.peerDependencies as Record<string, unknown>).typebox = "*";
  (manifest.peerDependenciesMeta as Record<string, unknown>).typebox = { optional: true };
  return manifest;
}

function buildPackageTarball(
  root: string,
  tag: string,
  manifest: unknown,
  files: Record<string, Buffer> = DEFAULT_FILES,
): Buffer {
  const source = path.join(root, tag);
  const packageDir = path.join(source, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const archive = path.join(root, `${tag}.tgz`);
  execFileSync(resolveTarBin(), ["-czf", archive, "-C", source, "package"], { stdio: "pipe" });
  return fs.readFileSync(archive);
}

function verifiedTarballFetch(bytes: Buffer, release: NpmPackageRelease): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== release.tarballUrl) throw new Error(`unexpected npm tarball request: ${url}`);
    const response = new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch;
}

async function acquireVerified(root: string, bytes: Buffer, tag: string) {
  const release: NpmPackageRelease = {
    version: VERSION,
    tarballUrl: OFFICIAL_TARBALL_URL,
    integrity: sri(bytes),
  };
  const destination = path.join(root, "downloads", `${tag}.tgz`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const official = await downloadVerifiedNpmPackageTarball(
    PACKAGE_NAME,
    release,
    destination,
    verifiedTarballFetch(bytes, release),
  );
  return { release, official };
}

function listEntries(tarPath: string): string[] {
  return execFileSync(resolveTarBin(), ["-tzf", tarPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function readTarMembers(tar: Buffer): Array<{ name: string; header: Buffer; data: Buffer }> {
  const members: Array<{ name: string; header: Buffer; data: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("latin1").split("\0")[0]!;
    const size = Number.parseInt(header.subarray(124, 136).toString("latin1").split("\0")[0]!.trim() || "0", 8);
    offset += 512;
    members.push({ name, header, data: tar.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  return members;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function rawTarHeader(name: string, size: number, typeflag: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write(octal(0o644, 8), 100, "latin1");
  header.write(octal(0, 8), 108, "latin1");
  header.write(octal(0, 8), 116, "latin1");
  header.write(octal(size, 12), 124, "latin1");
  header.write(octal(0, 12), 136, "latin1");
  header.fill(0x20, 148, 156);
  header[156] = typeflag;
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

function rawTarMember(name: string, data: Buffer, typeflag = 0x30): Buffer {
  return Buffer.concat([rawTarHeader(name, data.length, typeflag), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function rawTar(members: Buffer[], level?: number): Buffer {
  return zlib.gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]), level === undefined ? undefined : { level });
}

type ManifestMutation = (manifest: Record<string, unknown>) => void;

const preconditionCases: Array<[string, ManifestMutation, RegExp]> = [
  [
    "an optional typebox dependency",
    (manifest) => {
      manifest.optionalDependencies = { typebox: TYPEBOX_PIN };
    },
    /optionalDependencies\.typebox/,
  ],
  [
    "an extra dependency",
    (manifest) => {
      manifest.dependencies = { typebox: TYPEBOX_PIN, lodash: "^4.0.0" };
    },
    /unsupported dependencies/,
  ],
  [
    "a conflicting direct peer",
    (manifest) => {
      manifest.peerDependencies = { ...(manifest.peerDependencies as Record<string, unknown>), typebox: "*" };
    },
    /conflicting peerDependencies\.typebox/,
  ],
];

const hostileArchiveCases: Array<[string, Buffer, RegExp]> = (() => {
  const manifestBytes = Buffer.from(`${JSON.stringify(officialManifest())}\n`);
  return [
    [
      "a duplicate package manifest",
      rawTar([rawTarMember(MANIFEST_ENTRY, manifestBytes), rawTarMember(MANIFEST_ENTRY, manifestBytes)]),
      /duplicate tar member/,
    ],
    [
      "a directory package manifest",
      rawTar([rawTarMember(MANIFEST_ENTRY, Buffer.alloc(0), 0x35)]),
      /package\/package\.json must be a regular file/,
    ],
    [
      "a traversal entry",
      rawTar([rawTarMember("package/../escape.txt", Buffer.from("escape\n"))]),
      /traversal/,
    ],
    [
      "a symlink member",
      rawTar([rawTarMember("package/link.js", Buffer.alloc(0), 0x32)]),
      /unsupported tar member type/,
    ],
    [
      "an entry outside the package root",
      rawTar([rawTarMember("other/package.json", manifestBytes)]),
      /escapes the package root/,
    ],
    [
      "a missing end-of-archive",
      zlib.gzipSync(rawTarMember(MANIFEST_ENTRY, manifestBytes)),
      /missing tar end-of-archive/,
    ],
  ];
})();

describe("buildDerivedProviderArtifact (#1567 derived provider artifact)", () => {
  it("applies exactly the #1567 manifest delta and preserves every other tar member header and payload", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "official", officialManifest()), "official");
    const sourceBefore = fs.readFileSync(official.path);
    const destination = path.join(root, "derived", `${PACKAGE_NAME}-${VERSION}-derived.tgz`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const evidence = await buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination });
    if (evidence.origin !== "derived") throw new Error(`expected derived origin, got ${evidence.origin}`);

    expect(evidence.packageName).toBe(PACKAGE_NAME);
    expect(evidence.version).toBe(VERSION);
    expect(evidence.upstreamPr).toBe(1567);
    expect(evidence.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.original).toMatchObject({
      integrity: release.integrity,
      sha256: official.sha256,
      sha512: official.sha512,
      bytes: official.bytes,
    });
    expect(fs.readFileSync(official.path)).toEqual(sourceBefore);

    const derivedBytes = fs.readFileSync(destination);
    expect(evidence.derived).toMatchObject({
      path: destination,
      bytes: derivedBytes.byteLength,
      sha256: sha256Hex(derivedBytes),
      sha512: createHash("sha512").update(derivedBytes).digest("hex"),
      integrity: sri(derivedBytes),
    });
    expect(evidence.derived.integrity).not.toBe(release.integrity);

    const originalMembers = readTarMembers(zlib.gunzipSync(sourceBefore));
    const derivedMembers = readTarMembers(zlib.gunzipSync(derivedBytes));
    expect(derivedMembers.map((member) => member.name)).toEqual(originalMembers.map((member) => member.name));
    for (const [index, member] of originalMembers.entries()) {
      if (member.name === MANIFEST_ENTRY) continue;
      expect(derivedMembers[index]!.header, `${member.name} header`).toEqual(member.header);
      expect(derivedMembers[index]!.data, `${member.name} payload`).toEqual(member.data);
    }

    const originalManifest = originalMembers.find((member) => member.name === MANIFEST_ENTRY)!;
    const derivedManifest = derivedMembers.find((member) => member.name === MANIFEST_ENTRY)!;
    expect(evidence.original.manifestSha256).toBe(sha256Hex(originalManifest.data));
    expect(evidence.derived.manifestSha256).toBe(sha256Hex(derivedManifest.data));
    expect(evidence.original.manifestSha256).not.toBe(evidence.derived.manifestSha256);
    expect(JSON.parse(originalManifest.data.toString("utf8"))).toEqual(officialManifest());
    expect(JSON.parse(derivedManifest.data.toString("utf8"))).toEqual(correctedManifest());

    expect(listEntries(destination)).toContain(MANIFEST_ENTRY);
  });

  it("returns the registry origin unchanged and writes nothing when the manifest is already corrected", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "corrected", correctedManifest()), "corrected");
    const sourceBefore = fs.readFileSync(official.path);
    const destination = path.join(root, "derived", "should-not-exist.tgz");

    const evidence = await buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination });

    expect(evidence.origin).toBe("registry");
    expect(evidence.derived).toBeUndefined();
    expect(evidence.upstreamPr).toBe(1567);
    expect(evidence.original).toMatchObject({
      integrity: release.integrity,
      sha256: official.sha256,
      sha512: official.sha512,
      bytes: official.bytes,
    });
    const manifest = readTarMembers(zlib.gunzipSync(sourceBefore)).find((member) => member.name === MANIFEST_ENTRY)!;
    expect(evidence.original.manifestSha256).toBe(sha256Hex(manifest.data));
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readFileSync(official.path)).toEqual(sourceBefore);
  });

  it.each(preconditionCases)("fails closed on %s without writing a derived artifact", async (_label, mutate, expected) => {
    const root = makeSandbox();
    const manifest = officialManifest();
    mutate(manifest);
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "hostile", manifest), "hostile");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(expected);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects an official file that no longer matches its recorded evidence", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "official", officialManifest()), "official");
    const tampered = Buffer.from(fs.readFileSync(official.path));
    tampered[0] = tampered[0]! ^ 0xff;
    fs.writeFileSync(official.path, tampered);
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(/official artifact sha256 does not match its evidence/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects a swapped official file whose mutable evidence was refreshed, keeping the immutable release SRI authoritative", async () => {
    const root = makeSandbox();
    const original = buildPackageTarball(root, "official", officialManifest());
    const { release, official } = await acquireVerified(root, original, "official");

    // A different but fully valid npm-shaped tarball for the same package, version
    // and #1567 preconditions. If the immutable release SRI were not compared, the
    // transform would accept it and publish a derived artifact from swapped bytes.
    const changedManifest = officialManifest();
    changedManifest.description = "same package and preconditions, different bytes";
    const changed = buildPackageTarball(root, "changed", changedManifest);
    expect(changed.equals(original)).toBe(false);

    // A local actor refreshes every mutable field of the official evidence so it is
    // self-consistent with the swapped file; only release.integrity still pins the
    // originally acquired artifact, and the recorded size/hash checks now pass.
    fs.writeFileSync(official.path, changed);
    official.bytes = changed.byteLength;
    official.sha256 = sha256Hex(changed);
    official.sha512 = createHash("sha512").update(changed).digest("hex");

    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(/official artifact bytes do not match the release integrity/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each(hostileArchiveCases)("rejects an archive with %s", async (_label, bytes, expected) => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, bytes, "hostile");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(expected);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("never overwrites an existing destination or the official source", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "official", officialManifest()), "official");

    const existing = path.join(root, "derived", "existing.tgz");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "sentinel\n");
    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination: existing }),
    ).rejects.toThrow(/destination already exists/);
    expect(fs.readFileSync(existing, "utf8")).toBe("sentinel\n");

    const sourceBefore = fs.readFileSync(official.path);
    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination: official.path }),
    ).rejects.toThrow(/must not overwrite the official source/);
    expect(fs.readFileSync(official.path)).toEqual(sourceBefore);
  });
});

/**
 * Confirmed hardening gaps (security early review). Each fixture is acquired
 * with its own recomputed SRI so the failure happens in the archive parser or
 * the exclusive writer, never on a source mismatch.
 */
const nonCanonicalArchiveCases: Array<[string, Buffer, RegExp]> = (() => {
  const manifest = Buffer.from(`${JSON.stringify(officialManifest())}\n`);
  const manifestMember = rawTarMember(MANIFEST_ENTRY, manifest);
  return [
    [
      "a non-canonical duplicate manifest path",
      rawTar([manifestMember, rawTarMember("package//package.json", manifest)]),
      /package\/\/package\.json|non-?canonical|empty segment/i,
    ],
    [
      "an ancestor file/directory conflict",
      rawTar([
        manifestMember,
        rawTarMember("package/dup", Buffer.from("x\n")),
        rawTarMember("package/dup/inner.txt", Buffer.from("y\n")),
      ]),
      /package\/dup|conflict|ancestor/i,
    ],
  ];
})();

const trailingArchiveCases: Array<[string, Buffer, RegExp]> = (() => {
  const manifestMember = rawTarMember(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(officialManifest())}\n`));
  const endOfArchive = Buffer.alloc(1024);
  return [
    [
      "a second archive after the end-of-archive marker",
      zlib.gzipSync(Buffer.concat([manifestMember, endOfArchive, rawTarMember("package/extra.js", Buffer.from("second\n"))])),
      /trailing|padding|end-of-archive/i,
    ],
    [
      "a truncated block after the end-of-archive marker",
      zlib.gzipSync(Buffer.concat([manifestMember, endOfArchive, Buffer.alloc(100, 0x41)])),
      /trailing|padding|end-of-archive/i,
    ],
  ];
})();

describe("buildDerivedProviderArtifact hardening", () => {
  it.each(nonCanonicalArchiveCases)("rejects %s", async (_label, bytes, expected) => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, bytes, "hostile");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(expected);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each(trailingArchiveCases)("rejects %s", async (_label, bytes, expected) => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, bytes, "hostile");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(expected);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects a manifest larger than the 64 KiB ceiling", async () => {
    const root = makeSandbox();
    const manifest = officialManifest();
    manifest.description = "x".repeat(65 * 1024);
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "big-manifest", manifest), "big-manifest");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(/manifest/i);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects an otherwise valid archive whose compressed input exceeds the 16 MiB ceiling", async () => {
    const root = makeSandbox();
    const payload = Buffer.alloc(17 * 1024 * 1024, 0);
    const bytes = rawTar(
      [
        rawTarMember(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(officialManifest())}\n`)),
        rawTarMember("package/large.bin", payload),
      ],
      0,
    );
    // Fixture precondition: level 0 stores the payload, so the compressed input
    // is over the ceiling while the tar itself stays inside the uncompressed
    // bound. Without the compressed ceiling this would be a valid npm-shaped
    // archive and the transform would proceed.
    expect(bytes.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(zlib.gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).byteLength).toBeLessThan(32 * 1024 * 1024);
    const { release, official } = await acquireVerified(root, bytes, "oversized");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(/^pi-provider-artifact: official artifact exceeds the 16 MiB ceiling$/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects a highly compressed archive that expands beyond the 32 MiB tar ceiling", async () => {
    const root = makeSandbox();
    const payload = Buffer.alloc(33 * 1024 * 1024, 0);
    const bytes = rawTar([
      rawTarMember(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(officialManifest())}\n`)),
      rawTarMember("package/large.bin", payload),
    ]);
    // The compressed input stays well under 16 MiB; only the bounded gunzip
    // expansion of an otherwise valid tar is what must block it.
    expect(bytes.byteLength).toBeLessThan(16 * 1024 * 1024);
    const { release, official } = await acquireVerified(root, bytes, "compressed-expansion");
    const destination = path.join(root, "derived", "out.tgz");
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await expect(
      buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }),
    ).rejects.toThrow(/^pi-provider-artifact: official artifact is not a bounded gzip archive$/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects and leaves no derived output when closing its own writer fails", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "official", officialManifest()), "official");
    const derivedDir = path.join(root, "derived");
    fs.mkdirSync(derivedDir, { recursive: true });
    const destination = path.join(derivedDir, "out.tgz");

    const originalOpen = fs.openSync;
    let writerFd: number | undefined;
    let closeFaultDelivered = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((target: unknown, ...rest: unknown[]) => {
      const fd = (originalOpen as (...args: unknown[]) => number)(target, ...rest);
      if (typeof target === "string" && path.resolve(target).startsWith(path.resolve(derivedDir))) writerFd = fd;
      return fd;
    }) as typeof fs.openSync);
    const originalClose = fs.closeSync;
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      originalClose(fd);
      if (fd === writerFd) {
        closeFaultDelivered = true;
        const error = new Error("EIO: injected close failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
    }) as typeof fs.closeSync);

    let failure: unknown;
    try {
      failure = await buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }).then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    }

    expect(closeFaultDelivered).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/EIO|close/i);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(derivedDir).filter((name) => name.startsWith("derived-provider-partial-"))).toEqual([]);
  });

  it("rejects and reports every own remaining path when cleanup of the derived temp fails after publish", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "official", officialManifest()), "official");
    const derivedDir = path.join(root, "derived");
    fs.mkdirSync(derivedDir, { recursive: true });
    const destination = path.join(derivedDir, "out.tgz");

    const originalRm = fs.rmSync;
    const originalUnlink = fs.unlinkSync;
    let cleanupFaultDelivered = false;
    const underDerived = (target: unknown): boolean =>
      typeof target === "string" && path.resolve(target).startsWith(path.resolve(derivedDir));
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((target: unknown, options: unknown) => {
      if (underDerived(target)) {
        cleanupFaultDelivered = true;
        throw new Error("EACCES: injected cleanup failure");
      }
      return originalRm(target as never, options as never);
    }) as typeof fs.rmSync);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(((target: unknown) => {
      if (underDerived(target)) {
        cleanupFaultDelivered = true;
        throw new Error("EACCES: injected cleanup failure");
      }
      return originalUnlink(target as never);
    }) as typeof fs.unlinkSync);

    let failure: unknown;
    try {
      failure = await buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }).then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      rmSpy.mockRestore();
      unlinkSpy.mockRestore();
    }

    expect(cleanupFaultDelivered).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    const message = String((failure as Error).message);
    const remaining = fs.readdirSync(derivedDir);
    // The staged temp cannot be removed under the injected fault, so the failure
    // must at least account for it; every own path still left behind, including an
    // already-published destination, must be reported too and never silently kept.
    expect(remaining.some((name) => name.startsWith("derived-provider-partial-"))).toBe(true);
    for (const name of remaining) {
      expect(message, `unreported own residual path: ${name}`).toContain(name);
    }
  });

  it("preserves a replaced destination when the derived temp cleanup fails after publish", async () => {
    const root = makeSandbox();
    const { release, official } = await acquireVerified(root, buildPackageTarball(root, "official", officialManifest()), "official");
    const derivedDir = path.join(root, "derived");
    fs.mkdirSync(derivedDir, { recursive: true });
    const destination = path.join(derivedDir, "out.tgz");
    const foreign = Buffer.from("foreign destination content that rollback must not discard\n");

    const originalLink = fs.linkSync;
    const originalRm = fs.rmSync;
    const originalUnlink = fs.unlinkSync;
    const isPartialTemp = (target: unknown): boolean =>
      typeof target === "string" && path.basename(target).startsWith("derived-provider-partial-");

    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation(((existing: unknown, target: unknown) => {
      originalLink(existing as never, target as never);
      // A foreign actor replaces the just-published destination with different
      // bytes before the staged temp is cleaned up.
      originalUnlink(destination);
      fs.writeFileSync(destination, foreign);
    }) as typeof fs.linkSync);
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((target: unknown, options: unknown) => {
      if (isPartialTemp(target)) throw new Error("EACCES: injected temp cleanup failure");
      return originalRm(target as never, options as never);
    }) as typeof fs.rmSync);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(((target: unknown) => {
      if (isPartialTemp(target)) throw new Error("EACCES: injected temp cleanup failure");
      return originalUnlink(target as never);
    }) as typeof fs.unlinkSync);

    let failure: unknown;
    try {
      failure = await buildDerivedProviderArtifact({ packageName: PACKAGE_NAME, release, official, destination }).then(
        () => null,
        (error: unknown) => error,
      );
    } finally {
      unlinkSpy.mockRestore();
      rmSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(failure).toBeInstanceOf(Error);
    // Cleanup must only remove what it wrote: the foreign replacement stays intact.
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.readFileSync(destination)).toEqual(foreign);
  });
});
