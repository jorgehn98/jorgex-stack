import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMissingEngram } from "../src/lib/engram-install.js";

/**
 * T17 RED: latest-stable installer via GitHub `releases/latest`.
 *
 * Intended contract (no production change here):
 * - `GET https://api.github.com/repos/Gentleman-Programming/engram/releases/latest`
 *   is the single source of latest-stable metadata (GitHub excludes drafts and
 *   prereleases; no own semver selection).
 * - The asset must match exactly version + platform + arch, with
 *   `state === "uploaded"`, positive `size`, official HTTPS
 *   `browser_download_url` and `digest === "sha256:<64 hex>"`.
 * - Missing/ambiguous/malformed metadata, HTTP/network failures, oversize and
 *   hash mismatch all fail closed with no binary published and no static fallback.
 * - Existing binary and atomic race guards are preserved.
 * - No `src/lib/engram-release.json` mock is needed: this file deliberately
 *   contains no `vi.mock("../src/lib/engram-release.json")`.
 */

const LATEST_URL = "https://api.github.com/repos/Gentleman-Programming/engram/releases/latest";
const OFFICIAL_PREFIX = "https://github.com/Gentleman-Programming/engram/releases/download/";

const LIVE_TAG = "v9.9.9";
const LIVE_VERSION = "9.9.9";

type ReleaseAsset = {
  name: string;
  size: number;
  state: string;
  browser_download_url: string;
  digest: string | null;
};

type ReleasePayload = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

function expectedAssetName(version: string, platform: NodeJS.Platform, arch: string): string | null {
  const osPart = platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  const archPart = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (osPart === null || archPart === null) return null;
  const ext = osPart === "windows" ? "zip" : "tar.gz";
  return `engram_${version}_${osPart}_${archPart}.${ext}`;
}

function binaryNameFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? "engram.exe" : "engram";
}

let fixtureRoot: string;
let archiveBytes: Buffer;
let linuxBinary: Buffer;
let windowsBinary: Buffer;
let archiveShaHex: string;
let archiveDigest: string;
const installRoots: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(fixtureRoot, "home-"));
  installRoots.push(home);
  return home;
}

function liveAsset(platform: NodeJS.Platform, arch: string, overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
  const name = expectedAssetName(LIVE_VERSION, platform, arch)!;
  return {
    name,
    size: archiveBytes.byteLength,
    state: "uploaded",
    browser_download_url: `${OFFICIAL_PREFIX}${LIVE_TAG}/${name}`,
    digest: archiveDigest,
    ...overrides,
  };
}

function releasePayload(assets: ReleaseAsset[], tag: string | undefined = LIVE_TAG): ReleasePayload {
  return tag === undefined ? { assets } : { tag_name: tag, assets };
}

