import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserTreeSha256 } from "../src/lib/browser-stage.js";
import {
  activateManagedBrowserTree,
  loadVerifiedManagedBrowserReceipt,
  type ActivateManagedBrowserTreeInput,
  type ManagedBrowserReceipt,
} from "../src/lib/browser-managed.js";

/**
 * T25 RED: activation must promote the exact browser tree that passed the
 * isolated stage. It must not resolve a package by name, mutate a global
 * installation, or publish a receipt before the copied tree is rechecked.
 *
 * The fixture intentionally mirrors the small producer/consumer vector used
 * by Pi's browser-v2 inventory. The digest is a literal shared-contract
 * value, not a digest calculated by this test.
 */

const PACKAGE_NAME = "@playwright/cli" as const;
const VERSION = "9.9.10" as const;
const TRANSITIVE_NAME = "playwright-core" as const;
const TRANSITIVE_VERSION = "9.9.11" as const;
const TARBALL_URL = `https://registry.npmjs.org/@playwright/cli/-/cli-${VERSION}.tgz`;
const ROOT_BYTES = Buffer.from("official-playwright-cli-root-9.9.10\n");
const TRANSITIVE_BYTES = Buffer.from("official-playwright-core-transitive-9.9.11\n");
const ROOT_INTEGRITY = `sha512-${createHash("sha512").update(ROOT_BYTES).digest("base64")}`;
const TRANSITIVE_INTEGRITY = `sha512-${createHash("sha512").update(TRANSITIVE_BYTES).digest("base64")}`;
const LITERAL_BROWSER_V2_TREE_SHA256 =
  "c02d72c5667404d3049bb6a4e92501c258f5b8eb09aa1b0012368cf6b004c931";

type Fixture = {
  root: string;
  stateDir: string;
  foreignMarker: string;
  staged: ActivateManagedBrowserTreeInput["staged"];
  input: ActivateManagedBrowserTreeInput;
};

const sandboxes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-managed-red-"));
  sandboxes.push(root);
  return root;
}

function writeFixture(): Fixture {
  const root = sandbox();
  const stageDir = path.join(root, "stage");
  const stateDir = path.join(root, "state");
  const nodeModulesPath = path.join(stageDir, "node_modules");
  const treePath = path.join(nodeModulesPath, "@playwright", "cli");
  const entryPath = path.join(treePath, "index.js");
  const foreignMarker = path.join(root, "foreign-global", "playwright-cli.marker");

  fs.mkdirSync(treePath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(foreignMarker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(foreignMarker, "foreign installation must remain untouched\n", { mode: 0o600 });

  // Keep this tree byte-for-byte aligned with the browser-v2 producer vector:
  // root package, one virtual-store copy of each closure member, and one safe
  // internal relative symlink in the root package.
  fs.writeFileSync(
    path.join(treePath, "package.json"),
    `${JSON.stringify(
      { name: PACKAGE_NAME, version: VERSION, dependencies: { [TRANSITIVE_NAME]: TRANSITIVE_VERSION } },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(entryPath, ROOT_BYTES);
  fs.symlinkSync("index.js", path.join(treePath, "runtime-link"));

  const rootVirtual = path.join(
    nodeModulesPath,
    ".pnpm",
    `${PACKAGE_NAME.replace("/", "+")}@${VERSION}`,
    "node_modules",
    "@playwright",
    "cli",
  );
  const transitiveVirtual = path.join(
    nodeModulesPath,
    ".pnpm",
    `${TRANSITIVE_NAME}@${TRANSITIVE_VERSION}`,
    "node_modules",
    TRANSITIVE_NAME,
  );
  fs.mkdirSync(rootVirtual, { recursive: true, mode: 0o700 });
  fs.mkdirSync(transitiveVirtual, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(rootVirtual, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION })}\n`,
  );
  fs.writeFileSync(
    path.join(transitiveVirtual, "package.json"),
    `${JSON.stringify({ name: TRANSITIVE_NAME, version: TRANSITIVE_VERSION })}\n`,
  );
  fs.writeFileSync(path.join(transitiveVirtual, "index.js"), TRANSITIVE_BYTES);

  const staged: ActivateManagedBrowserTreeInput["staged"] = {
    treePath,
    nodeModulesPath,
    treeSha256: LITERAL_BROWSER_V2_TREE_SHA256,
    closure: [
      { name: PACKAGE_NAME, version: VERSION, integrity: ROOT_INTEGRITY },
      { name: TRANSITIVE_NAME, version: TRANSITIVE_VERSION, integrity: TRANSITIVE_INTEGRITY },
    ],
  };
  const input: ActivateManagedBrowserTreeInput = {
    stateDir,
    packageName: PACKAGE_NAME,
    release: { version: VERSION, tarballUrl: TARBALL_URL, integrity: ROOT_INTEGRITY },
    staged,
    entryPath,
  };
  return { root, stateDir, foreignMarker, staged, input };
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readManagedReceipts(stateDir: string): Array<{ path: string; receipt: ManagedBrowserReceipt }> {
  const receipts: Array<{ path: string; receipt: ManagedBrowserReceipt }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Reflect.get(parsed, "schemaVersion") === 1 &&
        Reflect.get(parsed, "packageName") === PACKAGE_NAME &&
        Reflect.get(parsed, "rootPath") !== undefined &&
        Reflect.get(parsed, "treePath") !== undefined &&
        Reflect.get(parsed, "launcherPath") !== undefined
      ) {
        receipts.push({ path: fullPath, receipt: parsed as ManagedBrowserReceipt });
      }
    }
  };
  if (fs.existsSync(stateDir)) visit(stateDir);
  return receipts;
}

type ActiveBrowserPointer = {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly rootPath: string;
  readonly receiptSha256: string;
};

