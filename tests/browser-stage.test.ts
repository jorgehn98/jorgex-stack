import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * T25 RED: the verified browser artifact must keep its complete pnpm closure
 * tied to official registry metadata before the stage can be promoted.
 *
 * Intended code-facing contract:
 * - `stageVerifiedBrowserTree({ artifactPath, packageName, release, stageDir,
 *   pnpmBin, fetchImpl }, { runPnpm })` is exported from
 *   `src/lib/browser-stage.ts`.
 * - `artifactPath` is the already SRI-verified root tarball. The stage owns a
 *   private HOME/store and invokes the injected pnpm boundary in that stage.
 * - `runPnpm(args, { cwd, env })` is allowed to be sync or async and does not
 *   return process output. The fake process below writes the structured lock
 *   evidence that the real `.pnpmfile.mjs` afterAllResolved hook emits; the
 *   product must not parse `pnpm-lock.yaml` ad hoc.
 * - Success returns `{ treePath, closure }`, with closure entries carrying
 *   `{ name, version, integrity }` for the root and every package actually
 *   resolved into the executable tree.
 *
 * These fixtures use synthetic bytes/versions only. They never invoke pnpm,
 * access the user's HOME, read Chrome state, or contact the network.
 */

type BrowserRelease = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type BrowserStageInput = {
  artifactPath: string;
  packageName: string;
  release: BrowserRelease;
  stageDir: string;
  pnpmBin: string;
  fetchImpl: typeof fetch;
};

type BrowserClosureEntry = {
  name: string;
  version: string;
  integrity: string;
};

type BrowserStageResult = {
  treePath: string;
  closure: BrowserClosureEntry[];
};

type PnpmRunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type BrowserStageModule = {
  stageVerifiedBrowserTree(
    input: BrowserStageInput,
    deps?: {
      runPnpm: (args: string[], options: PnpmRunOptions) => void | Promise<void>;
    },
  ): Promise<BrowserStageResult>;
};

const stageSpecifier = new URL("../src/lib/browser-stage.js", import.meta.url).href;

async function loadBrowserStage(): Promise<BrowserStageModule> {
  const mod = (await import(/* @vite-ignore */ stageSpecifier)) as Partial<BrowserStageModule>;
  expect(
    mod.stageVerifiedBrowserTree,
    "stageVerifiedBrowserTree must be exported from src/lib/browser-stage.ts",
  ).toBeTypeOf("function");
  return mod as BrowserStageModule;
}

const PACKAGE_NAME = "@playwright/cli";
const TRANSITIVE_NAME = "playwright-core";
const VERSION = "9.9.10";
const TRANSITIVE_VERSION = "9.9.11";
const ROOT_TARBALL_URL = `https://registry.npmjs.org/@playwright/cli/-/cli-${VERSION}.tgz`;
const TRANSITIVE_TARBALL_URL =
  `https://registry.npmjs.org/${TRANSITIVE_NAME}/-/${TRANSITIVE_NAME}-${TRANSITIVE_VERSION}.tgz`;

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-stage-red-"));
  sandboxes.push(root);
  return root;
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function canonicalMetadata(
  name: string,
  version: string,
  tarballUrl: string,
  integrity: string,
): Record<string, unknown> {
  return {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: { tarball: tarballUrl, integrity },
      },
    },
  };
}