/** Injected-fetch double: serves releases/latest JSON once, then the asset bytes. */
function latestFetch(opts: {
  release: ReleasePayload | null;
  releaseStatus?: number;
  releaseThrows?: string;
  assetBytes?: Buffer | null;
  assetStatus?: number;
  assetThrows?: string;
}): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === LATEST_URL) {
      if (opts.releaseThrows !== undefined) throw new Error(opts.releaseThrows);
      const status = opts.releaseStatus ?? 200;
      if (status !== 200 || opts.release === null) {
        return new Response("release error", { status });
      }
      return new Response(JSON.stringify(opts.release), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Asset download: only the official live asset URL is served.
    if (opts.assetThrows !== undefined) throw new Error(opts.assetThrows);
    if ((opts.assetStatus ?? 200) !== 200 || opts.assetBytes === null) {
      return new Response("asset error", { status: opts.assetStatus ?? 404 });
    }
    const bytes = opts.assetBytes ?? archiveBytes;
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-engram-latest-fixture-"));
  linuxBinary = Buffer.from("#!/bin/sh\nprintf 'live engram\\n'\n");
  windowsBinary = Buffer.from("live engram.exe bytes\n");
  fs.writeFileSync(path.join(fixtureRoot, "engram"), linuxBinary, { mode: 0o755 });
  fs.writeFileSync(path.join(fixtureRoot, "engram.exe"), windowsBinary, { mode: 0o755 });
  fs.chmodSync(path.join(fixtureRoot, "engram"), 0o755);
  const archivePath = path.join(fixtureRoot, "live.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, "engram", "engram.exe"], { stdio: "pipe" });
  archiveBytes = fs.readFileSync(archivePath);
  archiveShaHex = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  archiveDigest = `sha256:${archiveShaHex}`;
});

afterEach(() => {
  for (const root of installRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("[T17-RED] live latest-stable endpoint, not static pin", () => {
  it("resolves linux x64 from releases/latest and downloads the exact live asset", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const asset = liveAsset("linux", "x64");
    const network = latestFetch({ release: releasePayload([asset]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toEqual({ ok: true, bin });
    expect(network.calls).toEqual([LATEST_URL, asset.browser_download_url]);
    expect(fs.readFileSync(bin)).toEqual(linuxBinary);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  });

  it.each([
    { platform: "darwin" as const, arch: "arm64" },
    { platform: "win32" as const, arch: "x64" },
  ])("selects the exact version+platform+arch asset for $platform/$arch", async ({ platform, arch }) => {
    const homeDir = temporaryHome();
    const asset = liveAsset(platform, arch);
    // Release carries several assets; only the exact match may be used.
    const others = [liveAsset("linux", "x64"), liveAsset("linux", "arm64")].filter((a) => a.name !== asset.name);
    const network = latestFetch({ release: releasePayload([...others, asset]) });

    const result = await installMissingEngram({ homeDir, platform, arch, fetch: network.fetch });

    const bin = path.join(homeDir, ".local", "bin", binaryNameFor(platform));
    expect(result).toEqual({ ok: true, bin });
    expect(network.calls).toEqual([LATEST_URL, asset.browser_download_url]);
    expect(fs.readFileSync(bin)).toEqual(platform === "win32" ? windowsBinary : linuxBinary);
  });

  it("rejects unsupported arch without downloading any asset", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64")]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "ia32", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });
});

describe("[T17-RED] release/asset absent or ambiguous fails closed", () => {
  it.each(["missing tag", "empty assets", "no matching asset"] as const)(
    "fails closed on %s without asset download",
    async (name) => {
      const homeDir = temporaryHome();
      const bin = path.join(homeDir, ".local", "bin", "engram");
      const payload =
        name === "missing tag"
          ? { assets: [liveAsset("linux", "x64")] }
          : name === "empty assets"
            ? releasePayload([])
            : releasePayload([liveAsset("darwin", "arm64")]);
      const network = latestFetch({ release: payload });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("fails closed on duplicate exact-name assets without downloading", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const asset = liveAsset("linux", "x64");
    const network = latestFetch({ release: releasePayload([asset, { ...asset }]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it.each(["not-a-version", "v", "", "v9.9"])("rejects invalid tag %p without asset download", async (tag) => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64")], tag) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });
});

describe("[T17-RED] asset metadata integrity (state/size/URL/digest)", () => {
  it("rejects non-uploaded state without downloading", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64", { state: "open" })]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("rejects non-positive size without downloading", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64", { size: 0 })]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it.each([
    { name: "plain http", url: "http://github.com/Gentleman-Programming/engram/releases/download/v9.9.9/engram_9.9.9_linux_amd64.tar.gz" },
    { name: "foreign host", url: "https://evil.example/engram_9.9.9_linux_amd64.tar.gz" },
    { name: "empty", url: "" },
  ])("rejects $name asset URL without downloading", async ({ url }) => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64", { browser_download_url: url })]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it.each([
    { name: "null", digest: null },
    { name: "empty", digest: "" },
    { name: "no prefix", digest: archiveShaHex },
    { name: "short hex", digest: "sha256:abc" },
    { name: "non-hex", digest: `sha256:${"z".repeat(64)}` },
  ])("rejects $name digest without downloading", async ({ digest }) => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64", { digest: digest as string })]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });
});

describe("[T17-RED] HTTP/network, oversize and hash mismatch", () => {
  it("fails closed on releases/latest HTTP error without asset download", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: null, releaseStatus: 404 });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("fails closed on releases/latest network error without creating the destination", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64")]), releaseThrows: "network unavailable" });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("network unavailable") });
    expect(network.calls).toEqual([LATEST_URL]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("fails closed on asset download HTTP error", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const asset = liveAsset("linux", "x64");
    const network = latestFetch({ release: releasePayload([asset]), assetBytes: null, assetStatus: 404 });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false });
    expect(network.calls).toEqual([LATEST_URL, asset.browser_download_url]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("aborts an oversize live download without publishing", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const asset = liveAsset("linux", "x64");
    const network = latestFetch({
      release: releasePayload([asset]),
      assetBytes: Buffer.concat([archiveBytes, Buffer.from("overflow")]),
    });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/tamaño|size|supera|approved/i) });
    expect(network.calls).toEqual([LATEST_URL, asset.browser_download_url]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("rejects a live asset hash mismatch without publishing", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const asset = liveAsset("linux", "x64", { digest: `sha256:${"0".repeat(64)}` });
    const network = latestFetch({
      release: releasePayload([asset]),
    });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/hash|integrity/i) });
    expect(network.calls).toEqual([LATEST_URL, asset.browser_download_url]);
    expect(fs.existsSync(bin)).toBe(false);
  });
});

describe("[T17-RED] existing and race guards under live resolution", () => {
  it("control: preserves an existing binary without any network", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const existingBytes = Buffer.from("existing installation");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, existingBytes, { mode: 0o755 });
    const network = latestFetch({ release: releasePayload([liveAsset("linux", "x64")]) });

    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });

    expect(result).toEqual({ ok: true, bin });
    expect(network.calls).toEqual([]);
    expect(fs.readFileSync(bin)).toEqual(existingBytes);
  });

  it("does not overwrite a destination created during the live download", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const existingBytes = Buffer.from("another installer won the race");
    const asset = liveAsset("linux", "x64");
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === LATEST_URL) {
        return new Response(JSON.stringify(releasePayload([asset])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, existingBytes, { mode: 0o755 });
      return new Response(new Uint8Array(archiveBytes), { status: 200 });
    });

    const result = await installMissingEngram({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/exist|EEXIST/i) });
    expect(calls).toEqual([LATEST_URL, asset.browser_download_url]);
    expect(fs.readFileSync(bin)).toEqual(existingBytes);
  });
});

describe("[T17-RED] no static release source", () => {
  it("engram-install no longer sources the static release pin", () => {
    const source = fs.readFileSync(new URL("../src/lib/engram-install.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/engram-release\.json/);
  });
});
