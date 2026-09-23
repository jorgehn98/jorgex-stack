import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * T05 RED for T07 offline owned managed receipt verifier callback (tests only, no prod).
 *
 * Desired contract (GREEN to implement in src/lib/pi-cached-artifact.ts):
 * - `verifyCachedPiArtifact({ receipt, homeDir, downloadsDir }): boolean` is a
 *   pure offline filesystem callback (no network, no repair, no HOME).
 * - `receipt` is schemaVersion 1 with a managed parent candidate:
 *   `candidate.package { name, version, source }` plus
 *   `candidate.tarball { bytes, sha256, sha512 }`. Validates stable version
 *   (`/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/`), exact
 *   `name === "jorgex-pi"`, exact `source === "npm:jorgex-pi@<version>"`,
 *   hex digests (64 sha256 / 128 sha512) and `bytes <= 128MiB`.
 * - `homeDir`/`downloadsDir` are non-empty absolute real directories (no
 *   symlink); `downloadsDir` is a strict child of `homeDir` (covers both
 *   `~/.jorgex-stack/packages` and `targetDir/downloads` layouts via the
 *   provided isolated boundary, never the real HOME).
 * - Exact file `jorgex-pi-<version>.tgz` strictly inside `downloadsDir`:
 *   regular non-symlink file, no symlinked parent up to `homeDir`,
 *   on-disk size equals receipt bytes and `<= 128MiB`, streaming SHA-256 and
 *   SHA-512 over file bytes equal the receipt digests (timing-safe compare).
 * - Ordinary drift returns `false`, never throws and never repairs: wrong
 *   bytes, digest mismatch, symlink file/parent, `downloadsDir` outside
 *   `homeDir`, unstable/traversal/foreign version or source.
 *
 * Synthetic `9.9.9` candidate plus fake tgz bytes are test-only: never a claim
 * about a published Pi release and never a next-version selector. Temp
 * sandboxes under `os.tmpdir()` only, never the real HOME.
 *
 * Limite explicito: el receipt local coherente bajo la misma cuenta puede
 * imitar una instalacion gestionada; este callback solo acredita bytes
 * cached frente al receipt, no propiedad criptografica del receipt bruto.
 * Sera cableado en doctor mas tarde; doctor sigue validando enlace, lock,
 * arbol, scope y runner.
 */

const SYNTHETIC_VERSION = "9.9.9";
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

type VerifyCachedInput = {
  receipt: unknown;
  homeDir: unknown;
  downloadsDir: unknown;
};

type VerifyCachedFn = (input: VerifyCachedInput) => boolean | Promise<boolean>;

const cachedSpecifier = new URL("../src/lib/pi-cached-artifact.js", import.meta.url).href;

async function loadVerifyCachedPiArtifact(): Promise<VerifyCachedFn> {
  const mod = (await import(/* @vite-ignore */ cachedSpecifier)) as Partial<{
    verifyCachedPiArtifact: VerifyCachedFn;
  }>;
  expect(
    mod.verifyCachedPiArtifact,
    "missing verifyCachedPiArtifact in src/lib/pi-cached-artifact.ts (T05 RED for T07)",
  ).toBeTypeOf("function");
  return mod.verifyCachedPiArtifact as VerifyCachedFn;
}

