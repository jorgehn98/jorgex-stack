import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T14 RED: minimal generic npm provider resolver for browser opt-ins.
 *
 * Intended code-facing contract (no production change here):
 * - `resolveLatestNpmPackageRelease(packageName, fetchImpl)` exported from
 *   `src/lib/npm-provider.ts` (no new dependency).
 * - Single metadata read `GET https://registry.npmjs.org/<packageName>` with
 *   `Accept: application/vnd.npm.install-v1+json`, `redirect: "error"` and
 *   canonical final response URL.
 * - Selects `dist-tags.latest` (exact stable `X.Y.Z`) from the `versions` map
 *   and returns only the observed `{ version, tarballUrl, integrity }` with
 *   the official canonical tarball URL and canonical `sha512-` SRI.
 *   Canonical shapes under test (producer evidence via `pnpm view`, not a
 *   fixed selector in code):
 *   - `@playwright/cli` -> `https://registry.npmjs.org/@playwright/cli/-/cli-<version>.tgz`
 *   - `chrome-devtools-mcp` -> `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-<version>.tgz`
 * - Synthetic `9.9.x` versions below are test-only packuments, not
 *   published-version claims. They prove live selection because none equals
 *   the frozen source constants (`0.1.18` / `1.6.0`) and each pair differs.
 * - Rejects deprecated / prerelease / latest missing / version mismatch /
 *   foreign URL / redirect / SRI missing or noncanonical, plus bounded
 *   metadata (4 MiB). No network, no HOME, no snapshot/prose assertions.
 */

type NpmPackageRelease = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type NpmProviderModule = {
  resolveLatestNpmPackageRelease(
    packageName: string,
    fetchImpl: typeof fetch,
  ): Promise<NpmPackageRelease>;
};

const resolverSpecifier = new URL("../src/lib/npm-provider.js", import.meta.url).href;

async function loadResolver(): Promise<NpmProviderModule> {
  const mod = (await import(/* @vite-ignore */ resolverSpecifier)) as Partial<NpmProviderModule>;
  expect(
    mod.resolveLatestNpmPackageRelease,
    "resolveLatestNpmPackageRelease must be exported from src/lib/npm-provider.ts",
  ).toBeTypeOf("function");
  return mod as NpmProviderModule;
}

const PLAYWRIGHT_PKG = "@playwright/cli";
const DEVTOOLS_PKG = "chrome-devtools-mcp";

function canonicalTarballFor(packageName: string, version: string): string {
  if (packageName === PLAYWRIGHT_PKG) {
    return `https://registry.npmjs.org/@playwright/cli/-/cli-${version}.tgz`;
  }
  return `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`;
}

function syntheticPackument(packageName: string, latest: string, integrity: string): unknown {
  return {
    name: packageName,
    "dist-tags": { latest },
    versions: {
      [latest]: {
        name: packageName,
        version: latest,
        dist: { tarball: canonicalTarballFor(packageName, latest), integrity },
      },
    },
  };
}

type SeenRequest = { url: string; accept: string; redirect?: string };

