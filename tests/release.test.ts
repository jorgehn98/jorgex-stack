import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// CI policy is JavaScript and is deliberately outside the installed runtime.
// @ts-expect-error The release script has no TypeScript declaration.
import { releasePlan, registryVersion, verifyIntegrity, confirmPublished, publicationNeeded, normalizeSha, validateVersion } from "../.github/scripts/release-policy.mjs";

const sha = "a".repeat(40);
const mainSha = "b".repeat(40);
const integrity = "sha512-" + "A".repeat(86) + "==";
const input = { version: "2.0.0", registry: null, tagSha: null, sha, mainSha: sha, recovery: false };

describe("version prepared in the PR", () => {
  it("publishes a new current version, but never bumps an existing one", () => {
    expect(releasePlan(input)).toEqual({ publish: true, needed: true });
    expect(releasePlan({ ...input, registry: { integrity }, tagSha: mainSha })).toEqual({ publish: false, needed: false });
    expect(() => releasePlan({ ...input, registry: { integrity } })).toThrow(/release_sha/);
    expect(() => releasePlan({ ...input, mainSha })).toThrow(/historical/);
    expect(() => releasePlan({ ...input, tagSha: mainSha })).toThrow(/different SHA/);
  });

  it("recovery uses the exact SHA and matching bytes, never republishes", () => {
    expect(releasePlan({ ...input, recovery: true, registry: { integrity }, mainSha })).toEqual({ publish: false, needed: true });
    expect(() => releasePlan({ ...input, recovery: true, registry: { integrity }, tagSha: mainSha })).toThrow(/different SHA/);
    expect(() => verifyIntegrity({ integrity: "sha512-different" }, integrity)).toThrow(/integrity/);
    expect(() => verifyIntegrity(null, integrity)).toThrow(/unavailable/);
    expect(verifyIntegrity({ integrity }, integrity)).toBeUndefined();
    expect(publicationNeeded(null, integrity, true)).toBe(true);
    expect(publicationNeeded({ integrity }, integrity, true, true)).toBe(false); // rerun after successful publish
    expect(() => publicationNeeded(null, integrity, true, true)).toThrow(/never republish/);
    expect(publicationNeeded({ integrity }, integrity, false)).toBe(false); // recovery
    expect(() => publicationNeeded(null, integrity, false)).toThrow(/unavailable/);
    expect(() => publicationNeeded({ integrity: "sha512-different" }, integrity, true)).toThrow(/integrity/);
  });

  it("only a registry 404 means absent; authentication and bad metadata fail closed", async () => {
    const fetcher = (status: number, value = {}) => async () => ({ status, ok: status === 200, json: async () => value });
    expect(await registryVersion("jorgex-stack", "2.0.0", fetcher(404))).toBeNull();
    await expect(registryVersion("jorgex-stack", "2.0.0", fetcher(403))).rejects.toThrow(/403/);
    await expect(registryVersion("jorgex-stack", "2.0.0", fetcher(200))).rejects.toThrow(/metadata/);
    await expect(registryVersion("jorgex-stack", "2.0.0", async () => { throw new Error("network"); })).rejects.toThrow(/network/);
    expect(await registryVersion("jorgex-stack", "2.0.0", fetcher(200, { name: "jorgex-stack", version: "2.0.0", dist: { integrity } }))).toEqual({ integrity });
  });

  describe("readback after publish", () => {
    const published = { name: "jorgex-stack", version: "2.0.0", dist: { integrity } };
    const registry = (...responses: Array<[number, object?]>) => {
      const sleeps: number[] = [];
      let calls = 0;
      const fetcher = async () => {
        const [status, value = {}] = responses[Math.min(calls++, responses.length - 1)]!;
        return { status, ok: status === 200, json: async () => value };
      };
      return { sleeps, calls: () => calls, options: { fetcher, sleep: async (ms: number) => { sleeps.push(ms); } } };
    };

    it("waits through propagation 404s until the version appears", async () => {
      const npm = registry([404], [404], [200, published]);
      await expect(confirmPublished("jorgex-stack", "2.0.0", integrity, npm.options)).resolves.toBeUndefined();
      expect(npm.calls()).toBe(3);
      expect(npm.sleeps).toEqual([15_000, 15_000]);
    });

    it("stops at five minutes of absence without authorizing a republish", async () => {
      const npm = registry([404]);
      await expect(confirmPublished("jorgex-stack", "2.0.0", integrity, npm.options)).rejects.toThrow(/unavailable; do not republish/);
      expect(npm.calls()).toBe(21);
      expect(npm.sleeps).toHaveLength(20);
      expect(npm.sleeps.reduce((total, ms) => total + ms, 0)).toBe(300_000);
    });

    it("fails immediately when the published bytes differ", async () => {
      const npm = registry([404], [200, { ...published, dist: { integrity: "sha512-" + "B".repeat(86) + "==" } }], [200, published]);
      await expect(confirmPublished("jorgex-stack", "2.0.0", integrity, npm.options)).rejects.toThrow(/integrity differs/);
      expect(npm.calls()).toBe(2);
    });

    it.each([401, 500])("fails on HTTP %i at the first attempt, without retrying", async (status) => {
      const npm = registry([status], [200, published]);
      await expect(confirmPublished("jorgex-stack", "2.0.0", integrity, npm.options)).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(npm.calls()).toBe(1);
      expect(npm.sleeps).toEqual([]);
    });

    it("fails on metadata that does not identify the version, without retrying", async () => {
      const npm = registry([200, { ...published, version: "2.0.1" }], [200, published]);
      await expect(confirmPublished("jorgex-stack", "2.0.0", integrity, npm.options)).rejects.toThrow(/metadata/);
      expect(npm.calls()).toBe(1);
    });

    it("does not retry a network failure", async () => {
      let calls = 0;
      const fetcher = async () => { calls++; throw new Error("network"); };
      await expect(confirmPublished("jorgex-stack", "2.0.0", integrity, { fetcher, sleep: async () => {} })).rejects.toThrow(/network/);
      expect(calls).toBe(1);
    });
  });

  it("checks the real tarball before registry access or publication", () => {
    const temp = mkdtempSync("/var/tmp/stack-release-test-");
    try {
      mkdirSync(join(temp, "package"));
      writeFileSync(join(temp, "package/package.json"), JSON.stringify({ name: "jorgex-stack", version: "2.0.0" }));
      const tarball = join(temp, "package.tgz");
      execFileSync("tar", ["-czf", tarball, "-C", temp, "package"], { timeout: 5_000 });
      const result = spawnSync(process.execPath, [".github/scripts/release-policy.mjs", "verify", tarball], {
        env: { ...process.env, VERSION: "2.0.0", INTEGRITY: integrity }, encoding: "utf8", timeout: 5_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Artifact changed after validation");
      const wrongVersion = spawnSync(process.execPath, [".github/scripts/release-policy.mjs", "verify", tarball], {
        env: { ...process.env, VERSION: "2.0.1", INTEGRITY: integrity }, encoding: "utf8", timeout: 5_000,
      });
      expect(wrongVersion.status).toBe(1);
      expect(wrongVersion.stderr).toContain("Tarball package/version differs");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects placeholders and mutable or malformed refs", () => {
    expect(validateVersion("2.0.0")).toBe("2.0.0");
    for (const version of ["0.0.0-stage", "02.0.0", "2.0", "2.0.0\n"]) expect(() => validateVersion(version)).toThrow();
    expect(normalizeSha(sha.toUpperCase())).toBe(sha);
    expect(() => normalizeSha("main")).toThrow(/40/);
  });
});