function metadataFetch(
  entries: Array<{
    name: string;
    version: string;
    tarballUrl: string;
    integrity: string;
  }>,
  seen: string[],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const entry = entries.find(({ name }) =>
      url === `https://registry.npmjs.org/${name}`
      || url === `https://registry.npmjs.org/${name}/${entries.find((candidate) => candidate.name === name)?.version}`,
    );
    if (entry === undefined) throw new Error(`unexpected official metadata request: ${url}`);
    const response = new Response(
      JSON.stringify(canonicalMetadata(entry.name, entry.version, entry.tarballUrl, entry.integrity)),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch;
}

type StageFixture = {
  root: string;
  stageDir: string;
  artifactPath: string;
  rootBytes: Buffer;
  rootIntegrity: string;
  transitiveBytes: Buffer;
  officialTransitiveIntegrity: string;
  mirrorTransitiveIntegrity: string;
  release: BrowserRelease;
};

function buildFixture(): StageFixture {
  const root = sandbox();
  const stageDir = path.join(root, "stage");
  const storeDir = path.join(root, "pnpm-store");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  // The root artifact is the exact file whose SRI was verified by the
  // provider before this stage starts. It is not re-resolved by name.
  const rootBytes = Buffer.from("official-playwright-cli-root-9.9.10\n");
  const artifactPath = path.join(root, "downloads", `cli-${VERSION}.tgz`);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, rootBytes);

  const transitiveBytes = Buffer.from("official-playwright-core-transitive-9.9.11\n");
  const mirrorTransitiveBytes = Buffer.from("MIRROR-playwright-core-transitive-9.9.11\n");

  // Keep the isolated paths visible to the fake process; it must not fall
  // back to process.env.HOME or a user's pnpm store.
  void storeDir;
  void homeDir;

  const rootIntegrity = sri(rootBytes);
  return {
    root,
    stageDir,
    artifactPath,
    rootBytes,
    rootIntegrity,
    transitiveBytes,
    officialTransitiveIntegrity: sri(transitiveBytes),
    mirrorTransitiveIntegrity: sri(mirrorTransitiveBytes),
    release: {
      version: VERSION,
      tarballUrl: ROOT_TARBALL_URL,
      integrity: rootIntegrity,
    },
  };
}