function packumentFetch(
  pack: unknown,
  seen: SeenRequest[],
  opts?: { status?: number; urlOverride?: string; contentLength?: string },
): typeof fetch {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let accept = "";
    const headers = init?.headers;
    if (headers instanceof Headers) {
      accept = headers.get("accept") ?? "";
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

function mutatePackument(pack: unknown, mutate: (draft: Record<string, never>) => void): unknown {
  const clone = JSON.parse(JSON.stringify(pack)) as Record<string, never>;
  mutate(clone);
  return clone;
}

describe("[T14-RED] browser provider resolves distinct stable latest to exact candidates", () => {
  it("resolves two distinct @playwright/cli latest packuments to distinct exact version/URL/SRI", async () => {
    const { resolveLatestNpmPackageRelease } = await loadResolver();
    const firstVersion = "9.9.10";
    const secondVersion = "9.9.11";
    const firstIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
    const secondIntegrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
    const firstTarball = `https://registry.npmjs.org/@playwright/cli/-/cli-${firstVersion}.tgz`;
    const secondTarball = `https://registry.npmjs.org/@playwright/cli/-/cli-${secondVersion}.tgz`;

    const firstSeen: SeenRequest[] = [];
    const secondSeen: SeenRequest[] = [];
    const firstFetch = packumentFetch(syntheticPackument(PLAYWRIGHT_PKG, firstVersion, firstIntegrity), firstSeen);
    const secondFetch = packumentFetch(
      syntheticPackument(PLAYWRIGHT_PKG, secondVersion, secondIntegrity),
      secondSeen,
    );

    const first = await resolveLatestNpmPackageRelease(PLAYWRIGHT_PKG, firstFetch);
    const second = await resolveLatestNpmPackageRelease(PLAYWRIGHT_PKG, secondFetch);

    expect(first).toEqual({ version: firstVersion, tarballUrl: firstTarball, integrity: firstIntegrity });
    expect(second).toEqual({ version: secondVersion, tarballUrl: secondTarball, integrity: secondIntegrity });
    expect(first).not.toEqual(second);

    expect(firstSeen).toHaveLength(1);
    expect(firstSeen[0]?.url).toBe("https://registry.npmjs.org/@playwright/cli");
    expect(firstSeen[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(firstSeen[0]?.redirect).toBe("error");

    expect(secondSeen).toHaveLength(1);
    expect(secondSeen[0]?.url).toBe("https://registry.npmjs.org/@playwright/cli");
    expect(secondSeen[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(secondSeen[0]?.redirect).toBe("error");

    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves two distinct chrome-devtools-mcp latest packuments to distinct exact version/URL/SRI", async () => {
    const { resolveLatestNpmPackageRelease } = await loadResolver();
    const firstVersion = "9.9.20";
    const secondVersion = "9.9.21";
    const firstIntegrity = `sha512-${Buffer.alloc(64, 5).toString("base64")}`;
    const secondIntegrity = `sha512-${Buffer.alloc(64, 6).toString("base64")}`;
    const firstTarball = `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${firstVersion}.tgz`;
    const secondTarball = `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${secondVersion}.tgz`;

    const firstSeen: SeenRequest[] = [];
    const secondSeen: SeenRequest[] = [];
    const firstFetch = packumentFetch(syntheticPackument(DEVTOOLS_PKG, firstVersion, firstIntegrity), firstSeen);
    const secondFetch = packumentFetch(
      syntheticPackument(DEVTOOLS_PKG, secondVersion, secondIntegrity),
      secondSeen,
    );

    const first = await resolveLatestNpmPackageRelease(DEVTOOLS_PKG, firstFetch);
    const second = await resolveLatestNpmPackageRelease(DEVTOOLS_PKG, secondFetch);

    expect(first).toEqual({ version: firstVersion, tarballUrl: firstTarball, integrity: firstIntegrity });
    expect(second).toEqual({ version: secondVersion, tarballUrl: secondTarball, integrity: secondIntegrity });
    expect(first).not.toEqual(second);

    expect(firstSeen).toHaveLength(1);
    expect(firstSeen[0]?.url).toBe("https://registry.npmjs.org/chrome-devtools-mcp");
    expect(firstSeen[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(firstSeen[0]?.redirect).toBe("error");

    expect(secondSeen).toHaveLength(1);
    expect(secondSeen[0]?.url).toBe("https://registry.npmjs.org/chrome-devtools-mcp");
    expect(secondSeen[0]?.accept).toContain("application/vnd.npm.install-v1+json");
    expect(secondSeen[0]?.redirect).toBe("error");
  });

  it("rejects an unbounded metadata stream at 4 MiB without draining it", async () => {
    const { resolveLatestNpmPackageRelease } = await loadResolver();
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

    await expect(resolveLatestNpmPackageRelease(PLAYWRIGHT_PKG, oversizeFetch)).rejects.toThrow(
      /npm-provider:/,
    );
    expect(suppliedBytes).toBeLessThan(TOTAL_BYTES);
    expect(suppliedBytes).toBeLessThanOrEqual(MAX_METADATA_BYTES + CHUNK_SIZE);
    expect(cancelled).toBe(true);
  });

  it.each([
    {
      label: "prerelease latest",
      packageName: PLAYWRIGHT_PKG,
      pack: syntheticPackument(PLAYWRIGHT_PKG, "9.9.12-beta.1", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
    },
    {
      label: "latest missing",
      packageName: PLAYWRIGHT_PKG,
      pack: { name: PLAYWRIGHT_PKG, "dist-tags": {}, versions: {} },
    },
    {
      label: "missing versions entry",
      packageName: PLAYWRIGHT_PKG,
      pack: { name: PLAYWRIGHT_PKG, "dist-tags": { latest: "9.9.10" }, versions: {} },
    },
    {
      label: "deprecated release",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, unknown>>;
        (versions["9.9.10"] as Record<string, unknown>)["deprecated"] = "do not use in test";
      }),
    },
    {
      label: "deprecated devtools release",
      packageName: DEVTOOLS_PKG,
      pack: mutatePackument(syntheticPackument(DEVTOOLS_PKG, "9.9.20", `sha512-${Buffer.alloc(64, 7).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, unknown>>;
        (versions["9.9.20"] as Record<string, unknown>)["deprecated"] = "do not use in test";
      }),
    },
    {
      label: "entry name mismatch",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, unknown>>;
        (versions["9.9.10"] as Record<string, unknown>)["name"] = "other-package";
      }),
    },
    {
      label: "entry version mismatch",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, unknown>>;
        (versions["9.9.10"] as Record<string, unknown>)["version"] = "9.9.11";
      }),
    },
    {
      label: "foreign tarball host",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, Record<string, unknown>>>;
        (versions["9.9.10"]?.["dist"] as Record<string, unknown>)["tarball"] =
          "https://evil.example/cli-9.9.10.tgz";
      }),
    },
    {
      label: "registry lookalike host",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, Record<string, unknown>>>;
        (versions["9.9.10"]?.["dist"] as Record<string, unknown>)["tarball"] =
          "https://registry.npmjs.org.evil.example/@playwright/cli/-/cli-9.9.10.tgz";
      }),
    },
    {
      label: "foreign devtools tarball host",
      packageName: DEVTOOLS_PKG,
      pack: mutatePackument(syntheticPackument(DEVTOOLS_PKG, "9.9.20", `sha512-${Buffer.alloc(64, 7).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, Record<string, unknown>>>;
        (versions["9.9.20"]?.["dist"] as Record<string, unknown>)["tarball"] =
          "https://evil.example/chrome-devtools-mcp-9.9.20.tgz";
      }),
    },
    {
      label: "SRI missing",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, Record<string, unknown>>>;
        delete (versions["9.9.10"]?.["dist"] as Record<string, unknown>)["integrity"];
      }),
    },
    {
      label: "malformed SRI",
      packageName: PLAYWRIGHT_PKG,
      pack: mutatePackument(syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`), (draft) => {
        const versions = draft["versions"] as unknown as Record<string, Record<string, Record<string, unknown>>>;
        (versions["9.9.10"]?.["dist"] as Record<string, unknown>)["integrity"] = "sha512-!!not-base64!!";
      }),
    },
    {
      label: "non-canonical SRI",
      packageName: PLAYWRIGHT_PKG,
      pack: syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${"b".repeat(86)}==`),
    },
    {
      label: "response url mismatch",
      packageName: PLAYWRIGHT_PKG,
      pack: syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
      urlOverride: "https://registry.npmjs.org/@playwright/cli-moved",
    },
    {
      label: "non-2xx registry status",
      packageName: PLAYWRIGHT_PKG,
      pack: syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
      status: 503,
    },
    {
      label: "invalid content-length",
      packageName: PLAYWRIGHT_PKG,
      pack: syntheticPackument(PLAYWRIGHT_PKG, "9.9.10", `sha512-${Buffer.alloc(64, 3).toString("base64")}`),
      contentLength: "bogus",
    },
  ])("$label rejects without silent fallback", async ({ packageName, pack, status, urlOverride, contentLength }) => {
    const { resolveLatestNpmPackageRelease } = await loadResolver();
    const seen: SeenRequest[] = [];
    const fetch = packumentFetch(pack, seen, { status, urlOverride, contentLength });

    await expect(resolveLatestNpmPackageRelease(packageName, fetch)).rejects.toThrow(/npm-provider:/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen[0]?.redirect).toBe("error");
  });
});

type NpmTarballArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
};

type NpmTarballDownloadModule = {
  downloadVerifiedNpmPackageTarball(
    packageName: string,
    release: NpmPackageRelease,
    destination: string,
    fetchImpl: typeof fetch,
  ): Promise<NpmTarballArtifact>;
};

async function loadDownload(): Promise<NpmTarballDownloadModule> {
  const mod = (await import(/* @vite-ignore */ resolverSpecifier)) as Partial<NpmTarballDownloadModule>;
  expect(
    mod.downloadVerifiedNpmPackageTarball,
    "downloadVerifiedNpmPackageTarball must be exported from src/lib/npm-provider.ts",
  ).toBeTypeOf("function");
  return mod as NpmTarballDownloadModule;
}

const downloadSandboxes: string[] = [];

function downloadSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-npm-tarball-"));
  downloadSandboxes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of downloadSandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function syntheticTarballBytes(packageName: string, version: string): Buffer {
  return Buffer.from(`synthetic-${packageName}-tarball-${version}\n`.repeat(128));
}

function syntheticTarballRelease(packageName: string, version: string, bytes: Buffer): NpmPackageRelease {
  return {
    version,
    tarballUrl: canonicalTarballFor(packageName, version),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function serveTarballBytes(
  bytes: Uint8Array,
  tarballUrl: string,
  seen: Array<{ url: string; redirect?: string }>,
  opts?: { urlOverride?: string; status?: number; contentLength?: string },
): typeof fetch {
  const tarballFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (opts?.contentLength !== undefined) headers["Content-Length"] = opts.contentLength;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice());
        controller.close();
      },
    });
    const response = new Response(body, { status: opts?.status ?? 200, headers });
    Object.defineProperty(response, "url", { value: opts?.urlOverride ?? url });
    return response;
  });
  return tarballFetch as unknown as typeof fetch;
}

describe("[T14-RED] browser provider tarball acquisition verifies before publishing", () => {
  it("persists verified @playwright/cli bytes with observed size and digests", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(PLAYWRIGHT_PKG, version);
    const release = syntheticTarballRelease(PLAYWRIGHT_PKG, version, bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `cli-${version}.tgz`);
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fetch = serveTarballBytes(bytes, release.tarballUrl, seen, {
      contentLength: String(bytes.byteLength),
    });

    const result = await downloadVerifiedNpmPackageTarball(PLAYWRIGHT_PKG, release, destination, fetch);

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
    expect(fs.readdirSync(dir)).toEqual([path.basename(destination)]);
  });

  it("persists verified chrome-devtools-mcp bytes with observed size and digests", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.20";
    const bytes = syntheticTarballBytes(DEVTOOLS_PKG, version);
    const release = syntheticTarballRelease(DEVTOOLS_PKG, version, bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `chrome-devtools-mcp-${version}.tgz`);
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fetch = serveTarballBytes(bytes, release.tarballUrl, seen, {
      contentLength: String(bytes.byteLength),
    });

    const result = await downloadVerifiedNpmPackageTarball(DEVTOOLS_PKG, release, destination, fetch);

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
    expect(fs.readdirSync(dir)).toEqual([path.basename(destination)]);
  });

  it("rejects an SRI mismatch without publishing and leaves no file or temp", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(PLAYWRIGHT_PKG, version);
    const release = syntheticTarballRelease(PLAYWRIGHT_PKG, version, bytes);
    const wrongIntegrity = `sha512-${createHash("sha512").update("unrelated-test-bytes").digest("base64")}`;
    const dir = downloadSandbox();
    const destination = path.join(dir, `cli-${version}.tgz`);
    const fetch = serveTarballBytes(bytes, release.tarballUrl, [], {
      contentLength: String(bytes.byteLength),
    });

    await expect(
      downloadVerifiedNpmPackageTarball(
        PLAYWRIGHT_PKG,
        { ...release, integrity: wrongIntegrity },
        destination,
        fetch,
      ),
    ).rejects.toThrow(/npm-provider:/);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("rejects a redirected response url without publishing", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.20";
    const bytes = syntheticTarballBytes(DEVTOOLS_PKG, version);
    const release = syntheticTarballRelease(DEVTOOLS_PKG, version, bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `chrome-devtools-mcp-${version}.tgz`);
    const fetch = serveTarballBytes(bytes, release.tarballUrl, [], {
      urlOverride: `${release.tarballUrl}?redirected=1`,
    });

    await expect(
      downloadVerifiedNpmPackageTarball(DEVTOOLS_PKG, release, destination, fetch),
    ).rejects.toThrow(/npm-provider:/);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("leaves a preexisting divergent file untouched", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(PLAYWRIGHT_PKG, version);
    const release = syntheticTarballRelease(PLAYWRIGHT_PKG, version, bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `cli-${version}.tgz`);
    fs.writeFileSync(destination, "unrelated\n");
    const fetch = serveTarballBytes(bytes, release.tarballUrl, [], {
      contentLength: String(bytes.byteLength),
    });

    await expect(
      downloadVerifiedNpmPackageTarball(PLAYWRIGHT_PKG, release, destination, fetch),
    ).rejects.toThrow(/npm-provider:/);
    expect(fs.readFileSync(destination, "utf8")).toBe("unrelated\n");
  });

  it("rejects a symlink destination even when its target bytes exactly match", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(PLAYWRIGHT_PKG, version);
    const release = syntheticTarballRelease(PLAYWRIGHT_PKG, version, bytes);
    const dir = downloadSandbox();
    const targetDir = path.join(dir, "target");
    fs.mkdirSync(targetDir);
    const targetFile = path.join(targetDir, `cli-${version}.tgz`);
    fs.writeFileSync(targetFile, bytes);
    const destination = path.join(dir, `cli-${version}.tgz`);
    fs.symlinkSync(targetFile, destination);
    let called = 0;
    const symlinkFetch = (async (): Promise<Response> => {
      called += 1;
      throw new Error("fetch must not be called for symlink destination");
    }) as unknown as typeof fetch;

    await expect(
      downloadVerifiedNpmPackageTarball(PLAYWRIGHT_PKG, release, destination, symlinkFetch),
    ).rejects.toThrow(/npm-provider:/);
    expect(called).toBe(0);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(destination)).toBe(targetFile);
    expect(fs.readFileSync(targetFile)).toEqual(bytes);
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.readdirSync(dir).sort()).toEqual([`cli-${version}.tgz`, "target"].sort());
    expect(fs.readdirSync(targetDir)).toEqual([`cli-${version}.tgz`]);
  });

  it("reuses exact existing bytes offline without fetch", async () => {
    const { downloadVerifiedNpmPackageTarball } = await loadDownload();
    const version = "9.9.20";
    const bytes = syntheticTarballBytes(DEVTOOLS_PKG, version);
    const release = syntheticTarballRelease(DEVTOOLS_PKG, version, bytes);
    const dir = downloadSandbox();
    const destination = path.join(dir, `chrome-devtools-mcp-${version}.tgz`);
    fs.writeFileSync(destination, bytes);
    let called = 0;
    const offlineFetch = (async (): Promise<Response> => {
      called += 1;
      throw new Error("fetch must not be called for exact reuse");
    }) as unknown as typeof fetch;

    const result = await downloadVerifiedNpmPackageTarball(DEVTOOLS_PKG, release, destination, offlineFetch);

    expect(result).toEqual({
      path: destination,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    });
    expect(called).toBe(0);
    expect(fs.readFileSync(destination)).toEqual(bytes);
  });
});

