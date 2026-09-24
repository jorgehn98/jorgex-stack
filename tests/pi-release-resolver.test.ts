import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T06 RED tracer: live Pi latest resolver, not the static pin.
 *
 * Intended code-facing contract (no production change here):
 * - `resolveLatestPiRelease(fetchImpl: typeof fetch)` exported from
 *   `src/lib/pi-release-resolver.ts`.
 * - Single metadata read `GET https://registry.npmjs.org/jorgex-pi` with
 *   `Accept: application/vnd.npm.install-v1+json`, `redirect: "error"`,
 *   and canonical final response URL.
 * - Selects `dist-tags.latest` (exact stable) from the `versions` map and
 *   returns only the observed `{ version, tarballUrl, integrity }` with the
 *   official canonical tarball URL and `sha512-` integrity. No fallback to
 *   `PI_RUNTIME_CANDIDATE`.
 * - Synthetic `9.9.x` values below are test-only packuments, not
 *   published-version claims. Tarball staging / npm-tree activation is
 *   explicitly out of scope for this tracer.
 * - Acquisition tracer `downloadVerifiedPiTarball(release, destination,
 *   fetchImpl)`: exact-release bytes verified (URL/redirect, bounded
 *   stream, SHA-512) before private publish; no staging (T07 owns it).
 * - Provenance tracer `resolvePiProducerCommit(version, fetchImpl)`:
 *   INFORMATIONAL producer tag commit from the official GitHub ref API
 *   (lightweight tag → commit sha); never an npm attestation, never a
 *   static fallback.
 */

type PiReleaseCandidate = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type PiReleaseResolverModule = {
  resolveLatestPiRelease(fetchImpl: typeof fetch): Promise<PiReleaseCandidate>;
};

const resolverSpecifier = new URL("../src/lib/pi-release-resolver.js", import.meta.url).href;

async function loadResolver(): Promise<PiReleaseResolverModule> {
  const mod = (await import(/* @vite-ignore */ resolverSpecifier)) as Partial<PiReleaseResolverModule>;
  expect(
    mod.resolveLatestPiRelease,
    "resolveLatestPiRelease must be exported from src/lib/pi-release-resolver.ts",
  ).toBeTypeOf("function");
  return mod as PiReleaseResolverModule;
}

function syntheticPackument(latest: string, integrity: string): unknown {
  const tarball = `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${latest}.tgz`;
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

function packumentFetch(
  pack: unknown,
  seen: Array<{ url: string; accept: string; redirect?: string }>,
  opts?: { status?: number; urlOverride?: string; contentLength?: string },
): typeof fetch {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let accept = "";
    const headers = init?.headers;
    if (headers instanceof Headers) {
      accept = headers.get("accept") ?? headers.get("Accept") ?? "";
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        if (String(key).toLowerCase() === "accept") accept = String(value);
      }
    } else if (headers !== undefined && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === "accept") accept = String(value);
      }
    }
    seen.push({ url, accept, redirect: init?.redirect });
    const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (opts?.contentLength !== undefined) responseHeaders["Content-Length"] = opts.contentLength;
    const response = new Response(JSON.stringify(pack), {
      status: opts?.status ?? 200,
      headers: responseHeaders,
    });
    Object.defineProperty(response, "url", { value: opts?.urlOverride ?? url });
    return response;
  });
  return fetch as unknown as typeof fetch;
}

