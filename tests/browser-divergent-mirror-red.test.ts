import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PACKAGE_NAME = "@playwright/cli";
const VERSION = "9.9.10";
const TARBALL_URL = `https://registry.npmjs.org/@playwright/cli/-/cli-${VERSION}.tgz`;
const METADATA_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const sandboxes: string[] = [];

type CandidateWithManagedArtifact = {
  version?: unknown;
  tarballUrl?: unknown;
  integrity?: unknown;
  artifactPath?: unknown;
};

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-mirror-red-"));
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function withSandboxEnvironment<T>(root: string, run: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"] as const;
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  const home = path.join(root, "home");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg-config");
  process.env.XDG_DATA_HOME = path.join(root, "xdg-data");
  process.env.XDG_CACHE_HOME = path.join(root, "xdg-cache");
  process.env.TMPDIR = path.join(root, "tmp");
  for (const value of [home, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME, process.env.TMPDIR]) {
    fs.mkdirSync(value!, { recursive: true });
  }

  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function officialProviderFetch(bytes: Buffer, integrity: string, seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url === METADATA_URL) {
      const response = new Response(JSON.stringify({
        name: PACKAGE_NAME,
        "dist-tags": { latest: VERSION },
        versions: {
          [VERSION]: {
            name: PACKAGE_NAME,
            version: VERSION,
            dist: { tarball: TARBALL_URL, integrity },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url === TARBALL_URL) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice());
          controller.close();
        },
      });
      const response = new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`unexpected provider request: ${url}`);
  }) as typeof fetch;
}

describe("[T24-RED] managed browser bytes cannot be replaced by a same-semver mirror", () => {
  it("promotes the verified artifact without touching a foreign global installation", async () => {
    const root = sandbox();
    const officialBytes = Buffer.from("official-playwright-cli-9.9.10\n");
    const mirrorBytes = Buffer.from("MIRROR-PLAYWRIGHT-CLI-9.9.10\n");
    const foreignGlobalBytes = Buffer.from("foreign-global-cli-preserve\n");
    const officialIntegrity = `sha512-${createHash("sha512").update(officialBytes).digest("base64")}`;
    const seen: string[] = [];
    const globalMarker = path.join(root, "foreign-global", "playwright-cli.tgz");
    const managedMarker = path.join(root, "managed-browser", "playwright-cli.tgz");
    fs.mkdirSync(path.dirname(globalMarker), { recursive: true });
    fs.writeFileSync(globalMarker, foreignGlobalBytes);

    await withSandboxEnvironment(root, async () => {
      vi.stubGlobal("fetch", officialProviderFetch(officialBytes, officialIntegrity, seen));
      const install = await import("../src/install.js");
      const runCandidates: CandidateWithManagedArtifact[] = [];

      const exitCode = await install.runInstall({
        runtimes: [],
        dryRun: false,
        yes: true,
        showSummary: false,
        engramBin: null,
        mode: { mode: "human", subagentConcurrency: "serial" },
        playwrightToolConsent: {
          command: "install",
          interactive: false,
          yes: true,
          targetDir: false,
          explicitToolSelection: true,
          confirmed: false,
        },
        playwrightToolDeps: {
          // This is the existing runInstall activation seam. It deliberately
          // does not invoke real pnpm or HOME: the temporary callback models
          // the old fallback by writing mirror bytes to the foreign marker
          // whenever the candidate has no managed artifact path.
          run: async (_action, _env, candidate) => {
            const selected = (candidate ?? {}) as CandidateWithManagedArtifact;
            runCandidates.push(selected);
            if (typeof selected.artifactPath !== "string") {
              fs.writeFileSync(globalMarker, mirrorBytes);
            } else {
              const bytes = fs.readFileSync(selected.artifactPath);
              fs.mkdirSync(path.dirname(managedMarker), { recursive: true });
              fs.writeFileSync(managedMarker, bytes);
            }
            return true;
          },
          persistEnabled: () => undefined,
        },
      });

      expect(exitCode).toBe(0);
      expect(seen).toEqual([METADATA_URL, TARBALL_URL]);
      expect(runCandidates).toHaveLength(2);
    });

    // T24 RED contract: Stack must pass the retained verified artifact into
    // activation. The current candidate carries only version/URL/SRI, so the
    // seam falls back to the same-semver mirror and mutates the foreign marker.
    expect(fs.readFileSync(globalMarker)).toEqual(foreignGlobalBytes);
    expect(fs.readFileSync(managedMarker)).toEqual(officialBytes);
  });
});
