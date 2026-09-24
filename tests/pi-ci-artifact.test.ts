import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Pi CI artifact records the verified provider release observed for this run.
 *
 * Intended code-facing contract (no production change here):
 * - `prepareObservedPiCiArtifact({ tarballPath, candidatePath, fetchImpl })`
 *   exported from `src/lib/pi-ci-artifact.ts` (small TS entry, existing tsup).
 * - Reuses product `resolveLatestPiRelease(fetchImpl)` then
 *   `downloadVerifiedPiTarball(release, tarballPath, fetchImpl)` with exact
 *   SRI/size/hash; writes a bounded private JSON
 *   `{ version, tarballUrl, integrity, bytes, sha256, sha512 }` only after the
 *   tarball is verified. No static future pin.
 * - Synthetic `9.9.x` values below are test-only packuments, not
 *   published-version claims. Real tmp filesystem seam with injected mocked
 *   fetch Responses for the npm packument + exact tarball; no real network,
 *   no HOME.
 */

type PiCiArtifact = {
  version: string;
  tarballUrl: string;
  integrity: string;
  bytes: number;
  sha256: string;
  sha512: string;
};

type PiCiArtifactModule = {
  prepareObservedPiCiArtifact(input: {
    tarballPath: string;
    candidatePath: string;
    fetchImpl: typeof fetch;
  }): Promise<PiCiArtifact>;
};

const artifactSpecifier = new URL("../src/lib/pi-ci-artifact.js", import.meta.url).href;

async function loadArtifact(): Promise<PiCiArtifactModule> {
  const mod = (await import(/* @vite-ignore */ artifactSpecifier)) as Partial<PiCiArtifactModule>;
  expect(
    mod.prepareObservedPiCiArtifact,
    "prepareObservedPiCiArtifact must be exported from src/lib/pi-ci-artifact.ts",
  ).toBeTypeOf("function");
  return mod as PiCiArtifactModule;
}

const REGISTRY_URL = "https://registry.npmjs.org/jorgex-pi";

function canonicalTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

function syntheticPackument(latest: string, integrity: string, tarballOverride?: string): unknown {
  const tarball = tarballOverride ?? canonicalTarballUrl(latest);
  return {
    name: "jorgex-pi",
    "dist-tags": { latest },
    versions: {
      [latest]: {
        name: "jorgex-pi",
        version: latest,
        dist: { tarball, integrity },
      },
    },
  };
}

function syntheticTarballBytes(version: string): Buffer {
  return Buffer.from(`synthetic-jorgex-pi-tarball-${version}\n`.repeat(256));
}

function sriFor(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-ci-artifact-"));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type SeenFetch = { url: string; redirect?: string };

function observedFetch(
  pack: unknown,
  tarballBytes: Buffer,
  tarballUrl: string,
  seen: SeenFetch[],
  opts?: { packumentUrlOverride?: string; tarballUrlOverride?: string },
): typeof fetch {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    if (url === REGISTRY_URL) {
      const response = new Response(JSON.stringify(pack), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: opts?.packumentUrlOverride ?? url });
      return response;
    }
    if (url === tarballUrl) {
      const response = new Response(new Uint8Array(tarballBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(tarballBytes.byteLength),
        },
      });
      Object.defineProperty(response, "url", { value: opts?.tarballUrlOverride ?? url });
      return response;
    }
    const notFound = new Response("not found", { status: 404 });
    Object.defineProperty(notFound, "url", { value: url });
    return notFound;
  });
  return fetch as unknown as typeof fetch;
}

