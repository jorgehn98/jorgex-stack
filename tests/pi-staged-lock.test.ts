import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * T05 RED for T06 staged native Pi dependency evidence.
 *
 * Intended code-facing contract (no production change here):
 * - `inspectStagedPiNpm({ stageDir, tarballPath, release })` exported from
 *   `src/lib/pi-staged-lock.ts`.
 * - `stageDir` is an isolated Pi agent dir containing `npm/package-lock.json`,
 *   `npm/package.json`, `npm/node_modules/jorgex-pi/package.json` plus six
 *   hoisted companion manifests. `tarballPath` is the verified file tarball,
 *   `release` is the exact validated `{ version, tarballUrl, integrity }`.
 * - Returns `{ lockSha256, treeSha256, dependencies }` where both digests are
 *   64-hex and `dependencies` holds the six observed
 *   `{ name, version, integrity }` identities from the staged lock/tree.
 * - Fail-closed (throw `pi-staged-lock: ...`) before activation on: wrong
 *   parent integrity, staged tarball bytes diverging from that integrity
 *   (TOCTOU stage artifact), missing companion, foreign registry URL, or a
 *   nested second copy under `node_modules/jorgex-pi/node_modules`.
 *
 * Fixture notes:
 * - Parent integrity is bound to the staged tarball bytes:
 *   `sha512-` of `createHash("sha512").update(tarballBytes)` written to the
 *   same `tarballPath`. A strict inspector must hash `tarballPath` and reject
 *   a false parent identity or bytes swapped after the lock was generated.
 * - Companion versions (`9.9.x`) and SRI values (`sha512-` over synthetic
 *   64-byte fills) remain synthetic test-only values in an `os.tmpdir()`
 *   sandbox. They prove the inspector observes the staged evidence instead of
 *   hardcoding literals; they are not claims about the real Pi 0.87.1 /
 *   published 0.8.30 probe that motivated the shape.
 * - Npm-root `name` fields use the real native shape `pi-extensions`
 *   (lock `name` + `npm/package.json` `name`); root versions/paths stay
 *   synthetic test-only.
 * - Dep names mirror the six bundled companions already frozen in
 *   `tests/fixtures/pi-runtime.ts` (`bundledDependencies`) shape-only; their
 *   versions/hashes here are synthetic. Lock shape mirrors the real v3 probe:
 *   root `packages[""].dependencies["jorgex-pi"]` is a `file:` relative spec,
 *   `packages["node_modules/jorgex-pi"]` carries version/resolved file
 *   spec/SRI plus six `"*"` deps, and each companion entry carries version,
 *   canonical npm URL, and canonical sha512 SRI with a matching installed
 *   manifest. No real network.
 */

type StagedPiRelease = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type StagedPiInput = {
  stageDir: string;
  tarballPath: string;
  release: StagedPiRelease;
};

type StagedPiDependency = {
  name: string;
  version: string;
  integrity: string;
};

type StagedPiResult = {
  lockSha256: string;
  treeSha256: string;
  dependencies: StagedPiDependency[];
};

type PiStagedLockModule = {
  inspectStagedPiNpm(input: StagedPiInput): StagedPiResult | Promise<StagedPiResult>;
};

const stagedSpecifier = new URL("../src/lib/pi-staged-lock.js", import.meta.url).href;

async function loadStagedInspector(): Promise<PiStagedLockModule> {
  const mod = (await import(/* @vite-ignore */ stagedSpecifier)) as Partial<PiStagedLockModule>;
  expect(
    mod.inspectStagedPiNpm,
    "inspectStagedPiNpm must be exported from src/lib/pi-staged-lock.ts",
  ).toBeTypeOf("function");
  return mod as PiStagedLockModule;
}