describe("[T06-RED] pi latest release resolver follows dist-tags.latest", () => {
  it("resolves two distinct synthetic latest packuments to two distinct exact candidates", async () => {
    const { resolveLatestPiRelease } = await loadResolver();

    // Synthetic-only versions; they prove live selection because neither
    // equals the frozen static pin and they differ from each other.
    const firstVersion = "9.9.10";
    const secondVersion = "9.9.11";
    // Test-only SRI metadata (canonical base64 for exactly 64 bytes),
    // not real release hashes.
    const firstIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
    const secondIntegrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
    const firstTarball = `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${firstVersion}.tgz`;
    const secondTarball = `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${secondVersion}.tgz`;

    const firstSeen: Array<{ url: string; accept: string; redirect?: string }> = [];
    const secondSeen: Array<{ url: string; accept: string; redirect?: string }> = [];
    const firstFetch = packumentFetch(syntheticPackument(firstVersion, firstIntegrity), firstSeen);
    const secondFetch = packumentFetch(syntheticPackument(secondVersion, secondIntegrity), secondSeen);

    const first = await resolveLatestPiRelease(firstFetch);
    const second = await resolveLatestPiRelease(secondFetch);

    expect(first).toEqual({ version: firstVersion, tarballUrl: firstTarball, integrity: firstIntegrity });
    expect(second).toEqual({ version: secondVersion, tarballUrl: secondTarball, integrity: secondIntegrity });
    expect(first).not.toEqual(second);

    expect(firstSeen).toHaveLength(1);
    expect(firstSeen[0]?.url).toBe("https://registry.npmjs.org/jorgex-pi");
    expect(firstSeen[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(firstSeen[0]?.redirect).toBe("error");

    expect(secondSeen).toHaveLength(1);
    expect(secondSeen[0]?.url).toBe("https://registry.npmjs.org/jorgex-pi");
    expect(secondSeen[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(secondSeen[0]?.redirect).toBe("error");

    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an unbounded metadata stream at 4 MiB without draining it", async () => {
    const { resolveLatestPiRelease } = await loadResolver();
    const MAX_METADATA_BYTES = 4 * 1024 * 1024;
    const CHUNK_SIZE = 64 * 1024;
    const TOTAL_BYTES = MAX_METADATA_BYTES + 256 * 1024;
    const chunk = new Uint8Array(CHUNK_SIZE).fill(0x61);
    let suppliedBytes = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (suppliedBytes >= TOTAL_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.slice());
        suppliedBytes += CHUNK_SIZE;
      },
      cancel() {
        cancelled = true;
      },
    });

    const oversizeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const response = new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: url });
      void init;
      return response;
    }) as unknown as typeof fetch;

    await expect(resolveLatestPiRelease(oversizeFetch)).rejects.toThrow(/exceeds 4 MiB/i);
    expect(suppliedBytes).toBeLessThan(TOTAL_BYTES);
    expect(suppliedBytes).toBeLessThanOrEqual(MAX_METADATA_BYTES + CHUNK_SIZE);
    expect(cancelled).toBe(true);
  });

  it.each([
    {
      label: "pre-release latest",
      pack: syntheticPackument(
        "9.9.12-beta.1",
        `sha512-${Buffer.alloc(64, 3).toString("base64")}`,
      ),
    },
    {
      label: "missing versions entry",
      pack: {
        name: "jorgex-pi",
        "dist-tags": { latest: "9.9.10" },
        versions: {},
      },
    },
    {
      label: "deprecated release",
      pack: (() => {
        const pack = JSON.parse(
          JSON.stringify(
            syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
          ),
        ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
        (pack["versions"]?.["9.9.10"] as Record<string, unknown>)["deprecated"] = "do not use in test";
        return pack;
      })(),
    },
    {
      label: "entry name mismatch",
      pack: (() => {
        const pack = JSON.parse(
          JSON.stringify(
            syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
          ),
        ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
        (pack["versions"]?.["9.9.10"] as Record<string, unknown>)["name"] = "other-pi";
        return pack;
      })(),
    },
    {
      label: "entry version mismatch",
      pack: (() => {
        const pack = JSON.parse(
          JSON.stringify(
            syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
          ),
        ) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
        (pack["versions"]?.["9.9.10"] as Record<string, unknown>)["version"] = "9.9.11";
        return pack;
      })(),
    },
    {
      label: "foreign tarball host",
      pack: (() => {
        const pack = JSON.parse(
          JSON.stringify(
            syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
          ),
        ) as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>;
        (pack["versions"]?.["9.9.10"]?.["dist"] as Record<string, unknown>)["tarball"] =
          "https://evil.example/jorgex-pi-9.9.10.tgz";
        return pack;
      })(),
    },
    {
      label: "registry lookalike host",
      pack: (() => {
        const pack = JSON.parse(
          JSON.stringify(
            syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
          ),
        ) as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>;
        (pack["versions"]?.["9.9.10"]?.["dist"] as Record<string, unknown>)["tarball"] =
          "https://registry.npmjs.org.evil.example/jorgex-pi/-/jorgex-pi-9.9.10.tgz";
        return pack;
      })(),
    },
    {
      label: "malformed SRI",
      pack: (() => {
        const pack = JSON.parse(
          JSON.stringify(
            syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
          ),
        ) as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>;
        (pack["versions"]?.["9.9.10"]?.["dist"] as Record<string, unknown>)["integrity"] =
          "sha512-!!not-base64!!";
        return pack;
      })(),
    },
    {
      label: "non-canonical SRI",
      pack: syntheticPackument("9.9.10", `sha512-${"b".repeat(86)}==`),
    },
    {
      label: "response url mismatch",
      pack: syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
      urlOverride: "https://registry.npmjs.org/jorgex-pi-moved",
    },
    {
      label: "non-2xx registry status",
      pack: syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
      status: 503,
    },
    {
      label: "invalid content-length",
      pack: syntheticPackument("9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
      contentLength: "bogus",
    },
  ])("$label rejects without silent fallback", async ({ pack, status, urlOverride, contentLength }) => {
    const { resolveLatestPiRelease } = await loadResolver();
    const seen: Array<{ url: string; accept: string; redirect?: string }> = [];
    const fetch = packumentFetch(pack, seen, { status, urlOverride, contentLength });

    await expect(resolveLatestPiRelease(fetch)).rejects.toThrow(/pi-release-resolver:/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen[0]?.redirect).toBe("error");
  });
});

type PiTarballDownload = {
  downloadVerifiedPiTarball(
    release: PiReleaseCandidate,
    destination: string,
    fetchImpl: typeof fetch,
  ): Promise<{ path: string; bytes: number; sha256: string; sha512: string }>;
};

async function loadDownload(): Promise<PiTarballDownload> {
  const mod = (await import(/* @vite-ignore */ resolverSpecifier)) as Partial<PiTarballDownload>;
  expect(
    mod.downloadVerifiedPiTarball,
    "downloadVerifiedPiTarball must be exported from src/lib/pi-release-resolver.ts",
  ).toBeTypeOf("function");
  return mod as PiTarballDownload;
}

const downloadSandboxes: string[] = [];

function downloadSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-download-"));
  downloadSandboxes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of downloadSandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function syntheticTarballBytes(): Buffer {
  return Buffer.from("synthetic-jorgex-pi-tarball-9.9.10\n".repeat(128));
}

function syntheticRelease(bytes: Buffer, version = "9.9.10"): PiReleaseCandidate {
  const tarballUrl = `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
  return {
    version,
    tarballUrl,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function serveTarball(
  payload: { bytes?: Uint8Array; streamTotal?: number },
  tarballUrl: string,
  seen: Array<{ url: string; redirect?: string }>,
  opts?: {
    urlOverride?: string;
    status?: number;
    contentLength?: string;
    chunkSize?: number;
    stats?: { suppliedBytes: number; cancelled: boolean };
  },
): typeof fetch {
  const chunkSize = opts?.chunkSize ?? 1024;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (opts?.contentLength !== undefined) headers["Content-Length"] = opts.contentLength;
    let body: ReadableStream<Uint8Array>;
    if (payload.streamTotal !== undefined) {
      const total = payload.streamTotal;
      const chunk = new Uint8Array(chunkSize).fill(0x61);
      let supplied = 0;
      body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (supplied >= total) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.slice());
          supplied += chunkSize;
          if (opts?.stats !== undefined) opts.stats.suppliedBytes = supplied;
        },
        cancel() {
          if (opts?.stats !== undefined) opts.stats.cancelled = true;
        },
      });
    } else {
      const bytes = payload.bytes ?? new Uint8Array();
      let offset = 0;
      body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
          offset += chunkSize;
        },
      });
    }
    const response = new Response(body, { status: opts?.status ?? 200, headers });
    Object.defineProperty(response, "url", { value: opts?.urlOverride ?? url });
    return response;
  });
  return fetch as unknown as typeof fetch;
}

describe("[T06-RED] pi tarball acquisition verifies before publishing", () => {
  it("persists verified bytes with observed size and digests", async () => {
    const { downloadVerifiedPiTarball } = await loadDownload();
    const bytes = syntheticTarballBytes();
    const release = syntheticRelease(bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `jorgex-pi-${release.version}.tgz`);
    expect(fs.existsSync(destination)).toBe(false);
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fetch = serveTarball({ bytes }, release.tarballUrl, seen, {
      contentLength: String(bytes.byteLength),
    });

    const result = await downloadVerifiedPiTarball(release, destination, fetch);

    expect(result).toEqual({
      path: destination,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    });
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen[0]?.url).toBe(release.tarballUrl);
    expect(seen[0]?.redirect).toBe("error");
  });

  it("rejects an SRI mismatch without touching preexisting destination bytes", async () => {
    const { downloadVerifiedPiTarball } = await loadDownload();
    const bytes = syntheticTarballBytes();
    const release = syntheticRelease(bytes);
    const wrongIntegrity = `sha512-${createHash("sha512").update("unrelated-test-bytes").digest("base64")}`;
    const dir = downloadSandbox();
    const destination = path.join(dir, `jorgex-pi-${release.version}.tgz`);
    fs.writeFileSync(destination, "unrelated\n");
    const fetch = serveTarball({ bytes }, release.tarballUrl, [], {
      contentLength: String(bytes.byteLength),
    });

    await expect(
      downloadVerifiedPiTarball({ ...release, integrity: wrongIntegrity }, destination, fetch),
    ).rejects.toThrow(/pi-release-resolver:/);
    expect(fs.readFileSync(destination, "utf8")).toBe("unrelated\n");
  });

  it("caps an unbounded tarball stream early and leaves no file or temp", async () => {
    const { downloadVerifiedPiTarball } = await loadDownload();
    const release: PiReleaseCandidate = {
      version: "9.9.10",
      tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.10.tgz",
      integrity: `sha512-${Buffer.alloc(64, 4).toString("base64")}`,
    };
    const dir = downloadSandbox();
    const destination = path.join(dir, `jorgex-pi-${release.version}.tgz`);
    const stats = { suppliedBytes: 0, cancelled: false };
    // Policy bound under test: 128 MiB. The 129 MiB stream forces it with a
    // single reusable 1 MiB chunk; early cancellation must fire before the
    // stream is fully drained.
    const TOTAL_BYTES = 129 * 1024 * 1024;
    const fetch = serveTarball({ streamTotal: TOTAL_BYTES }, release.tarballUrl, [], {
      chunkSize: 1024 * 1024,
      stats,
    });

    await expect(downloadVerifiedPiTarball(release, destination, fetch)).rejects.toThrow(
      /pi-release-resolver:/,
    );
    expect(stats.suppliedBytes).toBeLessThan(TOTAL_BYTES);
    expect(stats.suppliedBytes).toBeLessThanOrEqual(128 * 1024 * 1024 + 1024 * 1024);
    expect(stats.cancelled).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("lets a historical-size body reach integrity check instead of the size bound", async () => {
    const { downloadVerifiedPiTarball } = await loadDownload();
    // Historical test-boundary number, not a version selection: the verified
    // jorgex-pi@0.8.24 tarball is 89,140,631 bytes, and T07/SC05 rollback
    // recovery must be able to acquire it. The streamed 90 MiB strictly
    // covers that size; with a deliberately wrong SRI the download must fail
    // at integrity mismatch, proving the size gate did not refuse it.
    const release: PiReleaseCandidate = {
      version: "9.9.10",
      tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.10.tgz",
      integrity: `sha512-${createHash("sha512").update("unrelated-test-bytes").digest("base64")}`,
    };
    const dir = downloadSandbox();
    const destination = path.join(dir, `jorgex-pi-${release.version}.tgz`);
    const TOTAL_BYTES = 90 * 1024 * 1024;
    const fetch = serveTarball({ streamTotal: TOTAL_BYTES }, release.tarballUrl, [], {
      chunkSize: 1024 * 1024,
    });

    const failure = await downloadVerifiedPiTarball(release, destination, fetch).then(
      () => {
        throw new Error("expected downloadVerifiedPiTarball to reject");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/integrity mismatch/i);
    expect((failure as Error).message).not.toMatch(/exceed/i);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("rejects a redirected response url without publishing", async () => {
    const { downloadVerifiedPiTarball } = await loadDownload();
    const bytes = syntheticTarballBytes();
    const release = syntheticRelease(bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `jorgex-pi-${release.version}.tgz`);
    const fetch = serveTarball({ bytes }, release.tarballUrl, [], {
      urlOverride: `${release.tarballUrl}?redirected=1`,
    });

    await expect(downloadVerifiedPiTarball(release, destination, fetch)).rejects.toThrow(
      /pi-release-resolver:/,
    );
    expect(fs.existsSync(destination)).toBe(false);
  });
});

const producerTagUrl = (version: string): string =>
  `https://api.github.com/repos/jorgehn98/jorgex-pi/git/ref/tags/v${version}`;

type PiProducerProvenance = {
  resolvePiProducerCommit(version: string, fetchImpl: typeof fetch): Promise<string>;
};

async function loadProvenance(): Promise<PiProducerProvenance> {
  const mod = (await import(/* @vite-ignore */ resolverSpecifier)) as Partial<PiProducerProvenance>;
  expect(
    mod.resolvePiProducerCommit,
    "resolvePiProducerCommit must be exported from src/lib/pi-release-resolver.ts",
  ).toBeTypeOf("function");
  return mod as PiProducerProvenance;
}

function tagRefFetch(
  payload: unknown,
  seen: Array<{ url: string; redirect?: string }>,
  opts?: { status?: number; urlOverride?: string },
): typeof fetch {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    const response = new Response(JSON.stringify(payload), {
      status: opts?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: opts?.urlOverride ?? url });
    return response;
  });
  return fetch as unknown as typeof fetch;
}