type ManagedBrowserInvocationPlan = {
  command: string;
  args: string[];
};

type ManagedBrowserInvocationPlanner = (
  stateDir: string,
  packageName: string,
  runtimeArgs: readonly string[],
) => ManagedBrowserInvocationPlan;

async function loadManagedBrowserInvocationPlanner(): Promise<ManagedBrowserInvocationPlanner> {
  const moduleNamespace = await import("../src/lib/browser-managed.js");
  const planner = Reflect.get(moduleNamespace, "planManagedBrowserInvocation");
  expect(planner, "planManagedBrowserInvocation must be exported").toBeTypeOf("function");
  return planner as ManagedBrowserInvocationPlanner;
}

function readActivePointer(receipt: ManagedBrowserReceipt): {
  path: string;
  raw: Buffer;
  value: ActiveBrowserPointer;
} {
  const pointerPath = path.join(path.dirname(receipt.rootPath), "active.v1.json");
  const raw = fs.readFileSync(pointerPath);
  return { path: pointerPath, raw, value: JSON.parse(raw.toString("utf8")) as ActiveBrowserPointer };
}

function releaseRoots(receipt: ManagedBrowserReceipt): string[] {
  return fs
    .readdirSync(path.dirname(receipt.rootPath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("release-"))
    .map((entry) => path.join(path.dirname(receipt.rootPath), entry.name))
    .sort();
}

function assertActivePointer(receipt: ManagedBrowserReceipt, fixture: Fixture): { path: string; raw: Buffer } {
  const pointer = readActivePointer(receipt);
  expect(Object.keys(pointer.value).sort()).toEqual(
    ["packageName", "receiptSha256", "rootPath", "schemaVersion"].sort(),
  );
  const receiptBytes = fs.readFileSync(path.join(receipt.rootPath, "receipt.json"));
  expect(pointer.value).toEqual({
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    rootPath: receipt.rootPath,
    receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
  });
  expect(isContained(fixture.stateDir, pointer.path)).toBe(true);
  expect(isContained(fixture.stateDir, pointer.value.rootPath)).toBe(true);
  return { path: pointer.path, raw: pointer.raw };
}

function nextCandidate(input: ActivateManagedBrowserTreeInput): ActivateManagedBrowserTreeInput {
  const version = "9.9.11";
  return {
    ...input,
    release: {
      ...input.release,
      version,
      tarballUrl: `https://registry.npmjs.org/@playwright/cli/-/cli-${version}.tgz`,
    },
    staged: {
      ...input.staged,
      closure: input.staged.closure.map((entry) =>
        entry.name === PACKAGE_NAME ? { ...entry, version } : entry,
      ),
    },
  };
}

function assertStrictReceipt(receipt: ManagedBrowserReceipt, fixture: Fixture): void {
  expect(Object.keys(receipt).sort()).toEqual(
    [
      "closure",
      "entryPath",
      "integrity",
      "launcherPath",
      "launcherSha256",
      "packageName",
      "rootPath",
      "schemaVersion",
      "treePath",
      "treeSha256",
      "version",
    ].sort(),
  );
  expect(receipt).toMatchObject({
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    version: VERSION,
    integrity: ROOT_INTEGRITY,
    treeSha256: LITERAL_BROWSER_V2_TREE_SHA256,
    closure: fixture.staged.closure,
  });

  for (const [label, value] of [
    ["rootPath", receipt.rootPath],
    ["treePath", receipt.treePath],
    ["entryPath", receipt.entryPath],
    ["launcherPath", receipt.launcherPath],
  ] as const) {
    expect(path.isAbsolute(value), `${label} must be absolute`).toBe(true);
    expect(isContained(fixture.stateDir, value), `${label} must be contained in stateDir`).toBe(true);
  }
  expect(receipt.treePath).toBe(path.join(receipt.rootPath, "node_modules"));
  expect(fs.statSync(receipt.treePath).isDirectory()).toBe(true);
  expect(fs.statSync(receipt.entryPath).isFile()).toBe(true);
  expect(receipt.launcherPath).not.toBe(receipt.entryPath);
  const launcherStat = fs.lstatSync(receipt.launcherPath);
  expect(launcherStat.isFile()).toBe(true);
  expect(launcherStat.isSymbolicLink()).toBe(false);
  const launcherBytes = fs.readFileSync(receipt.launcherPath);
  expect(launcherBytes.byteLength).toBeGreaterThan(0);
  expect(receipt.launcherSha256).toBe(createHash("sha256").update(launcherBytes).digest("hex"));
  expect(launcherBytes.toString("utf8")).toContain(LITERAL_BROWSER_V2_TREE_SHA256);
  expect(fs.readFileSync(receipt.entryPath)).toEqual(ROOT_BYTES);
}

describe.skipIf(process.platform !== "linux")("[T25-RED] managed browser activation", () => {
  it("runs DevTools only through the external guard with fixed flags and untampered bytes", async () => {
    const root = sandbox();
    const stageDir = path.join(root, "stage");
    const stateDir = path.join(root, "state");
    const nodeModulesPath = path.join(stageDir, "node_modules");
    const treePath = path.join(nodeModulesPath, "chrome-devtools-mcp");
    const entryPath = path.join(treePath, "index.js");
    const marker = path.join(root, "devtools.marker");
    const version = "9.9.10";
    const integrity = `sha512-${Buffer.alloc(64, 17).toString("base64")}`;
    const flags = ["--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"];
    fs.mkdirSync(treePath, { recursive: true });
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(treePath, "package.json"), `${JSON.stringify({ name: "chrome-devtools-mcp", version })}\n`);
    fs.writeFileSync(entryPath, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran\\n");\n`);
    const receipt = await activateManagedBrowserTree({
      stateDir, packageName: "chrome-devtools-mcp",
      release: { version, integrity, tarballUrl: `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${version}.tgz` },
      staged: { treePath, nodeModulesPath, treeSha256: browserTreeSha256(nodeModulesPath, stageDir),
        closure: [{ name: "chrome-devtools-mcp", version, integrity }] },
      entryPath,
    });
    const planner = await loadManagedBrowserInvocationPlanner();
    expect(() => planner(stateDir, "chrome-devtools-mcp", ["--isolated"])).toThrow(/flags|privacy/i);
    const plan = planner(stateDir, "chrome-devtools-mcp", flags);
    const run = () => spawnSync(plan.command, plan.args, { encoding: "utf8", timeout: 30_000 });
    expect(run().status).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("ran\n");
    fs.unlinkSync(marker);
    fs.appendFileSync(receipt.entryPath, "// tampered after planning\n");
    const tampered = run();
    expect(tampered.status).not.toBe(0);
    expect(`${tampered.stdout ?? ""}${tampered.stderr ?? ""}`).toMatch(/digest|drift/i);
    expect(fs.existsSync(marker)).toBe(false);
  });
  it("runs the Playwright user command through the external guard only while opted in", async () => {
    const fixture = writeFixture();
    const marker = path.join(fixture.root, "playwright-command.marker");
    fs.writeFileSync(fixture.input.entryPath, [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
      'process.stdout.write("playwright-cli 9.9.10\\n");',
    ].join("\n"));
    const staged = { ...fixture.staged, treeSha256: browserTreeSha256(
      fixture.staged.nodeModulesPath, path.dirname(fixture.staged.nodeModulesPath),
    ) };
    await activateManagedBrowserTree({ ...fixture.input, staged });
    const api = await import("../src/lib/browser-command.js") as Record<string, unknown>;
    const run = api.runManagedPlaywrightCommand as ((args: string[], stateDir: string) => number) | undefined;
    const runBeforePreference = api.runVerifiedManagedPlaywright as
      | ((stateDir: string, args: string[], options: { captureOutput: boolean }) => { status: number | null; stdout: string })
      | undefined;
    expect(run, "managed Playwright user command is missing").toBeTypeOf("function");
    expect(runBeforePreference, "managed Playwright install invocation is missing").toBeTypeOf("function");
    expect(() => run!(["--version"], fixture.stateDir)).toThrow(/opt.in|enabled|preference/i);
    expect(runBeforePreference!(fixture.stateDir, ["--version"], { captureOutput: true }).status).toBe(0);

    fs.writeFileSync(path.join(fixture.stateDir, "playwright-cli.json"), JSON.stringify({
      version: 1, enabled: true, observed: { version: VERSION, integrity: ROOT_INTEGRITY },
    }));
    expect(run!(["--version"], fixture.stateDir)).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(["--version"]);
    const { inspectManagedPlaywrightCapability } = await import("../src/lib/playwright-capability.js");
    const capability = inspectManagedPlaywrightCapability({
      stateDir: fixture.stateDir,
      env: { ...process.env, XDG_CACHE_HOME: path.join(fixture.root, "empty-cache") },
    });
    expect(capability.cli.status).toBe("current");
    expect(capability.browserCache.status).toBe("missing");
    expect(capability.effective).toBe(false);
    fs.unlinkSync(marker);
    const receipt = loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)!;
    fs.appendFileSync(receipt.entryPath, "// managed tree drift\n");
    expect(() => run!(["--version"], fixture.stateDir)).toThrow(/digest|drift/i);
    expect(inspectManagedPlaywrightCapability({ stateDir: fixture.stateDir }).cli.status).toBe("broken");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("resolves only the declared package bin inside the verified staged root", async () => {
    const fixture = writeFixture();
    const api = await import("../src/lib/browser-managed.js") as Record<string, unknown>;
    const resolveEntry = api.resolveStagedBrowserEntry as
      | ((staged: Fixture["staged"], packageName: typeof PACKAGE_NAME) => string)
      | undefined;
    expect(resolveEntry, "managed browser bin resolver is missing").toBeTypeOf("function");
    const manifestPath = path.join(fixture.staged.treePath, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.bin = { "playwright-cli": "./index.js" };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(resolveEntry!(fixture.staged, PACKAGE_NAME)).toBe(fixture.input.entryPath);

    manifest.bin = { "playwright-cli": "../../escape.js" };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => resolveEntry!(fixture.staged, PACKAGE_NAME)).toThrow(/bin|entry|escape|root/i);

    manifest.bin = { "playwright-cli": "./runtime-link" };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => resolveEntry!(fixture.staged, PACKAGE_NAME)).toThrow(/bin|entry|symlink/i);
  });

  it("projects Pi's published trusted DevTools handoff from an active verified receipt", async () => {
    const fixture = writeFixture();
    const api = await import("../src/lib/pi-projection-lifecycle.js") as Record<string, unknown>;
    const trusted = api.trustedDevtoolsHandoff as ((stateDir: string) => Record<string, unknown>) | undefined;
    expect(trusted, "Pi v3 handoff materializer is missing").toBeTypeOf("function");
    expect(() => trusted!(fixture.stateDir)).toThrow(/missing|absent|receipt/i);

    const devtoolsInput = {
      ...fixture.input,
      packageName: "chrome-devtools-mcp" as const,
      release: {
        ...fixture.input.release,
        tarballUrl: `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${VERSION}.tgz`,
      },
      staged: {
        ...fixture.staged,
        closure: fixture.staged.closure.map((item) => item.name === PACKAGE_NAME
          ? { ...item, name: "chrome-devtools-mcp" } : item),
      },
    };
    const receipt = await activateManagedBrowserTree(devtoolsInput);
    const handoff = trusted!(fixture.stateDir);
    expect(Object.keys(handoff).sort()).toEqual([
      "args", "command", "enabled", "entryPath", "launcherPath", "launcherSha256",
      "rootPath", "schemaVersion", "treePath", "treeSha256",
    ].sort());
    expect(handoff).toEqual({
      schemaVersion: 3,
      enabled: true,
      command: process.execPath,
      args: [receipt.launcherPath, "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"],
      entryPath: receipt.entryPath,
      launcherPath: receipt.launcherPath,
      launcherSha256: receipt.launcherSha256,
      rootPath: receipt.rootPath,
      treePath: receipt.treePath,
      treeSha256: receipt.treeSha256,
    });
  });

  it("materializes Pi Playwright v2 from a verified tree and separate Stack dispatcher", async () => {
    const fixture = writeFixture();
    const dispatcher = path.join(fixture.root, "jorgex-stack-playwright");
    fs.writeFileSync(dispatcher, "#!/bin/sh\nprintf 'playwright-cli 9.9.10\\n'\n");
    fs.chmodSync(dispatcher, 0o755);
    const { trustedPlaywrightHandoff } = await import("../src/lib/pi-projection-lifecycle.js");
    expect(() => trustedPlaywrightHandoff(fixture.stateDir, dispatcher)).toThrow(/receipt/i);
    const receipt = await activateManagedBrowserTree(fixture.input);
    const handoff = trustedPlaywrightHandoff(fixture.stateDir, dispatcher);
    expect(Object.keys(handoff).sort()).toEqual([
      "command", "commandSha256", "enabled", "entryPath", "launcherPath", "launcherSha256",
      "rootPath", "schemaVersion", "treePath", "treeSha256", "version",
    ].sort());
    expect(handoff).toEqual({
      schemaVersion: 2, enabled: true, command: dispatcher, version: VERSION,
      commandSha256: createHash("sha256").update(fs.readFileSync(dispatcher)).digest("hex"),
      rootPath: receipt.rootPath, treePath: receipt.treePath, entryPath: receipt.entryPath,
      launcherPath: receipt.launcherPath, launcherSha256: receipt.launcherSha256,
      treeSha256: receipt.treeSha256,
    });
    fs.chmodSync(receipt.launcherPath, 0o755);
    expect(() => trustedPlaywrightHandoff(fixture.stateDir, receipt.launcherPath)).toThrow(/dispatcher.*outside|outside.*release/i);
  });


  it("distinguishes absent state from an orphaned managed release", async () => {
    const absentRoot = sandbox();
    const absentStateDir = path.join(absentRoot, "absent-state");
    expect(loadVerifiedManagedBrowserReceipt(absentStateDir, PACKAGE_NAME)).toBeNull();

    const staleRoot = sandbox();
    const staleStateDir = path.join(staleRoot, "state");
    const stalePackageDir = path.join(staleStateDir, ".browser-managed", "playwright-cli");
    fs.mkdirSync(stalePackageDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stalePackageDir, ".activation.lock"), "stale lock owner\n", { mode: 0o600 });
    expect(() => loadVerifiedManagedBrowserReceipt(staleStateDir, PACKAGE_NAME)).toThrow(/orphan|lock/i);

    const fixture = writeFixture();
    const receipt = await activateManagedBrowserTree(fixture.input);
    expect(loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)).toEqual(receipt);

    fs.unlinkSync(path.join(path.dirname(receipt.rootPath), "active.v1.json"));
    expect(fs.existsSync(receipt.rootPath)).toBe(true);
    expect(() => loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)).toThrow(
      /orphan|partial|active browser pointer|managed browser state/i,
    );
  });

  it("plans a trusted inline guard that preserves args and blocks launcher/tree tampering", async () => {
    const planner = await loadManagedBrowserInvocationPlanner();
    const fixture = writeFixture();
    const markerPath = path.join(fixture.root, "planned-entry.marker");
    fs.writeFileSync(
      fixture.input.entryPath,
      [
        'import fs from "node:fs";',
        `const marker = ${JSON.stringify(markerPath)};`,
        'fs.writeFileSync(marker, JSON.stringify(process.argv.slice(2)));',
        "",
      ].join("\n"),
    );
    const staged = {
      ...fixture.input.staged,
      treeSha256: browserTreeSha256(
        fixture.input.staged.nodeModulesPath,
        path.dirname(fixture.input.staged.nodeModulesPath),
      ),
    };
    const receipt = await activateManagedBrowserTree({ ...fixture.input, staged });
    const runtimeArgs = ["--from-runtime", "value with spaces"];
    const plan = planner(fixture.stateDir, PACKAGE_NAME, runtimeArgs);

    expect(plan.command).toBe(process.execPath);
    expect(plan.args.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
    expect(plan.args).toHaveLength(4 + runtimeArgs.length);
    expect(plan.args[2]).toMatch(/import|digest|tree/);
    expect(plan.args[3]).toBe(receipt.launcherPath);
    expect(plan.args.slice(4)).toEqual(runtimeArgs);
    expect(plan.args[2]).not.toBe(receipt.launcherPath);

    const runPlan = () => spawnSync(plan.command, plan.args, { encoding: "utf8", timeout: 30_000 });
    const intact = runPlan();
    expect(intact.error).toBeUndefined();
    expect(intact.status, intact.stderr ?? "").toBe(0);
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toEqual(runtimeArgs);

    const launcherBytes = fs.readFileSync(receipt.launcherPath);
    fs.rmSync(markerPath);
    fs.appendFileSync(receipt.launcherPath, "\n// launcher tamper\n");
    const launcherTampered = runPlan();
    expect(launcherTampered.error).toBeUndefined();
    expect(launcherTampered.status).not.toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    fs.writeFileSync(receipt.launcherPath, launcherBytes);

    fs.appendFileSync(receipt.entryPath, "\n// tree entry tamper\n");
    const treeTampered = runPlan();
    expect(treeTampered.error).toBeUndefined();
    expect(treeTampered.status).not.toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("promotes only the staged bytes, preserves safe symlinks, and persists a strict receipt", async () => {
    const fixture = writeFixture();
    const receipt = await activateManagedBrowserTree(fixture.input);

    assertStrictReceipt(receipt, fixture);
    const persisted = readManagedReceipts(fixture.stateDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.receipt).toEqual(receipt);
    expect(isContained(fixture.stateDir, persisted[0]!.path)).toBe(true);

    const copiedLink = path.join(receipt.treePath, "@playwright", "cli", "runtime-link");
    expect(fs.lstatSync(copiedLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(copiedLink)).toBe("index.js");
    expect(fs.readFileSync(copiedLink)).toEqual(ROOT_BYTES);
    expect(fs.readFileSync(fixture.foreignMarker, "utf8")).toBe("foreign installation must remain untouched\n");
  });

  it("executes the generated launcher through Pi's async eval boundary and blocks a later tree tamper", async () => {
    const fixture = writeFixture();
    const markerPath = path.join(fixture.root, "entry-ran.marker");
    fs.writeFileSync(
      fixture.input.entryPath,
      [
        'import fs from "node:fs";',
        `const marker = ${JSON.stringify(markerPath)};`,
        'fs.appendFileSync(marker, "ran\\n");',
        "",
      ].join("\n"),
    );
    const staged = {
      ...fixture.input.staged,
      treeSha256: browserTreeSha256(
        fixture.input.staged.nodeModulesPath,
        path.dirname(fixture.input.staged.nodeModulesPath),
      ),
    };
    const receipt = await activateManagedBrowserTree({ ...fixture.input, staged });
    const launcherSource = fs.readFileSync(receipt.launcherPath, "utf8");
    const runLauncher = () =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `(async()=>{\n${launcherSource}\n})()`,
          receipt.launcherPath,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );

    expect(fs.existsSync(markerPath)).toBe(false);
    const intact = runLauncher();
    expect(intact.error).toBeUndefined();
    expect(intact.status, intact.stderr ?? "").toBe(0);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("ran\n");

    fs.appendFileSync(receipt.entryPath, "// drift after first launch\n");
    const tampered = runLauncher();
    expect(tampered.error).toBeUndefined();
    expect(tampered.status).not.toBe(0);
    expect(`${tampered.stdout ?? ""}${tampered.stderr ?? ""}`).toMatch(/digest|drift/i);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("ran\n");
  });

  it("publishes an owned active pointer and reuses the same release on repeated activation", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);

    const pointerBefore = assertActivePointer(first, fixture);
    const receiptPath = path.join(first.rootPath, "receipt.json");
    const receiptBefore = fs.readFileSync(receiptPath);
    expect(releaseRoots(first)).toEqual([first.rootPath]);

    const second = await activateManagedBrowserTree(fixture.input);

    expect(second.rootPath).toBe(first.rootPath);
    expect(releaseRoots(first)).toEqual([first.rootPath]);
    expect(fs.readFileSync(pointerBefore.path)).toEqual(pointerBefore.raw);
    expect(fs.readFileSync(receiptPath)).toEqual(receiptBefore);
  });

  it("keeps the active pointer, receipt, and release when a reattempted stage drifts", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const receiptPath = path.join(first.rootPath, "receipt.json");
    const receiptBefore = fs.readFileSync(receiptPath);
    const releasesBefore = releaseRoots(first);

    fs.appendFileSync(fixture.input.entryPath, "stage drift on reattempt\n");
    await expect(activateManagedBrowserTree(fixture.input)).rejects.toThrow(/tree|digest|drift/i);

    expect(fs.readFileSync(pointerBefore.path)).toEqual(pointerBefore.raw);
    expect(fs.readFileSync(receiptPath)).toEqual(receiptBefore);
    expect(releaseRoots(first)).toEqual(releasesBefore);
  });

  it("restores the previous release when a newly linked active pointer fails readback", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const before = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const originalLink = fs.linkSync;
    let injected = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      originalLink(source, destination);
      if (!injected && String(destination) === before.path && String(source).includes(".active-")) {
        injected = true;
        fs.writeFileSync(destination, "corrupt new pointer\n");
      }
    });

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/pointer.*readback|rollback/i);
    expect(injected).toBe(true);
    expect(fs.readFileSync(before.path)).toEqual(before.raw);
    expect(loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)?.rootPath).toBe(first.rootPath);
    expect(fs.existsSync(first.launcherPath)).toBe(true);
  });

  it("restores the prior active release after a later browser smoke fails", async () => {
    const fixture = writeFixture();
    const previous = await activateManagedBrowserTree(fixture.input);
    const before = assertActivePointer(previous, fixture);
    const candidate = await activateManagedBrowserTree(nextCandidate(fixture.input));
    const moduleNamespace = await import("../src/lib/browser-managed.js") as Record<string, unknown>;
    const rollback = moduleNamespace.rollbackManagedBrowserActivation as
      | ((stateDir: string, packageName: typeof PACKAGE_NAME, current: ManagedBrowserReceipt,
        previous: ManagedBrowserReceipt | null) => Promise<void>) | undefined;
    expect(rollback).toBeTypeOf("function");
    await rollback!(fixture.stateDir, PACKAGE_NAME, candidate, previous);
    expect(fs.readFileSync(before.path)).toEqual(before.raw);
    expect(loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)?.rootPath).toBe(previous.rootPath);
  });

  it("removes a fresh active release after a later browser smoke fails", async () => {
    const fixture = writeFixture();
    const candidate = await activateManagedBrowserTree(fixture.input);
    const moduleNamespace = await import("../src/lib/browser-managed.js") as Record<string, unknown>;
    const rollback = moduleNamespace.rollbackManagedBrowserActivation as
      | ((stateDir: string, packageName: typeof PACKAGE_NAME, current: ManagedBrowserReceipt,
        previous: ManagedBrowserReceipt | null) => Promise<void>) | undefined;
    expect(rollback).toBeTypeOf("function");
    await rollback!(fixture.stateDir, PACKAGE_NAME, candidate, null);
    expect(loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)).toBeNull();
    await expect(activateManagedBrowserTree(fixture.input)).resolves.toMatchObject({ version: VERSION });
  });

  it("keeps a failed first activation recoverable when candidate cleanup cannot finish", async () => {
    const fixture = writeFixture();
    const candidate = await activateManagedBrowserTree(fixture.input);
    const moduleNamespace = await import("../src/lib/browser-managed.js") as Record<string, unknown>;
    const rollback = moduleNamespace.rollbackManagedBrowserActivation as
      (stateDir: string, packageName: typeof PACKAGE_NAME, current: ManagedBrowserReceipt,
        previous: ManagedBrowserReceipt | null) => Promise<void>;
    const originalRm = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).includes(".failed-")) throw Object.assign(new Error("simulated disk failure"), { code: "ENOSPC" });
      return originalRm(target, options);
    });

    await expect(rollback(fixture.stateDir, PACKAGE_NAME, candidate, null)).rejects.toThrow(/quarantin|cleanup|ENOSPC/i);
    expect(loadVerifiedManagedBrowserReceipt(fixture.stateDir, PACKAGE_NAME)).toBeNull();
    await expect(activateManagedBrowserTree(fixture.input)).resolves.toMatchObject({ version: VERSION });
  });

  it("blocks an existing foreign active pointer without overwriting it", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerPath = path.join(path.dirname(first.rootPath), "active.v1.json");
    const foreignRoot = path.join(fixture.root, "foreign-release");
    fs.mkdirSync(foreignRoot, { recursive: true, mode: 0o700 });
    const foreignPointer = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        packageName: PACKAGE_NAME,
        rootPath: foreignRoot,
        receiptSha256: "0".repeat(64),
      })}\n`,
    );
    fs.writeFileSync(pointerPath, foreignPointer, { mode: 0o600 });

    await expect(activateManagedBrowserTree(fixture.input)).rejects.toThrow(/active|managed|ownership|receipt|pointer/i);
    expect(fs.readFileSync(pointerPath)).toEqual(foreignPointer);
    expect(releaseRoots(first)).toEqual([first.rootPath]);
  });

  it("does not restore over a pointer that changed to foreign bytes during publish", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const foreignPointer = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        packageName: PACKAGE_NAME,
        rootPath: path.join(fixture.root, "foreign-during-publish"),
        receiptSha256: "f".repeat(64),
      })}\n`,
    );
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync");
    let mutated = false;
    renameSpy.mockImplementation((oldPath, newPath) => {
      const result = originalRename(oldPath, newPath);
      if (
        !mutated &&
        String(oldPath).includes(".pending-") &&
        path.basename(String(newPath)).startsWith("release-")
      ) {
        fs.writeFileSync(pointerBefore.path, foreignPointer, { mode: 0o600 });
        mutated = true;
      }
      return result;
    });

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/active browser pointer changed/i);
    expect(fs.readFileSync(pointerBefore.path)).toEqual(foreignPointer);
  });

  it("preserves the active-pointer backup when publish and restore both fail", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const packageDir = path.dirname(first.rootPath);
    const originalLink = fs.linkSync;
    const linkSpy = vi.spyOn(fs, "linkSync");
    linkSpy.mockImplementation((sourcePath, destinationPath) => {
      const source = String(sourcePath);
      const destination = String(destinationPath);
      if (
        destination === pointerBefore.path &&
        source.includes(".active-") &&
        source.endsWith(".tmp")
      ) {
        throw new Error("simulated active pointer publish failure");
      }
      if (
        destination === pointerBefore.path &&
        source.includes(".active-backup-") &&
        source.endsWith(".restore-pointer")
      ) {
        throw new Error("simulated active pointer restore failure");
      }
      return originalLink(sourcePath, destinationPath);
    });

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/rollback incomplete/i);
    const backupDirectories = fs
      .readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".active-backup-"))
      .map((entry) => path.join(packageDir, entry.name));
    expect(backupDirectories).toHaveLength(1);
    const backupDirectory = backupDirectories[0]!;
    expect(fs.readFileSync(path.join(backupDirectory, "retired-pointer"))).toEqual(pointerBefore.raw);
    expect(fs.readFileSync(`${backupDirectory}.json`)).toEqual(pointerBefore.raw);
    expect(fs.readFileSync(path.join(backupDirectory, ".restore-pointer"))).toEqual(pointerBefore.raw);
  });

  it("preserves a foreign release directory when cleanup follows a publish failure", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const candidate = nextCandidate(fixture.input);
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync");
    let foreignMarker: string | null = null;
    let movedOwnedRelease: string | null = null;
    renameSpy.mockImplementation((oldPath, newPath) => {
      const source = String(oldPath);
      const destination = String(newPath);
      if (foreignMarker !== null && path.basename(destination) === "receipt.json" && source.includes(".receipt-")) {
        throw new Error("simulated receipt publish failure");
      }
      const result = originalRename(oldPath, newPath);
      if (
        movedOwnedRelease === null &&
        source.includes(".pending-") &&
        path.basename(destination).startsWith("release-")
      ) {
        movedOwnedRelease = path.join(fixture.root, "owned-release-preserved");
        originalRename(destination, movedOwnedRelease);
        fs.mkdirSync(destination, { mode: 0o700 });
        foreignMarker = path.join(destination, "foreign-replacement.marker");
        fs.writeFileSync(foreignMarker, "foreign release must survive cleanup\n", { mode: 0o600 });
      }
      return result;
    });

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/cannot publish managed receipt|receipt publish failure/i);
    expect(foreignMarker).not.toBeNull();
    expect(fs.readFileSync(foreignMarker!, "utf8")).toBe("foreign release must survive cleanup\n");
    expect(movedOwnedRelease).not.toBeNull();
  });

  it("preserves a foreign pointer and the prior backup when it appears after retiring the old inode", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const foreignPointer = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        packageName: PACKAGE_NAME,
        rootPath: path.join(fixture.root, "foreign-after-unlink"),
        receiptSha256: "e".repeat(64),
      })}\n`,
    );
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync");
    let injected = false;
    renameSpy.mockImplementation((oldPath, newPath) => {
      const source = String(oldPath);
      const destination = String(newPath);
      const result = originalRename(oldPath, newPath);
      if (
        !injected &&
        path.resolve(source) === path.resolve(pointerBefore.path) &&
        path.basename(destination) === "retired-pointer"
      ) {
        fs.writeFileSync(pointerBefore.path, foreignPointer, { mode: 0o600 });
        injected = true;
      }
      return result;
    });

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/foreign active pointer preserved|backup retained/i);
    expect(fs.readFileSync(pointerBefore.path)).toEqual(foreignPointer);
    expect(injected).toBe(true);
    const backupDirectories = fs
      .readdirSync(path.dirname(first.rootPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".active-backup-"))
      .map((entry) => path.join(path.dirname(first.rootPath), entry.name));
    expect(backupDirectories).toHaveLength(1);
    const backupDirectory = backupDirectories[0]!;
    expect(fs.readFileSync(path.join(backupDirectory, "retired-pointer"))).toEqual(pointerBefore.raw);
    expect(fs.readFileSync(`${backupDirectory}.json`)).toEqual(pointerBefore.raw);
  });

  it("preserves a foreign backup addition after publishing the new active pointer", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const packageDir = path.dirname(first.rootPath);
    const originalLink = fs.linkSync;
    const linkSpy = vi.spyOn(fs, "linkSync");
    let backupDirectory: string | null = null;
    let foreignMarker: string | null = null;
    let injected = false;
    linkSpy.mockImplementation((sourcePath, destinationPath) => {
      const source = String(sourcePath);
      const destination = String(destinationPath);
      const result = originalLink(sourcePath, destinationPath);
      if (
        !injected &&
        destination === pointerBefore.path &&
        source.includes(".active-") &&
        source.endsWith(".tmp")
      ) {
        const entry = fs
          .readdirSync(packageDir, { withFileTypes: true })
          .find((candidateEntry) => candidateEntry.isDirectory() && candidateEntry.name.startsWith(".active-backup-"));
        expect(entry).toBeDefined();
        backupDirectory = path.join(packageDir, entry!.name);
        foreignMarker = path.join(backupDirectory, "foreign-backup.marker");
        fs.writeFileSync(foreignMarker, "foreign backup content\n", { mode: 0o600 });
        injected = true;
      }
      return result;
    });

    const second = await activateManagedBrowserTree(candidate);

    expect(injected).toBe(true);
    expect(second.rootPath).not.toBe(first.rootPath);
    const active = readActivePointer(second);
    expect(active.value.rootPath).toBe(second.rootPath);
    expect(foreignMarker).not.toBeNull();
    expect(fs.readFileSync(foreignMarker!, "utf8")).toBe("foreign backup content\n");
    expect(fs.readFileSync(path.join(backupDirectory!, "retired-pointer"))).toEqual(pointerBefore.raw);
    expect(fs.readFileSync(`${backupDirectory}.json`)).toEqual(pointerBefore.raw);
  });

  it("rejects a foreign pointer replacement immediately before retiring the old pointer", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const packageDir = path.dirname(first.rootPath);
    const displacedOldPointer = path.join(fixture.root, "displaced-old-pointer.json");
    const foreignPointer = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        packageName: PACKAGE_NAME,
        rootPath: path.join(fixture.root, "foreign-retirement-release"),
        receiptSha256: "d".repeat(64),
      })}\n`,
    );
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync");
    const originalUnlink = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");
    let injected = false;
    const injectForeignBeforeRetirement = (): void => {
      if (injected) return;
      originalRename(pointerBefore.path, displacedOldPointer);
      fs.writeFileSync(pointerBefore.path, foreignPointer, { mode: 0o600 });
      injected = true;
    };
    renameSpy.mockImplementation((sourcePath, destinationPath) => {
      if (!injected && path.resolve(String(sourcePath)) === path.resolve(pointerBefore.path)) {
        injectForeignBeforeRetirement();
      }
      return originalRename(sourcePath, destinationPath);
    });
    unlinkSpy.mockImplementation((file) => {
      if (!injected && path.resolve(String(file)) === path.resolve(pointerBefore.path)) {
        injectForeignBeforeRetirement();
      }
      return originalUnlink(file);
    });

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/pointer|foreign|changed|backup|ownership/i);
    expect(injected).toBe(true);

    const foreignLocations: string[] = [];
    if (fs.existsSync(pointerBefore.path)) {
      try {
        if (fs.readFileSync(pointerBefore.path).equals(foreignPointer)) foreignLocations.push(pointerBefore.path);
      } catch {
        // The pointer may have been surfaced under a private backup instead.
      }
    }
    for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(packageDir, entry.name);
      if (fs.readFileSync(file).equals(foreignPointer)) foreignLocations.push(file);
    }
    expect(foreignLocations.length).toBeGreaterThan(0);
  });

  it("keeps the pointer backup when restore-temp creation fails after unlink", async () => {
    const fixture = writeFixture();
    const first = await activateManagedBrowserTree(fixture.input);
    const pointerBefore = assertActivePointer(first, fixture);
    const candidate = nextCandidate(fixture.input);
    const originalLink = fs.linkSync;
    const linkSpy = vi.spyOn(fs, "linkSync");
    linkSpy.mockImplementation((sourcePath, destinationPath) => {
      const source = String(sourcePath);
      const destination = String(destinationPath);
      if (
        destination === pointerBefore.path &&
        source.includes(".active-") &&
        source.endsWith(".tmp")
      ) {
        throw new Error("simulated active pointer publish failure");
      }
      return originalLink(sourcePath, destinationPath);
    });
    const originalWriteFile = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    writeSpy.mockImplementation(((file: unknown, content: unknown, options: unknown) => {
      if (typeof file === "string" && file.includes(".restore")) {
        const error = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
      return originalWriteFile(file as string, content as string, options as never);
    }) as typeof fs.writeFileSync);

    await expect(activateManagedBrowserTree(candidate)).rejects.toThrow(/restore|rollback|ENOSPC/i);
    expect(fs.existsSync(pointerBefore.path)).toBe(false);
    const backups = fs
      .readdirSync(path.dirname(first.rootPath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(".active-backup-") && entry.name.endsWith(".json"))
      .map((entry) => path.join(path.dirname(first.rootPath), entry.name));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(backups[0]!)).toEqual(pointerBefore.raw);
  });

  it("does not unlink a foreign lock replacement made after the lock fd closes", async () => {
    const fixture = writeFixture();
    const lockPath = path.join(
      fixture.stateDir,
      ".browser-managed",
      "playwright-cli",
      ".activation.lock",
    );
    const foreignLock = Buffer.from("foreign lock owner\n");
    const originalLstat = fs.lstatSync;
    const lstatSpy = vi.spyOn(fs, "lstatSync");
    let replaced = false;
    lstatSpy.mockImplementation(((file: unknown, options: unknown) => {
      const observed = Reflect.apply(originalLstat, fs, [file, options]) as fs.Stats;
      if (!replaced && path.resolve(String(file)) === path.resolve(lockPath)) {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, foreignLock, { mode: 0o600 });
        replaced = true;
      }
      return observed;
    }) as typeof fs.lstatSync);

    await activateManagedBrowserTree(fixture.input);

    expect(replaced).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath)).toEqual(foreignLock);
  });

  it("accepts a prerelease transitive closure member from the verified stage", async () => {
    const fixture = writeFixture();
    const prerelease = "9.9.11-alpha.1";
    const rootManifestPath = path.join(fixture.input.staged.treePath, "package.json");
    const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, "utf8")) as Record<string, unknown>;
    const rootDependencies = rootManifest.dependencies as Record<string, unknown>;
    rootDependencies[TRANSITIVE_NAME] = prerelease;
    fs.writeFileSync(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);

    const rootVirtualManifestPath = path.join(
      fixture.input.staged.nodeModulesPath,
      ".pnpm",
      `${PACKAGE_NAME.replace("/", "+")}@${VERSION}`,
      "node_modules",
      "@playwright",
      "cli",
      "package.json",
    );
    const rootVirtualManifest = JSON.parse(fs.readFileSync(rootVirtualManifestPath, "utf8")) as Record<string, unknown>;
    rootVirtualManifest.dependencies = { [TRANSITIVE_NAME]: prerelease };
    fs.writeFileSync(rootVirtualManifestPath, `${JSON.stringify(rootVirtualManifest, null, 2)}\n`);

    const previousTransitiveVirtual = path.join(
      fixture.input.staged.nodeModulesPath,
      ".pnpm",
      `${TRANSITIVE_NAME}@${TRANSITIVE_VERSION}`,
    );
    const prereleaseTransitiveVirtual = path.join(
      fixture.input.staged.nodeModulesPath,
      ".pnpm",
      `${TRANSITIVE_NAME}@${prerelease}`,
    );
    fs.renameSync(previousTransitiveVirtual, prereleaseTransitiveVirtual);
    const transitiveManifestPath = path.join(
      prereleaseTransitiveVirtual,
      "node_modules",
      TRANSITIVE_NAME,
      "package.json",
    );
    fs.writeFileSync(
      transitiveManifestPath,
      `${JSON.stringify({ name: TRANSITIVE_NAME, version: prerelease })}\n`,
    );

    const staged = {
      ...fixture.input.staged,
      treeSha256: browserTreeSha256(
        fixture.input.staged.nodeModulesPath,
        path.dirname(fixture.input.staged.nodeModulesPath),
      ),
      closure: fixture.input.staged.closure.map((entry) =>
        entry.name === TRANSITIVE_NAME ? { ...entry, version: prerelease } : entry,
      ),
    };

    const receipt = await activateManagedBrowserTree({ ...fixture.input, staged });

    expect(receipt.closure).toEqual(
      expect.arrayContaining([
        { name: TRANSITIVE_NAME, version: prerelease, integrity: TRANSITIVE_INTEGRITY },
      ]),
    );
  });

  it("rejects staged tree drift before promotion and leaves no receipt", async () => {
    const fixture = writeFixture();
    fs.appendFileSync(fixture.input.entryPath, "drift before promotion\n");

    await expect(activateManagedBrowserTree(fixture.input)).rejects.toThrow(/tree|digest|drift/i);
    expect(readManagedReceipts(fixture.stateDir)).toHaveLength(0);
    expect(fs.readFileSync(fixture.foreignMarker, "utf8")).toBe("foreign installation must remain untouched\n");
  });
});