type BrowserProviderModule = {
  prepareVerifiedBrowserRelease(
    packageName: string,
    options: { fetchImpl: typeof fetch; stageParent: string },
  ): Promise<NpmPackageRelease>;
};

const browserProviderSpecifier = new URL("../src/lib/browser-provider.js", import.meta.url).href;

async function loadBrowserProvider(): Promise<BrowserProviderModule> {
  const mod = (await import(/* @vite-ignore */ browserProviderSpecifier)) as Partial<BrowserProviderModule>;
  expect(
    mod.prepareVerifiedBrowserRelease,
    "prepareVerifiedBrowserRelease must be exported from src/lib/browser-provider.ts",
  ).toBeTypeOf("function");
  return mod as BrowserProviderModule;
}

const stageParents: string[] = [];

function stageParent(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-stage-"));
  stageParents.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of stageParents.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function providerFetch(
  pack: unknown,
  bytes: Uint8Array,
  tarballUrl: string,
  seen: string[],
  opts?: { urlOverride?: string },
): typeof fetch {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url === tarballUrl) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice());
          controller.close();
        },
      });
      const tarball = new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
      Object.defineProperty(tarball, "url", { value: opts?.urlOverride ?? url });
      return tarball;
    }
    const metadata = new Response(JSON.stringify(pack), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(metadata, "url", { value: url });
    return metadata;
  });
  return fetch as unknown as typeof fetch;
}