function writeFakePnpmEvidence(
  fixture: StageFixture,
  options: PnpmRunOptions,
  transitiveIntegrity: string,
  transitiveBytes: Buffer,
): void {
  expect(options.cwd).toBe(fixture.stageDir);
  expect(options.env.HOME).toBeDefined();
  expect(options.env.HOME).not.toBe(process.env.HOME);

  const packages = {
    // The root is a local file reference to the exact provider-verified
    // artifact, not a version-only registry selector.
    [`${PACKAGE_NAME}@file:${path.relative(fixture.stageDir, fixture.artifactPath)}`]: {
      version: VERSION,
      resolution: {
        integrity: fixture.rootIntegrity,
        tarball: `file:${path.relative(fixture.stageDir, fixture.artifactPath)}`,
      },
      dependencies: { [TRANSITIVE_NAME]: TRANSITIVE_VERSION },
    },
    [`${TRANSITIVE_NAME}@${TRANSITIVE_VERSION}`]: {
      version: TRANSITIVE_VERSION,
      resolution: { integrity: transitiveIntegrity, tarball: TRANSITIVE_TARBALL_URL },
    },
  };

  // pnpm's afterAllResolved hook is represented as JSON here. The product
  // owns the hook and evidence path; this models the process boundary
  // without requiring pnpm or a YAML parser in the test.
  const lock = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          [PACKAGE_NAME]: { specifier: `file:${fixture.artifactPath}`, version: `file:${fixture.artifactPath}` },
        },
      },
    },
    packages,
    snapshots: {
      [`${PACKAGE_NAME}@${VERSION}`]: { dependencies: { [TRANSITIVE_NAME]: TRANSITIVE_VERSION } },
      [`${TRANSITIVE_NAME}@${TRANSITIVE_VERSION}`]: {},
    },
  };

  // The generated afterAllResolved hook receives this exact path through the
  // isolated child env. The verifier must consume this structured object,
  // not parse pnpm-lock.yaml or trust a mirror lockfile as an authority for
  // official SRI.
  const evidencePath = options.env.JORGEX_BROWSER_STAGE_LOCK;
  expect(evidencePath).toBeDefined();
  fs.writeFileSync(evidencePath!, `${JSON.stringify(lock, null, 2)}\n`);

  const rootDir = path.join(fixture.stageDir, "node_modules", "@playwright", "cli");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION, dependencies: { [TRANSITIVE_NAME]: TRANSITIVE_VERSION } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(rootDir, "index.js"), fixture.rootBytes);

  // Mirror pnpm's virtual store shape. The stage verifier inventories this
  // tree and binds every installed identity to the hook's lock closure.
  const rootVirtual = path.join(
    fixture.stageDir,
    "node_modules",
    ".pnpm",
    `${PACKAGE_NAME.replace("/", "+")}@${VERSION}`,
    "node_modules",
    "@playwright",
    "cli",
  );
  const transitiveVirtual = path.join(
    fixture.stageDir,
    "node_modules",
    ".pnpm",
    `${TRANSITIVE_NAME}@${TRANSITIVE_VERSION}`,
    "node_modules",
    TRANSITIVE_NAME,
  );
  fs.mkdirSync(rootVirtual, { recursive: true });
  fs.mkdirSync(transitiveVirtual, { recursive: true });
  fs.writeFileSync(path.join(rootVirtual, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION })}\n`);
  fs.writeFileSync(
    path.join(transitiveVirtual, "package.json"),
    `${JSON.stringify({ name: TRANSITIVE_NAME, version: TRANSITIVE_VERSION })}\n`,
  );
  fs.writeFileSync(path.join(transitiveVirtual, "index.js"), transitiveBytes);
}

function createRunPnpm(
  fixture: StageFixture,
  transitiveIntegrity: string,
  transitiveBytes: Buffer,
  calls: Array<{ args: string[]; options: PnpmRunOptions }>,
): (args: string[], options: PnpmRunOptions) => void {
  return (args, options) => {
    calls.push({ args: [...args], options: { cwd: options.cwd, env: { ...options.env } } });
    writeFakePnpmEvidence(fixture, options, transitiveIntegrity, transitiveBytes);
  };
}

function expectIsolatedPnpmCall(
  calls: Array<{ args: string[]; options: PnpmRunOptions }>,
  fixture: StageFixture,
): void {
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.args).toContain("install");
  expect(call.args).toContain("--ignore-scripts");
  expect(call.args.join(" ")).not.toContain("latest");
  expect(call.options.cwd).toBe(fixture.stageDir);
  expect(call.options.env.HOME).toBeDefined();
  expect(call.options.env.HOME).not.toBe(process.env.HOME);
  expect(call.options.env.npm_config_store_dir).toBeDefined();
  expect(call.options.env.JORGEX_BROWSER_STAGE_LOCK).toBeDefined();
  expect(path.resolve(call.options.env.HOME!)).toMatch(new RegExp(`^${fixture.stageDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path.sep}`));
  expect(path.resolve(call.options.env.npm_config_store_dir!)).toMatch(
    new RegExp(`^${fixture.stageDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path.sep}`),
  );
}

describe("[T25-RED] browser stage certifies official transitive closure", () => {
  it("returns root and transitive official SRI evidence from the isolated stage", async () => {
    const { stageVerifiedBrowserTree } = await loadBrowserStage();
    const fixture = buildFixture();
    const seen: string[] = [];
    const calls: Array<{ args: string[]; options: PnpmRunOptions }> = [];
    const result = await stageVerifiedBrowserTree(
      {
        artifactPath: fixture.artifactPath,
        packageName: PACKAGE_NAME,
        release: fixture.release,
        stageDir: fixture.stageDir,
        pnpmBin: "/isolated/pnpm/bin/pnpm",
        fetchImpl: metadataFetch(
          [
            {
              name: PACKAGE_NAME,
              version: VERSION,
              tarballUrl: ROOT_TARBALL_URL,
              integrity: fixture.rootIntegrity,
            },
            {
              name: TRANSITIVE_NAME,
              version: TRANSITIVE_VERSION,
              tarballUrl: TRANSITIVE_TARBALL_URL,
              integrity: fixture.officialTransitiveIntegrity,
            },
          ],
          seen,
        ),
      },
      { runPnpm: createRunPnpm(fixture, fixture.officialTransitiveIntegrity, fixture.transitiveBytes, calls) },
    );

    expectIsolatedPnpmCall(calls, fixture);
    expect(path.isAbsolute(result.treePath)).toBe(true);
    expect(result.treePath).toBe(path.join(fixture.stageDir, "node_modules", "@playwright", "cli"));
    expect(result.closure).toEqual(
      expect.arrayContaining([
        { name: PACKAGE_NAME, version: VERSION, integrity: fixture.rootIntegrity },
        { name: TRANSITIVE_NAME, version: TRANSITIVE_VERSION, integrity: fixture.officialTransitiveIntegrity },
      ]),
    );
    expect(result.closure).toHaveLength(2);
    expect(seen.some((url) => url.includes(TRANSITIVE_NAME))).toBe(true);
  });

  it("rejects a same-name/version mirror transitive before returning stage evidence", async () => {
    const { stageVerifiedBrowserTree } = await loadBrowserStage();
    const fixture = buildFixture();
    const seen: string[] = [];
    const calls: Array<{ args: string[]; options: PnpmRunOptions }> = [];
    const mirrorError = await stageVerifiedBrowserTree(
      {
        artifactPath: fixture.artifactPath,
        packageName: PACKAGE_NAME,
        release: fixture.release,
        stageDir: fixture.stageDir,
        pnpmBin: "/isolated/pnpm/bin/pnpm",
        fetchImpl: metadataFetch(
          [
            {
              name: PACKAGE_NAME,
              version: VERSION,
              tarballUrl: ROOT_TARBALL_URL,
              integrity: fixture.rootIntegrity,
            },
            {
              name: TRANSITIVE_NAME,
              version: TRANSITIVE_VERSION,
              tarballUrl: TRANSITIVE_TARBALL_URL,
              integrity: fixture.officialTransitiveIntegrity,
            },
          ],
          seen,
        ),
      },
      {
        runPnpm: createRunPnpm(
          fixture,
          fixture.mirrorTransitiveIntegrity,
          Buffer.from("MIRROR-playwright-core-transitive-9.9.11\n"),
          calls,
        ),
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expectIsolatedPnpmCall(calls, fixture);
    expect(mirrorError).toBeInstanceOf(Error);
    expect(String((mirrorError as Error).message)).toMatch(/integrity|official|closure|registry/i);
    expect(seen.some((url) => url.includes(TRANSITIVE_NAME))).toBe(true);
    expect(String((mirrorError as Error).message)).not.toContain("MIRROR-playwright-core");
  });

  it("does not inherit an ancestor workspace pnpmfile that patches the staged package", async () => {
    const { execFileSync } = await import("node:child_process");
    const { gzipSync } = await import("node:zlib");
    const { stageVerifiedBrowserTree } = await loadBrowserStage();

    const root = sandbox();
    const ancestor = path.join(root, "ancestor-workspace");
    const stageDir = path.join(ancestor, "stage");
    const downloads = path.join(ancestor, "downloads");
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });

    const writeTarGz = (target: string, name: string, version: string): Buffer => {
      const entries = [
        { name: "package/package.json", bytes: Buffer.from(`${JSON.stringify({ name, version, main: "index.js" })}\n`) },
        { name: "package/index.js", bytes: Buffer.from("module.exports = {};\n") },
      ];
      const blocks: Buffer[] = [];
      for (const entry of entries) {
        const header = Buffer.alloc(512);
        const writeText = (offset: number, length: number, value: string): void => {
          header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
        };
        const writeOctal = (offset: number, length: number, value: number): void => {
          const encoded = value.toString(8).padStart(length - 1, "0");
          writeText(offset, length - 1, encoded);
        };
        writeText(0, 100, entry.name);
        writeOctal(100, 8, 0o644);
        writeOctal(108, 8, 0);
        writeOctal(116, 8, 0);
        writeOctal(124, 12, entry.bytes.length);
        writeOctal(136, 12, 0);
        header.fill(0x20, 148, 156);
        header[156] = 0x30;
        writeText(257, 6, "ustar");
        writeText(263, 2, "00");
        let checksum = 0;
        for (const byte of header) checksum += byte;
        const checksumText = checksum.toString(8).padStart(6, "0");
        writeText(148, 6, checksumText);
        header[154] = 0;
        header[155] = 0x20;
        blocks.push(header, entry.bytes);
        const remainder = entry.bytes.length % 512;
        if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
      }
      blocks.push(Buffer.alloc(1024));
      fs.writeFileSync(target, gzipSync(Buffer.concat(blocks)), { mode: 0o600 });
      return fs.readFileSync(target);
    };

    const artifactPath = path.join(downloads, `cli-${VERSION}.tgz`);
    const rootBytes = writeTarGz(artifactPath, PACKAGE_NAME, VERSION);
    const extraTarball = path.join(ancestor, "external-patch.tgz");
    writeTarGz(extraTarball, "external-patch", "1.0.0");
    const marker = path.join(ancestor, "ancestor-global-hook-executed");
    const globalHook = path.join(ancestor, "global-hook.cjs");
    fs.writeFileSync(
      globalHook,
      [
        'const fs = require("node:fs");',
        `const marker = ${JSON.stringify(marker)};`,
        `const extraTarball = ${JSON.stringify(extraTarball)};`,
        "module.exports = { hooks: { readPackage(pkg) {",
        "  fs.writeFileSync(marker, \"executed\");",
        `  if (pkg.name !== ${JSON.stringify(PACKAGE_NAME)}) return pkg;`,
        "  return { ...pkg, version: \"9.9.99\", dependencies: { ...(pkg.dependencies ?? {}), \"external-patch\": `file:${extraTarball}` } };",
        "} } };\n",
      ].join("\n"),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(ancestor, ".npmrc"), `global-pnpmfile=${globalHook}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(ancestor, "pnpm-workspace.yaml"),
      `packages:\n  - "stage"\nglobalPnpmfile: ${JSON.stringify(globalHook)}\nlockfileDir: ${JSON.stringify(stageDir)}\n`,
      { mode: 0o600 },
    );

    const pnpmRoots = [
      path.join(os.homedir(), ".local", "share", "pnpm", ".tools", "pnpm"),
      ...(process.env.LOCALAPPDATA === undefined ? [] : [path.join(process.env.LOCALAPPDATA, "pnpm", ".tools", "pnpm")]),
    ];
    const pnpmCandidates: string[] = [];
    for (const rootPath of pnpmRoots) {
      for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("11.1.1")) continue;
        pnpmCandidates.push(path.join(rootPath, entry.name, "node_modules", "pnpm", "bin", "pnpm.mjs"));
      }
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const dir of pathEntries) {
      pnpmCandidates.push(path.join(dir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"));
    }
    const pnpmBin = pnpmCandidates.find((candidate) => {
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return false;
      try {
        return execFileSync(candidate, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "11.1.1";
      } catch {
        return false;
      }
    });
    expect(pnpmBin, "the focused test requires pnpm 11.1.1").toBeDefined();
    if (pnpmBin === undefined) return;

    let result: BrowserStageResult | null = null;
    let stageError: unknown = null;
    try {
      result = await stageVerifiedBrowserTree(
        {
          artifactPath,
          packageName: PACKAGE_NAME,
          release: {
            version: VERSION,
            tarballUrl: ROOT_TARBALL_URL,
            integrity: sri(rootBytes),
          },
          stageDir,
          pnpmBin,
          fetchImpl: metadataFetch([], []),
        },
      );
    } catch (error: unknown) {
      stageError = error;
    }

    expect(fs.existsSync(marker), "ancestor global pnpmfile must not execute").toBe(false);
    expect(stageError).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.closure).toEqual([{ name: PACKAGE_NAME, version: VERSION, integrity: sri(rootBytes) }]);
    expect(fs.existsSync(path.join(stageDir, "node_modules", "external-patch"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(result!.treePath, "package.json"), "utf8"))).toMatchObject({
      name: PACKAGE_NAME,
      version: VERSION,
    });
  });
});
