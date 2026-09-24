import { describe, expect, it, vi } from "vitest";

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