/**
 * T14-RED composition seam: one shared acquisition replacing the
 * metadata/download/stage logic reimplemented per caller. Returns the
 * observed release (not a tarball path) because callers only pass the exact
 * package version to pnpm after verification; the stage is always removed.
 */
describe("[T14-RED] shared verified browser release composes resolve plus verified bytes", () => {
  it("returns the observed Playwright release only after verified bytes and removes its own stage", async () => {
    const { prepareVerifiedBrowserRelease } = await loadBrowserProvider();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(PLAYWRIGHT_PKG, version);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const tarball = canonicalTarballFor(PLAYWRIGHT_PKG, version);
    const parent = stageParent();
    fs.writeFileSync(path.join(parent, "sentinel"), "keep\n");
    const seen: string[] = [];
    const fetch = providerFetch(syntheticPackument(PLAYWRIGHT_PKG, version, integrity), bytes, tarball, seen);

    const release = await prepareVerifiedBrowserRelease(PLAYWRIGHT_PKG, { fetchImpl: fetch, stageParent: parent });

    expect(release).toEqual({ version, tarballUrl: tarball, integrity });
    expect(seen).toEqual([`https://registry.npmjs.org/${PLAYWRIGHT_PKG}`, tarball]);
    expect(fs.readdirSync(parent)).toEqual(["sentinel"]);
  });

  it("returns the observed DevTools release only after verified bytes and removes its own stage", async () => {
    const { prepareVerifiedBrowserRelease } = await loadBrowserProvider();
    const version = "9.9.20";
    const bytes = syntheticTarballBytes(DEVTOOLS_PKG, version);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const tarball = canonicalTarballFor(DEVTOOLS_PKG, version);
    const parent = stageParent();
    const seen: string[] = [];
    const fetch = providerFetch(syntheticPackument(DEVTOOLS_PKG, version, integrity), bytes, tarball, seen);

    const release = await prepareVerifiedBrowserRelease(DEVTOOLS_PKG, { fetchImpl: fetch, stageParent: parent });

    expect(release).toEqual({ version, tarballUrl: tarball, integrity });
    expect(seen).toEqual([`https://registry.npmjs.org/${DEVTOOLS_PKG}`, tarball]);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("throws on an SRI mismatch without keeping temp or returning a release", async () => {
    const { prepareVerifiedBrowserRelease } = await loadBrowserProvider();
    const version = "9.9.10";
    const bytes = syntheticTarballBytes(PLAYWRIGHT_PKG, version);
    const wrongIntegrity = `sha512-${createHash("sha512").update("unrelated-test-bytes").digest("base64")}`;
    const tarball = canonicalTarballFor(PLAYWRIGHT_PKG, version);
    const parent = stageParent();
    fs.writeFileSync(path.join(parent, "sentinel"), "keep\n");
    const seen: string[] = [];
    const fetch = providerFetch(syntheticPackument(PLAYWRIGHT_PKG, version, wrongIntegrity), bytes, tarball, seen);

    await expect(
      prepareVerifiedBrowserRelease(PLAYWRIGHT_PKG, { fetchImpl: fetch, stageParent: parent }),
    ).rejects.toThrow(/browser-provider:/);
    expect(seen).toEqual([`https://registry.npmjs.org/${PLAYWRIGHT_PKG}`, tarball]);
    expect(fs.readdirSync(parent)).toEqual(["sentinel"]);
  });

  it("throws on a redirected tarball without keeping temp or returning a release", async () => {
    const { prepareVerifiedBrowserRelease } = await loadBrowserProvider();
    const version = "9.9.20";
    const bytes = syntheticTarballBytes(DEVTOOLS_PKG, version);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const tarball = canonicalTarballFor(DEVTOOLS_PKG, version);
    const parent = stageParent();
    const seen: string[] = [];
    const fetch = providerFetch(syntheticPackument(DEVTOOLS_PKG, version, integrity), bytes, tarball, seen, {
      urlOverride: `${tarball}?redirected=1`,
    });

    await expect(
      prepareVerifiedBrowserRelease(DEVTOOLS_PKG, { fetchImpl: fetch, stageParent: parent }),
    ).rejects.toThrow(/browser-provider:/);
    expect(seen).toEqual([`https://registry.npmjs.org/${DEVTOOLS_PKG}`, tarball]);
    expect(fs.readdirSync(parent)).toEqual([]);
  });
});