async function callVerifier(input: VerifyCachedInput): Promise<boolean> {
  const fn = await loadVerifyCachedPiArtifact();
  const result = fn(input);
  return result instanceof Promise ? await result : result;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function syntheticHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${10 + index}`;
}

type ValidSandbox = {
  sandbox: string;
  homeDir: string;
  downloadsDir: string;
  tarballPath: string;
  tarballBytes: Buffer;
  receipt: unknown;
};

function buildManagedReceipt(args: {
  homeDir: string;
  sandbox: string;
  version: string;
  source: string;
  bytes: number;
  sha256: string;
  sha512: string;
}): unknown {
  const agentDir = path.join(args.homeDir, "agent");
  const releaseId = syntheticHex("jx-pi-cached-release");
  expect(releaseId).toMatch(/^[a-f0-9]{64}$/);
  return {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { name: "jorgex-pi", version: args.version, source: args.source },
      tarball: { bytes: args.bytes, sha256: args.sha256, sha512: args.sha512 },
      provenance: { commit: syntheticHex("jx-pi-cached-provenance").slice(0, 40) },
    },
    scope: { kind: "target-dir", codingAgentDir: agentDir },
    engram: { binary: path.join(args.sandbox, "bin", "engram") },
    managedPackage: {
      releaseDir: path.join(agentDir, "npm", "jorgex-pi-managed", "releases", releaseId),
      linkPath: path.join(agentDir, "npm", "node_modules", "jorgex-pi"),
      backupDir: path.join(
        agentDir,
        `stage-${syntheticHex("jx-pi-cached-stage").slice(0, 32)}`,
        "pi-agent",
        ".activate-backup",
      ),
      lockSha256: syntheticHex("jx-pi-cached-lock"),
      treeSha256: syntheticHex("jx-pi-cached-tree"),
      dependencies: STAGED_DEP_NAMES.map((name, index) => ({
        name,
        version: syntheticDepVersion(index),
        integrity: syntheticIntegrity(31 + index),
      })),
    },
  };
}

function setupValidSandbox(): ValidSandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cached-artifact-"));
  sandboxes.push(sandbox);
  const homeDir = path.join(sandbox, "home");
  // Isolated home boundary mirroring ~/.jorgex-stack/packages (never real HOME).
  const downloadsDir = path.join(homeDir, ".jorgex-stack", "packages");
  fs.mkdirSync(downloadsDir, { recursive: true });

  expect(path.isAbsolute(homeDir)).toBe(true);
  expect(path.isAbsolute(downloadsDir)).toBe(true);
  expect(path.resolve(homeDir)).not.toBe(path.resolve(os.homedir()));
  expect(path.resolve(downloadsDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true);

  const tarballBytes = Buffer.from("synthetic-test-tarball-bytes-9.9.9-cached-artifact\n", "utf8");
  const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const sha512 = createHash("sha512").update(tarballBytes).digest("hex");
  const tarballPath = path.join(downloadsDir, `jorgex-pi-${SYNTHETIC_VERSION}.tgz`);
  fs.writeFileSync(tarballPath, tarballBytes);

  const receipt = buildManagedReceipt({
    homeDir,
    sandbox,
    version: SYNTHETIC_VERSION,
    source: `npm:jorgex-pi@${SYNTHETIC_VERSION}`,
    bytes: tarballBytes.byteLength,
    sha256,
    sha512,
  });

  return { sandbox, homeDir, downloadsDir, tarballPath, tarballBytes, receipt };
}

describe("T05 RED offline cached Pi artifact verifier (T07 callback, filesystem seam)", () => {
  it("returns true for the valid cached tgz bound to the synthetic 9.9.9 managed receipt", async () => {
    const sandbox = setupValidSandbox();
    expect(SYNTHETIC_VERSION).toBe("9.9.9");
    expect(fs.lstatSync(sandbox.tarballPath).isFile()).toBe(true);
    expect(fs.lstatSync(sandbox.tarballPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(sandbox.tarballPath).equals(sandbox.tarballBytes)).toBe(true);

    const result = await callVerifier({
      receipt: sandbox.receipt,
      homeDir: sandbox.homeDir,
      downloadsDir: sandbox.downloadsDir,
    });
    expect(result).toBe(true);
  });

  it("returns false (not throw, no repair) when cached bytes drift from the receipt", async () => {
    const sandbox = setupValidSandbox();
    fs.appendFileSync(sandbox.tarballPath, "drift");
    expect(fs.readFileSync(sandbox.tarballPath).equals(sandbox.tarballBytes)).toBe(false);

    const result = await callVerifier({
      receipt: sandbox.receipt,
      homeDir: sandbox.homeDir,
      downloadsDir: sandbox.downloadsDir,
    });
    expect(result).toBe(false);
    // No repair: drifted bytes stay on disk.
    expect(fs.existsSync(sandbox.tarballPath)).toBe(true);
    expect(fs.readFileSync(sandbox.tarballPath).equals(sandbox.tarballBytes)).toBe(false);
  });

  it("returns false when the cached file is a foreign symlink", async () => {
    const sandbox = setupValidSandbox();
    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cached-foreign-"));
    sandboxes.push(foreignDir);
    const foreignFile = path.join(foreignDir, "evil.tgz");
    fs.writeFileSync(foreignFile, sandbox.tarballBytes);
    fs.rmSync(sandbox.tarballPath, { force: true });
    fs.symlinkSync(foreignFile, sandbox.tarballPath);
    expect(fs.lstatSync(sandbox.tarballPath).isSymbolicLink()).toBe(true);

    const result = await callVerifier({
      receipt: sandbox.receipt,
      homeDir: sandbox.homeDir,
      downloadsDir: sandbox.downloadsDir,
    });
    expect(result).toBe(false);
  });

  it("returns false when a downloads parent is symlinked outside the home boundary", async () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cached-symlink-parent-"));
    sandboxes.push(sandboxRoot);
    const homeDir = path.join(sandboxRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });

    const tarballBytes = Buffer.from("synthetic-test-tarball-bytes-9.9.9-cached-artifact\n", "utf8");
    const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
    const sha512 = createHash("sha512").update(tarballBytes).digest("hex");

    const foreignRoot = path.join(sandboxRoot, "foreign-store");
    const foreignPackages = path.join(foreignRoot, "packages");
    fs.mkdirSync(foreignPackages, { recursive: true });
    fs.writeFileSync(path.join(foreignPackages, `jorgex-pi-${SYNTHETIC_VERSION}.tgz`), tarballBytes);

    const linkPath = path.join(homeDir, ".jorgex-stack");
    fs.symlinkSync(foreignRoot, linkPath, "dir");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const downloadsDir = path.join(linkPath, "packages");

    const receipt = buildManagedReceipt({
      homeDir,
      sandbox: sandboxRoot,
      version: SYNTHETIC_VERSION,
      source: `npm:jorgex-pi@${SYNTHETIC_VERSION}`,
      bytes: tarballBytes.byteLength,
      sha256,
      sha512,
    });

    const result = await callVerifier({ receipt, homeDir, downloadsDir });
    expect(result).toBe(false);
  });

  it("returns false when downloadsDir escapes the isolated home boundary", async () => {
    const sandbox = setupValidSandbox();
    const outsideDir = path.join(sandbox.sandbox, "outside-downloads");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, `jorgex-pi-${SYNTHETIC_VERSION}.tgz`);
    fs.writeFileSync(outsideFile, sandbox.tarballBytes);
    expect(path.relative(path.resolve(sandbox.homeDir), path.resolve(outsideDir)).startsWith("..")).toBe(true);

    const result = await callVerifier({
      receipt: sandbox.receipt,
      homeDir: sandbox.homeDir,
      downloadsDir: outsideDir,
    });
    expect(result).toBe(false);
  });

  it("returns false for unstable, traversal, or foreign package identity without escaping home", async () => {
    const sandbox = setupValidSandbox();

    const invalidCases: Array<{ label: string; version: string; source: string }> = [
      { label: "prerelease", version: "9.9.9-beta", source: "npm:jorgex-pi@9.9.9-beta" },
      { label: "traversal", version: "../evil", source: "npm:jorgex-pi@../evil" },
      { label: "foreign source", version: SYNTHETIC_VERSION, source: "npm:other-pi@9.9.9" },
    ];

    for (const invalid of invalidCases) {
      const receipt = buildManagedReceipt({
        homeDir: sandbox.homeDir,
        sandbox: sandbox.sandbox,
        version: invalid.version,
        source: invalid.source,
        bytes: sandbox.tarballBytes.byteLength,
        sha256: createHash("sha256").update(sandbox.tarballBytes).digest("hex"),
        sha512: createHash("sha512").update(sandbox.tarballBytes).digest("hex"),
      });
      const result = await callVerifier({
        receipt,
        homeDir: sandbox.homeDir,
        downloadsDir: sandbox.downloadsDir,
      });
      expect(result, invalid.label).toBe(false);
    }

    // Oversize claim bounded at 128MiB must also fail closed without hashing a huge file.
    const oversizeReceipt = buildManagedReceipt({
      homeDir: sandbox.homeDir,
      sandbox: sandbox.sandbox,
      version: SYNTHETIC_VERSION,
      source: `npm:jorgex-pi@${SYNTHETIC_VERSION}`,
      bytes: MAX_TARBALL_BYTES + 1,
      sha256: createHash("sha256").update(sandbox.tarballBytes).digest("hex"),
      sha512: createHash("sha512").update(sandbox.tarballBytes).digest("hex"),
    });
    expect(await callVerifier({ receipt: oversizeReceipt, homeDir: sandbox.homeDir, downloadsDir: sandbox.downloadsDir })).toBe(
      false,
    );

    // Traversal must not have created anything outside downloadsDir.
    expect(fs.existsSync(path.join(sandbox.sandbox, "evil"))).toBe(false);
    expect(fs.existsSync(sandbox.tarballPath)).toBe(true);
  });
});