// Shape-only names (see header); versions/SRI below are synthetic.
const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const PARENT_VERSION = "9.9.9";

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${10 + index}`;
}

function canonicalDepUrl(name: string, version: string): string {
  const unscoped = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
}

function canonicalParentTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

type StagedFixture = {
  stageDir: string;
  tarballPath: string;
  release: StagedPiRelease;
  depEntries: StagedPiDependency[];
};

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildStagedFixture(): StagedFixture {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-staged-"));
  sandboxes.push(stageDir);

  const npmDir = path.join(stageDir, "npm");
  const downloadsDir = path.join(stageDir, "downloads");
  fs.mkdirSync(npmDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const tarballBytes = Buffer.from("synthetic-test-tarball-bytes-9.9.9\n");
  const parentIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  const tarballFile = `jorgex-pi-${PARENT_VERSION}.tgz`;
  const tarballPath = path.join(downloadsDir, tarballFile);
  fs.writeFileSync(tarballPath, tarballBytes);

  // Relative from npmDir, mirroring `file:../downloads/<tgz>` in the probe.
  const fileSpec = `file:../downloads/${tarballFile}`;

  const depEntries: StagedPiDependency[] = STAGED_DEP_NAMES.map((name, index) => ({
    name,
    version: syntheticDepVersion(index),
    integrity: syntheticIntegrity(11 + index),
  }));

  const parentDeps: Record<string, string> = {};
  for (const dep of depEntries) parentDeps[dep.name] = "*";

  const packages: Record<string, Record<string, unknown>> = {
    "": { dependencies: { "jorgex-pi": fileSpec } },
    "node_modules/jorgex-pi": {
      version: PARENT_VERSION,
      resolved: fileSpec,
      integrity: parentIntegrity,
      dependencies: parentDeps,
    },
  };
  for (const dep of depEntries) {
    packages[`node_modules/${dep.name}`] = {
      version: dep.version,
      resolved: canonicalDepUrl(dep.name, dep.version),
      integrity: dep.integrity,
    };
  }

  const lock = {
    name: "pi-extensions",
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  fs.writeFileSync(path.join(npmDir, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  fs.writeFileSync(
    path.join(npmDir, "package.json"),
    `${JSON.stringify({ name: "pi-extensions", version: PARENT_VERSION, dependencies: { "jorgex-pi": fileSpec } }, null, 2)}\n`,
  );

  const nodeModulesDir = path.join(npmDir, "node_modules");
  const parentDir = path.join(nodeModulesDir, "jorgex-pi");
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(
    path.join(parentDir, "package.json"),
    `${JSON.stringify({ name: "jorgex-pi", version: PARENT_VERSION, dependencies: parentDeps }, null, 2)}\n`,
  );
  for (const dep of depEntries) {
    const dir = path.join(nodeModulesDir, dep.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: dep.name, version: dep.version }, null, 2)}\n`,
    );
  }

  return {
    stageDir,
    tarballPath,
    release: {
      version: PARENT_VERSION,
      tarballUrl: canonicalParentTarballUrl(PARENT_VERSION),
      integrity: parentIntegrity,
    },
    depEntries,
  };
}

function readLock(stageDir: string): Record<string, unknown> & { packages: Record<string, Record<string, unknown>> } {
  const lockPath = path.join(stageDir, "npm", "package-lock.json");
  return JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown> & {
    packages: Record<string, Record<string, unknown>>;
  };
}

