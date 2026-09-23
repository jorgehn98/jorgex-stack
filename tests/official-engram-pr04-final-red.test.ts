import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMissingEngram, type EngramInstallResult } from "../src/lib/engram-install.js";
import { resolvePiEngramRequirement } from "../src/lib/pi-runtime.js";
import { __resetGithubState } from "../src/lib/github.js";

/**
 * PR04 final-review RED net (tests only, no production change).
 *
 * Each section targets one accepted finding. Tests marked RED must FAIL now
 * for the intended behavioral reason; controls marked CONTROL must PASS.
 * All fixtures are isolated temp dirs; injected fetch only; no HOME, no network.
 *
 * 2) Installer release body: 200 null/array/string => clear invalid-metadata
 *    reason; JSON AbortError/transport preserves network cause distinct from
 *    SyntaxError; metadata 429/403 report metadata-query phase + actionable
 *    rate-limit wording (403 hedged: no definitive rate-limit overclaim
 *    without header evidence).
 * 3) Asset max bound: approved size above fixed 64MiB ceiling rejects BEFORE
 *    asset download; positive size control remains.
 * 4) URL same-host wrong-tag and prerelease/build tag shapes reject BEFORE
 *    download (currently correct: locked as controls).
 * 5) Stream cancel failure preserves original oversize/read error (reason
 *    contains both when feasible), not replaces it.
 * 6) Staging cleanup failure after publish is observable without reporting
 *    binary absent. Proposed contract {ok:true,bin,warning} (pending owner);
 *    strongest seam without inventing API is at minimum ok:true + bin exists.
 *    Cleanup failure after primary error preserves primary+cleanup causes.
 * 7) Pi installShared carries structured installer failure reason through
 *    resolver/CLI remedy rather than boolean (behavioral, not source-text).
 */

const LATEST_URL = "https://api.github.com/repos/Gentleman-Programming/engram/releases/latest";
const OFFICIAL_PREFIX = "https://github.com/Gentleman-Programming/engram/releases/download/";
const LIVE_TAG = "v9.9.9";
const LIVE_VERSION = "9.9.9";
const CEILING = 64 * 1024 * 1024;

let fixtureRoot: string;
let archiveBytes: Buffer;
let linuxBinary: Buffer;
let archiveShaHex: string;
let archiveDigest: string;
const installRoots: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(fixtureRoot, "home-"));
  installRoots.push(home);
  return home;
}

function expectedName(version: string): string {
  return `engram_${version}_linux_amd64.tar.gz`;
}

function assetUrl(tag: string, name: string): string {
  return `${OFFICIAL_PREFIX}${tag}/${name}`;
}

type FakeAsset = {
  name: string;
  size: number;
  state: string;
  browser_download_url: string;
  digest: string | null;
};

function liveAsset(overrides: Partial<FakeAsset> = {}): FakeAsset {
  const name = expectedName(LIVE_VERSION);
  return {
    name,
    size: archiveBytes.byteLength,
    state: "uploaded",
    browser_download_url: assetUrl(LIVE_TAG, name),
    digest: archiveDigest,
    ...overrides,
  };
}

function releaseJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Minimal fetch double: serves LATEST_URL once, then asset bytes (or custom). */
function fetchFor(opts: {
  release: unknown | { __throwJson: Error } | null;
  releaseStatus?: number;
  releaseThrows?: string;
  assetBytes?: Buffer | null;
  assetStatus?: number;
  customBody?: unknown;
}): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === LATEST_URL) {
      if (opts.releaseThrows !== undefined) throw new Error(opts.releaseThrows);
      const status = opts.releaseStatus ?? 200;
      if (status !== 200) return new Response("release error", { status });
      const rel = opts.release as Record<string, unknown> | null;
      if (rel !== null && typeof rel === "object" && "__throwJson" in rel) {
        const err = (rel as { __throwJson: Error }).__throwJson;
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw err;
          },
        } as unknown as Response;
      }
      return releaseJson(opts.release);
    }
    if (opts.customBody !== undefined) {
      return { ok: true, status: 200, body: opts.customBody } as unknown as Response;
    }
    if ((opts.assetStatus ?? 200) !== 200 || opts.assetBytes === null) {
      return new Response("asset error", { status: opts.assetStatus ?? 404 });
    }
    const bytes = opts.assetBytes ?? archiveBytes;
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pr04-final-fixture-"));
  linuxBinary = Buffer.from("#!/bin/sh\nprintf 'live engram\\n'\n");
  fs.writeFileSync(path.join(fixtureRoot, "engram"), linuxBinary, { mode: 0o755 });
  fs.chmodSync(path.join(fixtureRoot, "engram"), 0o755);
  const archivePath = path.join(fixtureRoot, "live.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, "engram"], { stdio: "pipe" });
  archiveBytes = fs.readFileSync(archivePath);
  archiveShaHex = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  archiveDigest = `sha256:${archiveShaHex}`;
});