function expectPrivateCandidateFile(candidatePath: string, expected: PiCiArtifact): void {
  const lstat = fs.lstatSync(candidatePath);
  expect(lstat.isSymbolicLink()).toBe(false);
  expect(lstat.isFile()).toBe(true);
  const stat = fs.statSync(candidatePath);
  expect(stat.size).toBeLessThan(64 * 1024);
  expect(stat.mode & 0o077).toBe(0);
  const raw = fs.readFileSync(candidatePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual([
    "bytes",
    "integrity",
    "sha256",
    "sha512",
    "tarballUrl",
    "version",
  ]);
  expect(parsed).toEqual({
    version: expected.version,
    tarballUrl: expected.tarballUrl,
    integrity: expected.integrity,
    bytes: expected.bytes,
    sha256: expected.sha256,
    sha512: expected.sha512,
  });
}

describe("pi CI observed release artifact", () => {
  it("observes two distinct dist-tags.latest candidates with verified tarball + private candidate JSON", async () => {
    const { prepareObservedPiCiArtifact } = await loadArtifact();

    const versions = ["9.9.10", "9.9.11"] as const;
    const observed: PiCiArtifact[] = [];

    for (const version of versions) {
      const bytes = syntheticTarballBytes(version);
      const integrity = sriFor(bytes);
      const tarballUrl = canonicalTarballUrl(version);
      const expected: PiCiArtifact = {
        version,
        tarballUrl,
        integrity,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sha512: createHash("sha512").update(bytes).digest("hex"),
      };
      const dir = sandbox();
      const tarballPath = path.join(dir, `jorgex-pi-${version}.tgz`);
      const candidatePath = path.join(dir, `pi-ci-candidate-${version}.json`);
      const seen: SeenFetch[] = [];
      const fetchImpl = observedFetch(syntheticPackument(version, integrity), bytes, tarballUrl, seen);

      const result = await prepareObservedPiCiArtifact({ tarballPath, candidatePath, fetchImpl });

      expect(result).toMatchObject(expected);
      expect(fs.readFileSync(tarballPath)).toEqual(bytes);
      expectPrivateCandidateFile(candidatePath, expected);
      expect(seen.map((entry) => entry.url)).toEqual([REGISTRY_URL, tarballUrl]);
      for (const entry of seen) expect(entry.redirect).toBe("error");
      observed.push(result as PiCiArtifact);
    }

    expect(observed).toHaveLength(2);
    expect(observed[0]?.version).toBe("9.9.10");
    expect(observed[1]?.version).toBe("9.9.11");
    expect(observed[0]).not.toEqual(observed[1]);
    expect(observed[0]?.version).not.toBe("0.8.29");
    expect(observed[1]?.version).not.toBe("0.8.29");
  });

  it.each([
    { label: "wrong SRI" },
    { label: "foreign tarball URL" },
    { label: "redirected tarball response" },
  ])("$label rejects without candidate or tarball file", async ({ label }) => {
    const { prepareObservedPiCiArtifact } = await loadArtifact();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(version);
    const canonicalUrl = canonicalTarballUrl(version);

    let pack: unknown;
    let serveUrl = canonicalUrl;
    let tarballUrlOverride: string | undefined;
    if (label === "wrong SRI") {
      pack = syntheticPackument(version, sriFor(Buffer.from("unrelated-test-bytes")));
    } else if (label === "foreign tarball URL") {
      const foreign = "https://evil.example/jorgex-pi-9.9.10.tgz";
      pack = syntheticPackument(version, sriFor(bytes), foreign);
      serveUrl = foreign;
    } else {
      pack = syntheticPackument(version, sriFor(bytes));
      tarballUrlOverride = `${canonicalUrl}?redirected=1`;
    }

    const dir = sandbox();
    const tarballPath = path.join(dir, `jorgex-pi-${version}.tgz`);
    const candidatePath = path.join(dir, "pi-ci-candidate.json");
    const seen: SeenFetch[] = [];
    const fetchImpl = observedFetch(pack, bytes, serveUrl, seen, { tarballUrlOverride });

    await expect(
      prepareObservedPiCiArtifact({ tarballPath, candidatePath, fetchImpl }),
    ).rejects.toThrow(/pi-(ci-artifact|release-resolver):/);
    expect(fs.existsSync(candidatePath)).toBe(false);
    expect(fs.existsSync(tarballPath)).toBe(false);
    expect(seen[0]?.redirect).toBe("error");
  });

  it("fails closed on a preexisting symlink candidate path without following it", async () => {
    const { prepareObservedPiCiArtifact } = await loadArtifact();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(version);
    const integrity = sriFor(bytes);
    const tarballUrl = canonicalTarballUrl(version);

    const dir = sandbox();
    const outsideDir = sandbox();
    const tarballPath = path.join(dir, `jorgex-pi-${version}.tgz`);
    const candidatePath = path.join(dir, "pi-ci-candidate.json");
    const targetFile = path.join(outsideDir, "outside.json");
    fs.writeFileSync(targetFile, `{"foreign":true}\n`, "utf8");
    fs.symlinkSync(targetFile, candidatePath);
    expect(fs.lstatSync(candidatePath).isSymbolicLink()).toBe(true);

    const seen: SeenFetch[] = [];
    const fetchImpl = observedFetch(syntheticPackument(version, integrity), bytes, tarballUrl, seen);

    await expect(
      prepareObservedPiCiArtifact({ tarballPath, candidatePath, fetchImpl }),
    ).rejects.toThrow(/pi-ci-artifact:/);
    expect(fs.lstatSync(candidatePath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(candidatePath)).toBe(targetFile);
    expect(fs.readFileSync(targetFile, "utf8")).toBe(`{"foreign":true}\n`);
  });
});
