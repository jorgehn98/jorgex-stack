import { describe, expect, it, vi } from "vitest";

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