afterEach(() => {
  for (const root of installRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  __resetGithubState();
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function reasonOf(result: unknown): string {
  if (typeof result === "object" && result !== null && "reason" in result) {
    return String((result as { reason: unknown }).reason ?? "");
  }
  return "";
}

// ---------------------------------------------------------------------------
// 2a) 200 null/array/string => clear invalid-metadata reason, no download
// RED: null currently throws TypeError; array/string report generic tag
// invalid instead of the clear release-metadata wording.
// ---------------------------------------------------------------------------

describe("[pr04-2a-RED] release body null/array/string reports invalid metadata", () => {
  it.each([
    { name: "null", body: null },
    { name: "array", body: [] },
    { name: "string", body: "hello" },
  ])("200 $name => ok:false with clear invalid-metadata reason, no asset download", async ({ body }) => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fetchFor({ release: body });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    expect(reasonOf(result)).toMatch(/metadatos del release inválidos/i);
    expect(fs.existsSync(bin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2b) JSON AbortError/transport preserves network cause distinct from SyntaxError
// RED: AbortError and transport errors are currently collapsed to the same
// generic invalid-metadata wording, losing the network cause.
// CONTROL: SyntaxError remains invalid-metadata.
// ---------------------------------------------------------------------------

describe("[pr04-2b] release JSON read errors", () => {
  it("CONTROL: SyntaxError => invalid-metadata reason", async () => {
    const homeDir = temporaryHome();
    const syntax = new SyntaxError("Unexpected token in JSON");
    const network = fetchFor({ release: { __throwJson: syntax } });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    expect(reasonOf(result)).toMatch(/metadatos del release inválidos/i);
  });

  it("RED: AbortError preserves abort/network cause, distinct from SyntaxError", async () => {
    const homeDir = temporaryHome();
    const abort = Object.assign(new Error("body aborted"), { name: "AbortError" });
    const network = fetchFor({ release: { __throwJson: abort } });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    // Must preserve the network cause, not collapse to generic wording alone.
    expect(reasonOf(result)).toMatch(/abort|interrump|cancel|red|network|timeout/i);
    expect(reasonOf(result)).toContain("body aborted");
  });

  it("RED: transport error in JSON read preserves its cause", async () => {
    const homeDir = temporaryHome();
    const transport = new Error("ECONNRESET");
    const network = fetchFor({ release: { __throwJson: transport } });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    expect(reasonOf(result)).toContain("ECONNRESET");
  });
});

// ---------------------------------------------------------------------------
// 2c) Metadata 429/403 report phase + actionable wording (403 hedged)
// RED: currently "Descarga Engram fallida: HTTP 429/403." with no phase and
// no GH_TOKEN/gh remedy.
// ---------------------------------------------------------------------------

describe("[pr04-2c-RED] metadata HTTP 429/403 phase and remedy", () => {
  it("RED: 429 reports metadata phase + actionable rate-limit wording, no download", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fetchFor({ release: null, releaseStatus: 429 });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    const reason = reasonOf(result);
    expect(reason).toMatch(/metadatos|metadata|release/i);
    expect(reason).toMatch(/rate limit/i);
    expect(reason).toMatch(/GH_TOKEN|gh auth|gh\b/i);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("RED: 403 reports metadata phase + actionable remedy without definitive overclaim", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fetchFor({ release: null, releaseStatus: 403 });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    const reason = reasonOf(result);
    expect(reason).toMatch(/metadatos|metadata|release/i);
    expect(reason).toMatch(/GH_TOKEN|gh auth|gh\b/i);
    // Do not overclaim 403 as definitively rate-limit without header evidence:
    // if it mentions rate limit it must hedge with posible/puede.
    if (/rate limit/i.test(reason)) {
      expect(reason).toMatch(/posible|puede/i);
    }
    expect(fs.existsSync(bin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3) Asset max bound: 64MiB ceiling before download
// RED: size 64MiB+1 currently passes metadata validation and downloads.
// CONTROL: normal positive size still installs.
// ---------------------------------------------------------------------------

describe("[pr04-3] asset 64MiB ceiling", () => {
  it("RED: approved size 64MiB+1 rejects before asset download", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const huge = liveAsset({ size: CEILING + 1 });
    const network = fetchFor({ release: { tag_name: LIVE_TAG, assets: [huge] } });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    expect(reasonOf(result)).toMatch(/64|ceiling|límite|tamaño|size|excede/i);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("CONTROL: normal positive size still installs", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fetchFor({ release: { tag_name: LIVE_TAG, assets: [liveAsset()] } });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result).toEqual({ ok: true, bin });
    expect(network.calls).toEqual([LATEST_URL, liveAsset().browser_download_url]);
    expect(fs.readFileSync(bin)).toEqual(linuxBinary);
  });
});

// ---------------------------------------------------------------------------
// 4) URL same-host wrong-tag + prerelease/build tags reject before download
// CONTROL (currently correct): locked to prevent regression. Would FAIL if
// tag/URL validation were removed.
// ---------------------------------------------------------------------------

describe("[pr04-4-CONTROL] URL and tag shape guards", () => {
  it("same-host wrong-tag URL rejects before download", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const name = expectedName(LIVE_VERSION);
    const wrongTagUrl = assetUrl("v9.9.8", name);
    expect(wrongTagUrl).toContain("github.com");
    const network = fetchFor({
      release: { tag_name: LIVE_TAG, assets: [liveAsset({ browser_download_url: wrongTagUrl })] },
    });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    expect(network.calls).toEqual([LATEST_URL]);
    expect(reasonOf(result)).toMatch(/URL|no oficial/i);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it.each(["v9.9.9-rc.1", "v9.9.9-beta.2", "v9.9.9+build.1"])(
    "prerelease/build tag %p rejects before download",
    async (tag) => {
      const homeDir = temporaryHome();
      const bin = path.join(homeDir, ".local", "bin", "engram");
      const network = fetchFor({ release: { tag_name: tag, assets: [liveAsset()] } });
      const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
      expect(result.ok).toBe(false);
      expect(network.calls).toEqual([LATEST_URL]);
      expect(reasonOf(result)).toMatch(/tag del release inválido/i);
      expect(fs.existsSync(bin)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 5) Stream cancel failure preserves original oversize/read error
// RED: finally { await reader.cancel() } replaces the original throw when
// cancel itself rejects.
// ---------------------------------------------------------------------------

describe("[pr04-5-RED] stream cancel preserves original error", () => {
  function failingReaderBody(opts: { readError: Error; cancelError: Error }): unknown {
    return {
      getReader: () => ({
        read: async () => {
          throw opts.readError;
        },
        cancel: async () => {
          throw opts.cancelError;
        },
      }),
    };
  }

  it("read failure + cancel failure => reason contains both, not only cancel", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fetchFor({
      release: { tag_name: LIVE_TAG, assets: [liveAsset()] },
      customBody: failingReaderBody({
        readError: new Error("boom-read"),
        cancelError: new Error("boom-cancel"),
      }),
    });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toContain("boom-read");
    expect(reason).toContain("boom-cancel");
    expect(fs.existsSync(bin)).toBe(false);
  });

  it("oversize read path + cancel failure => oversize cause preserved", async () => {
    const homeDir = temporaryHome();
    // Oversize via approvedSize small + stream larger is covered elsewhere;
    // here the reader itself throws an oversize-like error to isolate the
    // finally-masking contract deterministically.
    const network = fetchFor({
      release: { tag_name: LIVE_TAG, assets: [liveAsset()] },
      customBody: failingReaderBody({
        readError: new Error("El tamaño descargado de Engram supera el aprobado."),
        cancelError: new Error("boom-cancel"),
      }),
    });
    const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toMatch(/supera el aprobado/i);
    expect(reason).toContain("boom-cancel");
  });
});

// ---------------------------------------------------------------------------
// 6) Staging cleanup failures
// RED-A: success + cleanup failure currently becomes ok:false (reports binary
// absent) instead of proposed {ok:true,bin,warning} with bin present.
// RED-B: primary error after staging + cleanup failure currently reports only
// the cleanup cause, losing the primary.
// ---------------------------------------------------------------------------

describe("[pr04-6-RED] staging cleanup failures", () => {
  it("RED-A: publish succeeds but staging cleanup fails => ok:true with warning, bin present", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const network = fetchFor({ release: { tag_name: LIVE_TAG, assets: [liveAsset()] } });
    const realRm = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation(((target: unknown, opts: unknown) => {
      if (String(target).includes(".engram-install-")) {
        throw new Error("cleanup-boom");
      }
      return (realRm as (t: string, o?: unknown) => void)(String(target), opts as never);
    }) as typeof fs.rmSync);
    try {
      const result = await installMissingEngram({ homeDir, platform: "linux", arch: "x64", fetch: network.fetch });
      // Proposed contract (pending owner): observable without reporting absent.
      expect(result).toEqual({ ok: true, bin, warning: expect.stringContaining("cleanup-boom") });
      // Actionable staging context: warning names the installed binary and the
      // failed temporal staging cleanup (not just the cause).
      const warning = (result as { warning?: string }).warning ?? "";
      expect(warning).toContain(bin);
      expect(warning).toMatch(/temporal|Limpieza|staging|\.engram-install-/i);
      expect(fs.existsSync(bin)).toBe(true);
      expect(fs.readFileSync(bin)).toEqual(linuxBinary);
    } finally {
      spy.mockRestore();
    }
  });

  it("RED-B: primary error after staging + cleanup failure preserves both causes", async () => {
    const homeDir = temporaryHome();
    const bin = path.join(homeDir, ".local", "bin", "engram");
    const asset = liveAsset();
    // Race: destination appears during download, so linkSync fails with
    // EEXIST after staging exists; cleanup then also fails.
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === LATEST_URL) {
        return releaseJson({ tag_name: LIVE_TAG, assets: [asset] });
      }
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, Buffer.from("another installer won the race"), { mode: 0o755 });
      return new Response(new Uint8Array(archiveBytes), { status: 200 });
    });
    const realRm = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation(((target: unknown, opts: unknown) => {
      if (String(target).includes(".engram-install-")) {
        throw new Error("cleanup-boom");
      }
      return (realRm as (t: string, o?: unknown) => void)(String(target), opts as never);
    }) as typeof fs.rmSync);
    try {
      const result = await installMissingEngram({
        homeDir,
        platform: "linux",
        arch: "x64",
        fetch: fetch as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(false);
      const reason = reasonOf(result);
      expect(reason).toMatch(/exist|EEXIST/i);
      expect(reason).toContain("cleanup-boom");
      expect(calls).toEqual([LATEST_URL, asset.browser_download_url]);
      // Winner binary preserved.
      expect(fs.readFileSync(bin).toString()).toContain("another installer won the race");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 7) Pi installShared carries structured reason (behavioral, not source-text)
// RED: boolean discards installer detail; structured {ok:false,reason}
// is currently treated as truthy success.
// CONTROL: accepted install still re-detects.
// ---------------------------------------------------------------------------

describe("[pr04-7-RED] Pi installShared structured reason", () => {
  function requirementDeps(overrides: {
    hostSequence: Array<string | null>;
    accepted?: boolean;
    installShared: () => Promise<EngramInstallResult>;
  }): {
    detectHost(): string | null;
    detectTarget(targetDir: string): string | null;
    confirm(input: { message: string; initialValue: false }): Promise<boolean>;
    installShared(): Promise<EngramInstallResult>;
    events: string[];
  } {
    const events: string[] = [];
    let reads = 0;
    return {
      events,
      detectHost() {
        events.push("detect-host");
        const value = overrides.hostSequence[Math.min(reads, overrides.hostSequence.length - 1)];
        reads++;
        return value ?? null;
      },
      detectTarget(targetDir: string) {
        events.push(`detect-target:${targetDir}`);
        return null;
      },
      async confirm() {
        events.push("confirm:false");
        return overrides.accepted ?? false;
      },
      async installShared(...args: unknown[]) {
        events.push("install-shared");
        expect(args).toEqual([]);
        return await overrides.installShared();
      },
    };
  }

  it("RED: structured installer failure reason reaches blocked remedy", async () => {
    const detail = "simulated installer boom: ECONNRESET";
    const deps = requirementDeps({
      hostSequence: [null, null],
      accepted: true,
      installShared: async () => ({ ok: false, reason: detail }),
    });
    const result = await resolvePiEngramRequirement(
      { interactive: true, yes: false },
      deps,
    );
    expect(result).toMatchObject({ kind: "blocked" });
    const blocked = result as { kind: string; reason: string; remedy: string };
    expect(`${blocked.reason} ${blocked.remedy}`).toContain(detail);
    expect(deps.events).toContain("install-shared");
  });

  it("CONTROL: accepted shared install still re-detects the binary", async () => {
    const deps = requirementDeps({
      hostSequence: [null, "/opt/engram/bin/engram"],
      accepted: true,
      installShared: async () => ({ ok: true, bin: "/opt/engram/bin/engram" }),
    });
    const result = await resolvePiEngramRequirement(
      { interactive: true, yes: false },
      deps,
    );
    expect(result).toEqual({
      kind: "existing",
      bin: "/opt/engram/bin/engram",
      scope: "host",
    });
    expect(deps.events).toEqual(["detect-host", "confirm:false", "install-shared", "detect-host"]);
  });
});