function writeLock(stageDir: string, lock: unknown): void {
  fs.writeFileSync(path.join(stageDir, "npm", "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("[T06-RED] staged Pi npm tree evidence before activation", () => {
  it("returns the six observed identities with 64-hex lock/tree digests", async () => {
    const { inspectStagedPiNpm } = await loadStagedInspector();
    const fixture = buildStagedFixture();

    const result = await inspectStagedPiNpm({
      stageDir: fixture.stageDir,
      tarballPath: fixture.tarballPath,
      release: fixture.release,
    });

    expect(result.lockSha256).toMatch(HEX64);
    expect(result.treeSha256).toMatch(HEX64);
    expect(result.dependencies).toHaveLength(6);

    const byName = new Map(result.dependencies.map((dep) => [dep.name, dep]));
    expect([...byName.keys()].sort()).toEqual([...STAGED_DEP_NAMES].sort());
    for (const expected of fixture.depEntries) {
      expect(byName.get(expected.name)).toEqual(expected);
    }

    // Independence from the real probe literals that motivated the shape:
    // synthetic 9.9.x evidence only, never the published Pi/tarball versions.
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("0.87.1");
    expect(encoded).not.toContain("0.8.30");
  });

  it("fails closed on wrong parent integrity before activation", async () => {
    const { inspectStagedPiNpm } = await loadStagedInspector();
    const fixture = buildStagedFixture();

    await expect(
      Promise.resolve().then(() =>
        inspectStagedPiNpm({
          stageDir: fixture.stageDir,
          tarballPath: fixture.tarballPath,
          release: { ...fixture.release, integrity: syntheticIntegrity(99) },
        }),
      ),
    ).rejects.toThrow(/pi-staged-lock:/);
  });

  it("fails closed when staged tarball bytes change after the lock (TOCTOU stage artifact)", async () => {
    const { inspectStagedPiNpm } = await loadStagedInspector();
    const fixture = buildStagedFixture();
    fs.writeFileSync(fixture.tarballPath, "tampered-after-lock\n");

    await expect(
      Promise.resolve().then(() =>
        inspectStagedPiNpm({
          stageDir: fixture.stageDir,
          tarballPath: fixture.tarballPath,
          release: fixture.release,
        }),
      ),
    ).rejects.toThrow(/pi-staged-lock:/);
  });

  it("fails closed on a missing companion before activation", async () => {
    const { inspectStagedPiNpm } = await loadStagedInspector();
    const fixture = buildStagedFixture();
    const missing = fixture.depEntries[0]?.name ?? STAGED_DEP_NAMES[0]!;

    const lock = readLock(fixture.stageDir);
    delete lock.packages[`node_modules/${missing}`];
    const remaining = { ...(lock.packages["node_modules/jorgex-pi"]?.["dependencies"] as Record<string, string>) };
    delete remaining[missing];
    lock.packages["node_modules/jorgex-pi"] = {
      ...(lock.packages["node_modules/jorgex-pi"] ?? {}),
      dependencies: remaining,
    };
    writeLock(fixture.stageDir, lock);
    fs.rmSync(path.join(fixture.stageDir, "npm", "node_modules", missing), { recursive: true, force: true });

    await expect(
      Promise.resolve().then(() =>
        inspectStagedPiNpm({
          stageDir: fixture.stageDir,
          tarballPath: fixture.tarballPath,
          release: fixture.release,
        }),
      ),
    ).rejects.toThrow(/pi-staged-lock:/);
  });

  it("fails closed on a foreign companion URL before activation", async () => {
    const { inspectStagedPiNpm } = await loadStagedInspector();
    const fixture = buildStagedFixture();
    const target = fixture.depEntries[1]!;

    const lock = readLock(fixture.stageDir);
    lock.packages[`node_modules/${target.name}`] = {
      ...(lock.packages[`node_modules/${target.name}`] ?? {}),
      resolved: `https://evil.example/${target.name}-${target.version}.tgz`,
    };
    writeLock(fixture.stageDir, lock);

    await expect(
      Promise.resolve().then(() =>
        inspectStagedPiNpm({
          stageDir: fixture.stageDir,
          tarballPath: fixture.tarballPath,
          release: fixture.release,
        }),
      ),
    ).rejects.toThrow(/pi-staged-lock:/);
  });

  it("fails closed on a nested second copy before activation", async () => {
    const { inspectStagedPiNpm } = await loadStagedInspector();
    const fixture = buildStagedFixture();
    const duplicated = fixture.depEntries[2]!;

    const lock = readLock(fixture.stageDir);
    lock.packages[`node_modules/jorgex-pi/node_modules/${duplicated.name}`] = {
      version: duplicated.version,
      resolved: canonicalDepUrl(duplicated.name, duplicated.version),
      integrity: duplicated.integrity,
    };
    writeLock(fixture.stageDir, lock);
    const nestedDir = path.join(
      fixture.stageDir,
      "npm",
      "node_modules",
      "jorgex-pi",
      "node_modules",
      duplicated.name,
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, "package.json"),
      `${JSON.stringify({ name: duplicated.name, version: duplicated.version }, null, 2)}\n`,
    );

    await expect(
      Promise.resolve().then(() =>
        inspectStagedPiNpm({
          stageDir: fixture.stageDir,
          tarballPath: fixture.tarballPath,
          release: fixture.release,
        }),
      ),
    ).rejects.toThrow(/pi-staged-lock:/);
  });
});
