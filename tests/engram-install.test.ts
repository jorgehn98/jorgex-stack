import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pinFixture = vi.hoisted(() => ({
  version: "1.20.0",
  assets: {
    linux_x64: {
      name: "engram_1.20.0_linux_amd64.tar.gz",
      size: 0,
      sha256: "",
    },
  },
}));

vi.mock("../src/lib/engram-release.json", () => ({ default: pinFixture }));

type InstallResult =
  | { ok: true; bin: string }
  | { ok: false; reason: string };

type InstallMissingEngram = (options: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof globalThis.fetch;
}) => Promise<InstallResult>;

async function installMissingEngram(): Promise<InstallMissingEngram> {
  const module = await import("../src/lib/engram-install.js") as Partial<{
    installMissingEngram: InstallMissingEngram;
  }>;
  return module.installMissingEngram as InstallMissingEngram;
}

let fixtureRoot: string;
let archiveBytes: Buffer;
let binaryBytes: Buffer;
let fixtureSha256: string;
const installRoots: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(fixtureRoot, "home-"));
  installRoots.push(home);
  return home;
}

function fixtureFetch(bytes = archiveBytes): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    calls.push(String(input));
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function failingFetch(message: string): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    calls.push(String(input));
    throw new Error(message);
  });
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function expectedReleaseUrl(): string {
  const asset = pinFixture.assets.linux_x64;
  return `https://github.com/Gentleman-Programming/engram/releases/download/v${pinFixture.version}/${asset.name}`;
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-engram-install-fixture-"));
  binaryBytes = Buffer.from("#!/bin/sh\nprintf 'fixture engram\\n'\n");
  const binaryPath = path.join(fixtureRoot, "engram");
  fs.writeFileSync(binaryPath, binaryBytes, { mode: 0o755 });
  fs.chmodSync(binaryPath, 0o755);

  const archivePath = path.join(fixtureRoot, pinFixture.assets.linux_x64.name);
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, "engram"], { stdio: "pipe" });
  archiveBytes = fs.readFileSync(archivePath);
  fixtureSha256 = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  pinFixture.assets.linux_x64.size = archiveBytes.byteLength;
  pinFixture.assets.linux_x64.sha256 = fixtureSha256;
});

beforeEach(() => {
  vi.resetModules();
  pinFixture.assets.linux_x64.sha256 = fixtureSha256;
});

afterEach(() => {
  for (const root of installRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installMissingEngram", () => {
  it("conserva el binario existente en el destino y no descarga nada", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const existingBytes = Buffer.from("existing installation");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, existingBytes, { mode: 0o755 });
    const network = fixtureFetch();

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: network.fetch,
    });

    expect(result).toEqual({ ok: true, bin });
    expect(network.calls).toEqual([]);
    expect(fs.readFileSync(bin)).toEqual(existingBytes);
  });

  it("rechaza un artefacto cuyo SHA-256 no coincide y no publica el binario", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fixtureFetch();
    pinFixture.assets.linux_x64.sha256 = "0".repeat(64);

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: network.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/hash|integrity/i) });
    expect(network.calls).toEqual([expectedReleaseUrl()]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("descarga el asset Linux x64, verifica el tar real y publica un ejecutable", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fixtureFetch();

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: network.fetch,
    });

    expect(result).toEqual({ ok: true, bin });
    expect(network.calls).toEqual([expectedReleaseUrl()]);
    expect(fs.readFileSync(bin)).toEqual(binaryBytes);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  });

  it("aborta una descarga que supera el tamaño aprobado sin publicar nada", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fixtureFetch(Buffer.concat([archiveBytes, Buffer.from("overflow")]));

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: network.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/tamaño|size|supera|approved/i) });
    expect(network.calls).toEqual([expectedReleaseUrl()]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("falla cerrado ante un error de red y no crea el destino", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = failingFetch("network unavailable");

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: network.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("network unavailable") });
    expect(network.calls).toEqual([expectedReleaseUrl()]);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it.each([
    {
      name: "un archivo no ejecutable",
      setup(bin: string) {
        const bytes = Buffer.from("manual non-executable installation");
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, bytes, { mode: 0o644 });
        fs.chmodSync(bin, 0o644);
        return { bytes, reason: /access|permission|ejecut|EACCES/i };
      },
    },
    {
      name: "un directorio",
      setup(bin: string) {
        fs.mkdirSync(path.join(bin, "sentinel"), { recursive: true });
        return { bytes: null, reason: /archivo|file/i };
      },
    },
  ])("conserva $name existente y no descarga", async ({ setup }) => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fixtureFetch();
    const before = setup(bin);

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: network.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(before.reason) });
    expect(network.calls).toEqual([]);
    if (before.bytes !== null) expect(fs.readFileSync(bin)).toEqual(before.bytes);
    else expect(fs.existsSync(path.join(bin, "sentinel"))).toBe(true);
  });

  it("no sobrescribe un destino creado durante la descarga", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const existingBytes = Buffer.from("another installer won the race");
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push(String(input));
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, existingBytes, { mode: 0o755 });
      return new Response(new Uint8Array(archiveBytes), { status: 200 });
    });

    const result = await (await installMissingEngram())({
      homeDir,
      platform: "linux",
      arch: "x64",
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/exist|EEXIST/i) });
    expect(calls).toEqual([expectedReleaseUrl()]);
    expect(fs.readFileSync(bin)).toEqual(existingBytes);
  });
});