describe("[T06-RED] pi producer provenance resolves the informational tag commit", () => {
  // Synthetic test-only tag sha (40 lowercase hex), not a real commit claim.
  const SYNTHETIC_SHA = "0123456789abcdef0123456789abcdef01234567";

  it("resolves the exact lightweight tag ref to its commit sha", async () => {
    const { resolvePiProducerCommit } = await loadProvenance();
    const version = "9.9.10";
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fetch = tagRefFetch(
      { ref: `refs/tags/v${version}`, object: { type: "commit", sha: SYNTHETIC_SHA } },
      seen,
    );

    await expect(resolvePiProducerCommit(version, fetch)).resolves.toBe(SYNTHETIC_SHA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen[0]?.url).toBe(producerTagUrl(version));
    expect(seen[0]?.redirect).toBe("error");
  });

  it("rejects a non-stable input version without any fetch", async () => {
    const { resolvePiProducerCommit } = await loadProvenance();
    let called = false;
    const fetch: typeof globalThis.fetch = (async (): Promise<Response> => {
      called = true;
      throw new Error("fetch must not be called");
    }) as unknown as typeof globalThis.fetch;

    await expect(resolvePiProducerCommit("9.9.10-beta.1", fetch)).rejects.toThrow(
      /pi-release-resolver:/,
    );
    expect(called).toBe(false);
  });

  it.each(
    [
      {
        label: "wrong ref",
        payload: {
          ref: "refs/tags/v9.9.11",
          object: { type: "commit", sha: "0123456789abcdef0123456789abcdef01234567" },
        },
      },
      {
        label: "annotated tag object",
        payload: {
          ref: "refs/tags/v9.9.10",
          object: { type: "tag", sha: "0123456789abcdef0123456789abcdef01234567" },
        },
      },
      {
        label: "non-2xx registry status",
        payload: {
          ref: "refs/tags/v9.9.10",
          object: { type: "commit", sha: "0123456789abcdef0123456789abcdef01234567" },
        },
        status: 404,
      },
      {
        label: "foreign response url",
        payload: {
          ref: "refs/tags/v9.9.10",
          object: { type: "commit", sha: "0123456789abcdef0123456789abcdef01234567" },
        },
        urlOverride:
          "https://api.github.com.evil.example/repos/jorgehn98/jorgex-pi/git/ref/tags/v9.9.10",
      },
      {
        label: "invalid sha",
        payload: {
          ref: "refs/tags/v9.9.10",
          object: { type: "commit", sha: "ZZZ-not-a-hex-sha" },
        },
      },
    ] as Array<{ label: string; payload: unknown; status?: number; urlOverride?: string }>,
  )("$label fails closed without a fabricated commit", async ({ payload, status, urlOverride }) => {
    const { resolvePiProducerCommit } = await loadProvenance();
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fetch = tagRefFetch(payload, seen, { status, urlOverride });

    await expect(resolvePiProducerCommit("9.9.10", fetch)).rejects.toThrow(/pi-release-resolver:/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen[0]?.redirect).toBe("error");
  });
});
