import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTarBin } from "../src/lib/github.js";
import { downloadVerifiedNpmPackageTarball, type NpmPackageRelease } from "../src/lib/npm-provider.js";
import { buildDerivedProviderArtifact, type DerivedProviderArtifactEvidence } from "../src/lib/pi-provider-artifact.js";
import { verifyPiProviderReceipt } from "../src/lib/pi-provider-receipt.js";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";
import type { ActivatePiProviderPackagesInput, PiProviderPackage } from "../src/lib/pi-provider-activation.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-activate-")); roots.push(homeDir);
  const agentDir = path.join(homeDir, ".pi", "agent");
  const modules = path.join(agentDir, "npm", "node_modules");
  const stageDir = path.join(homeDir, "stage-providers-test");
  const settingsJson = JSON.stringify({ quietStartup: false, packages: [{ source: "npm:gentle-engram@0.1.0", skills: [] }, "npm:pi-mcp-adapter@latest", { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] }, "npm:foreign@1.0.0"] });
  const packages = (["gentle-engram", "pi-mcp-adapter"] as const).map(name => {
    const activeRoot = path.join(modules, name); const packageRoot = path.join(stageDir, name, "pi-agent", "npm", "node_modules", name);
    for (const root of [activeRoot, packageRoot]) fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(activeRoot, "package.json"), JSON.stringify({ name, version: "0.1.0", bin: { [name]: "cli.js" } }));
    fs.writeFileSync(path.join(activeRoot, "cli.js"), "old");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name, version: "9.1.0", bin: { [name]: "cli.js" } }));
    fs.writeFileSync(path.join(packageRoot, "cli.js"), "new");
    return { name, version: "9.1.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, packageRoot, treeSha256: inventoryTreeSha256(packageRoot), bins: { [name]: "cli.js" } };
  });
  fs.writeFileSync(path.join(agentDir, "settings.json"), settingsJson);
  fs.mkdirSync(path.join(modules, "foreign")); fs.writeFileSync(path.join(modules, "foreign", "keep"), "foreign bytes");
  const managed = path.join(agentDir, "npm", "jorgex-pi-managed"); fs.mkdirSync(managed);
  fs.mkdirSync(path.join(managed, "release")); fs.writeFileSync(path.join(managed, "release", "keep"), "private bytes");
  fs.symlinkSync(path.relative(modules, path.join(managed, "release")), path.join(modules, "jorgex-pi"), "dir");
  return { homeDir, agentDir, stageDir, packages, settingsJson, modules, managed };
}
async function load() {
  // The filesystem contract is RED until the production updater exists.
  // @ts-ignore
  return await import("../src/lib/pi-provider-activation.js");
}
// Extra entries are user-owned and must survive verbatim.
function nativeSettings(...extra: unknown[]): string {
  return JSON.stringify({ quietStartup: false, packages: [
    { source: "npm:gentle-engram@0.1.0", skills: [] },
    ...extra,
    { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] },
    "npm:foreign@1.0.0",
  ] });
}
// A prepared fresh caller: no gentle/adapter registration, only user-owned entries.
function freshSettings(...entries: unknown[]): string {
  return JSON.stringify({ quietStartup: false, packages: [
    ...entries,
    { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] },
    "npm:foreign@1.0.0",
  ] });
}
it("promotes only two provider roots and sources, preserving private link and foreign npm bytes", async () => {
  const f = fixture(); const api = await load(); const beforePrivate = inventoryTreeSha256(f.managed);
  await api.activatePiProviderPackages({ ...f, verify: async () => {} });
  const settings = JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"));
  expect(settings).toEqual({ quietStartup: false, packages: [{ source: "npm:gentle-engram@9.1.0", skills: [] }, "npm:pi-mcp-adapter@9.1.0", { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] }, "npm:foreign@1.0.0"] });
  expect(fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8")).toBe("foreign bytes");
  expect(fs.lstatSync(path.join(f.modules, "jorgex-pi")).isSymbolicLink()).toBe(true);
  expect(inventoryTreeSha256(f.managed)).toBe(beforePrivate);
  expect(fs.readFileSync(path.join(f.modules, "pi-mcp-adapter", "cli.js"), "utf8")).toBe("new");
});
it("restores both provider roots and settings when post-activation verification fails", async () => {
  const f = fixture(); const api = await load(); const before = inventoryTreeSha256(path.join(f.agentDir, "npm"));
  await expect(api.activatePiProviderPackages({ ...f, verify: async () => { throw new Error("RPC provider failed"); } })).rejects.toThrow(/RPC provider failed/);
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(f.settingsJson);
  expect(inventoryTreeSha256(path.join(f.agentDir, "npm"))).toBe(before);
});
it("honors the existing Pi activation transaction lock before changing provider roots", async () => {
  const f = fixture(); const api = await load(); fs.writeFileSync(path.join(f.managed, "transaction.lock"), "other transaction");
  const before = inventoryTreeSha256(path.join(f.agentDir, "npm"));
  await expect(api.activatePiProviderPackages({ ...f, verify: async () => {} })).rejects.toThrow(/lock|transaction/);
  expect(inventoryTreeSha256(path.join(f.agentDir, "npm"))).toBe(before);
});

it("restores an already promoted provider when the second promotion fails before its rename", async () => {
  const f = fixture(); const api = await load();
  const before = inventoryTreeSha256(path.join(f.agentDir, "npm"));
  const originalRename = fs.renameSync;
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === f.packages[1]!.packageRoot) throw new Error("injected second provider rename failure");
    return originalRename(from, to);
  });
  try {
    await expect(api.activatePiProviderPackages({ ...f, verify: async () => {} })).rejects.toThrow(/injected second provider rename failure/);
  } finally { rename.mockRestore(); }
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(f.settingsJson);
  expect(inventoryTreeSha256(path.join(f.agentDir, "npm"))).toBe(before);
});

it("preserves concurrent provider edits and its recovery marker rather than overwriting them", async () => {
  const f = fixture(); const api = await load();
  const edited = path.join(f.modules, "gentle-engram", "cli.js");
  const promise = api.activatePiProviderPackages({ ...f, verify: async () => {
    fs.writeFileSync(edited, "concurrent user edit");
    throw new Error("verification failed after concurrent edit");
  } });
  await expect(promise).rejects.toMatchObject({ recovery: "incomplete" });
  expect(fs.readFileSync(edited, "utf8")).toBe("concurrent user edit");
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(true);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(true);
});


it("rejects staged provider tree drift before touching active roots or settings", async () => {
  const f = fixture(); const api = await load();
  const before = inventoryTreeSha256(path.join(f.agentDir, "npm"));
  fs.writeFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "candidate modified after verification");
  const verify = vi.fn(async () => {});
  await expect(api.activatePiProviderPackages({ ...f, verify })).rejects.toThrow(/drift|tree|hash/i);
  expect(verify).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(f.settingsJson);
  expect(inventoryTreeSha256(path.join(f.agentDir, "npm"))).toBe(before);
});

it("promotes only the staged gentle provider for explicit native transport, preserving the unregistered adapter, a lookalike entry and private state", async () => {
  const f = fixture(); const api = await load();
  // The active adapter root stays unregistered and must be preserved.
  const adapterActive = path.join(f.modules, "pi-mcp-adapter");
  const binDir = path.join(f.modules, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const adapterWrapper = path.join(binDir, "pi-mcp-adapter");
  fs.symlinkSync(path.relative(binDir, path.join(adapterActive, "cli.js")), adapterWrapper);
  const lookalike = "npm:pi-mcp-adapter-helper@1.0.0";
  const preparedSettings = nativeSettings(lookalike);
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), preparedSettings);
  f.settingsJson = preparedSettings;

  const beforePrivate = inventoryTreeSha256(f.managed);
  const beforePrivateLink = fs.readlinkSync(path.join(f.modules, "jorgex-pi"));
  const beforeAdapterCli = fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8");
  const beforeAdapterManifest = fs.readFileSync(path.join(adapterActive, "package.json"), "utf8");
  const beforeAdapterWrapper = fs.readlinkSync(adapterWrapper);

  const verify = vi.fn(async () => {
    // The real transaction marker must carry the native selected set only.
    const marker = JSON.parse(fs.readFileSync(path.join(f.managed, "active-transaction.json"), "utf8"));
    expect(marker.packages).toEqual(["gentle-engram"]);
  });
  const nativeInput: ActivatePiProviderPackagesInput = {
    ...f, packages: [f.packages[0]!], mcpTransport: "native", verify,
  };
  const result = await api.activatePiProviderPackages(nativeInput);

  expect(result).toEqual({ ok: true, changed: true, backupDir: expect.any(String) });
  const settings = JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"));
  expect(settings).toEqual({ quietStartup: false, packages: [
    { source: "npm:gentle-engram@9.1.0", skills: [] },
    lookalike,
    { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] },
    "npm:foreign@1.0.0",
  ] });
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8")).toBe("new");
  expect(fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8")).toBe(beforeAdapterCli);
  expect(fs.readFileSync(path.join(adapterActive, "package.json"), "utf8")).toBe(beforeAdapterManifest);
  expect(fs.readlinkSync(adapterWrapper)).toBe(beforeAdapterWrapper);
  expect(fs.lstatSync(path.join(f.modules, "jorgex-pi")).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(f.modules, "jorgex-pi"))).toBe(beforePrivateLink);
  expect(inventoryTreeSha256(f.managed)).toBe(beforePrivate);
  expect(fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8")).toBe("foreign bytes");
  expect(verify).toHaveBeenCalledTimes(1);
});

it.each([
  ["bare", "npm:pi-mcp-adapter"],
  ["selector", "npm:pi-mcp-adapter@latest"],
  ["unsafe selector", "npm:pi-mcp-adapter@file:foreign"],
] as const)("rejects a native activation whose settings register the protected adapter source (%s) before any effect", async (_label, adapterSource) => {
  const f = fixture();
  f.settingsJson = nativeSettings(adapterSource);
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), f.settingsJson);
  // A rejected run must not create managed state.
  fs.rmSync(f.managed, { recursive: true, force: true });
  const before = {
    settings: fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"),
    active: fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8"),
    staged: fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8"),
    link: fs.readlinkSync(path.join(f.modules, "jorgex-pi")),
    modules: fs.readdirSync(f.modules).sort(),
  };
  const api = await load();
  const verify = vi.fn(async () => {});
  const failure = await api.activatePiProviderPackages({
    ...f, packages: [f.packages[0]!], mcpTransport: "native", verify,
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  // The diagnostic is fixed and generic: it must not echo the raw source or settings JSON.
  expect((failure as Error).message).toBe("pi-provider-activation: settings.json registers the protected pi-mcp-adapter source; manual resolution is required");
  expect((failure as Error).message).not.toContain(adapterSource);
  expect((failure as Error).message).not.toContain("quietStartup");
  expect(verify).not.toHaveBeenCalled();
  expect(fs.existsSync(f.managed)).toBe(false);
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(before.settings);
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8")).toBe(before.active);
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe(before.staged);
  expect(fs.readlinkSync(path.join(f.modules, "jorgex-pi"))).toBe(before.link);
  expect(fs.readdirSync(f.modules).sort()).toEqual(before.modules);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toEqual([]);
});

it("rejects a native provider set that is not exactly gentle-engram before any effect", async () => {
  const api = await load();
  const cases = [
    { label: "adapter-only", select: (f: ReturnType<typeof fixture>) => [f.packages[1]!], message: "native activation requires the gentle-engram provider package" },
    { label: "extra provider", select: (f: ReturnType<typeof fixture>) => [f.packages[0]!, f.packages[1]!], message: "native activation requires exactly the gentle-engram provider package" },
  ];
  for (const row of cases) {
    const f = fixture();
    f.settingsJson = nativeSettings();
    fs.writeFileSync(path.join(f.agentDir, "settings.json"), f.settingsJson);
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      ...f, packages: row.select(f), mcpTransport: "native", verify,
    }).then(() => null, (error: unknown) => error);

    expect(failure, row.label).toBeInstanceOf(Error);
    expect((failure as Error).message, row.label).toBe(`pi-provider-activation: ${row.message}`);
    expect(verify, row.label).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), row.label).toBe(f.settingsJson);
    expect(fs.existsSync(path.join(f.managed, "transaction.lock")), row.label).toBe(false);
    expect(fs.existsSync(path.join(f.managed, "active-transaction.json")), row.label).toBe(false);
  }
});

it("restores the gentle provider and preserves the unregistered adapter when native verification fails", async () => {
  const f = fixture();
  const adapterActive = path.join(f.modules, "pi-mcp-adapter");
  const binDir = path.join(f.modules, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const adapterWrapper = path.join(binDir, "pi-mcp-adapter");
  fs.symlinkSync(path.relative(binDir, path.join(adapterActive, "cli.js")), adapterWrapper);
  f.settingsJson = nativeSettings();
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), f.settingsJson);

  const beforePrivate = inventoryTreeSha256(f.managed);
  const beforePrivateLink = fs.readlinkSync(path.join(f.modules, "jorgex-pi"));
  const beforeAdapterCli = fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8");
  const beforeAdapterWrapper = fs.readlinkSync(adapterWrapper);
  const beforeForeign = fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8");
  const api = await load();
  const failure = await api.activatePiProviderPackages({
    ...f, packages: [f.packages[0]!], mcpTransport: "native",
    verify: async () => { throw new Error("native RPC verification failed"); },
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("native RPC verification failed");
  expect((failure as { recovery?: string }).recovery).toBe("complete");
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(f.settingsJson);
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8")).toBe("old");
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe("new");
  expect(fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8")).toBe(beforeAdapterCli);
  expect(fs.readlinkSync(adapterWrapper)).toBe(beforeAdapterWrapper);
  expect(fs.lstatSync(path.join(f.modules, "jorgex-pi")).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(f.modules, "jorgex-pi"))).toBe(beforePrivateLink);
  expect(inventoryTreeSha256(f.managed)).toBe(beforePrivate);
  expect(fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8")).toBe(beforeForeign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
});

it("rejects an unknown or null native transport before any effect", async () => {
  const api = await load();
  for (const value of ["bogus", null] as const) {
    const f = fixture();
    f.settingsJson = nativeSettings();
    fs.writeFileSync(path.join(f.agentDir, "settings.json"), f.settingsJson);
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      ...f, packages: [f.packages[0]!], mcpTransport: value, verify,
    } as unknown as ActivatePiProviderPackagesInput).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("pi-provider-activation: unknown provider activation transport");
    expect(verify).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(f.settingsJson);
    expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
    expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
  }
});

/**
 * T02 auxiliary safety RED: until the transactional receipt exists, activation
 * must reject a staged derived provider before creating any transaction,
 * backup or promotion. The fixture below builds the real #1567 artifact through
 * the verified npm seam and stages its actual bytes (no own TypeBox), so the
 * rejection cannot pass by an invalid candidate.
 */

const DERIVED_VERSION = "0.1.16";
const REGISTRY_VERSION = "0.1.17";

/**
 * T02 contract: `provenance` is a future field of the staged provider evidence.
 * Production does not declare it yet, so only that new field is bridged here;
 * the missing pre-effect safeguard is the runtime RED.
 */
type DerivedStagedPackage = PiProviderPackage & {
  readonly provenance?: DerivedProviderArtifactEvidence;
};
type StagedCandidate = DerivedStagedPackage & {
  readonly sourceTarball: string;
};

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Representative untouched official gentle-engram manifest (fixture only). */
function derivedOfficialManifest(): Record<string, unknown> {
  return {
    name: "gentle-engram",
    version: DERIVED_VERSION,
    type: "module",
    bin: { "pi-engram": "cli.js" },
    pi: { extensions: ["./index.ts"] },
    dependencies: { typebox: "^1.1.38" },
    peerDependencies: {
      "pi-mcp-adapter": ">=2.5.0",
      "@earendil-works/pi-tui": ">=0.74.0",
      "@earendil-works/pi-coding-agent": "*",
    },
    peerDependenciesMeta: {
      "pi-mcp-adapter": { optional: true },
      "@earendil-works/pi-tui": { optional: true },
    },
  };
}

/** Already-corrected official manifest: registry origin, no derivation needed. */
function correctedOfficialManifest(version: string = REGISTRY_VERSION): Record<string, unknown> {
  return {
    name: "gentle-engram",
    version,
    type: "module",
    bin: { "pi-engram": "cli.js" },
    pi: { extensions: ["./index.ts"] },
    peerDependencies: {
      typebox: "*",
      "pi-mcp-adapter": ">=2.5.0",
      "@earendil-works/pi-tui": ">=0.74.0",
      "@earendil-works/pi-coding-agent": "*",
    },
    peerDependenciesMeta: {
      typebox: { optional: true },
      "pi-mcp-adapter": { optional: true },
      "@earendil-works/pi-tui": { optional: true },
    },
  };
}

function buildGentleTarball(root: string, manifest: Record<string, unknown>, name: string): Buffer {
  const source = path.join(root, name);
  const packageDir = path.join(source, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(packageDir, "cli.js"), Buffer.from(`// gentle-engram ${name} cli fixture\n`));
  fs.writeFileSync(path.join(packageDir, "index.ts"), Buffer.from(`// gentle-engram ${name} extension fixture\nexport {};\n`));
  const archive = path.join(root, `${name}.tgz`);
  execFileSync(resolveTarBin(), ["-czf", archive, "-C", source, "package"], { stdio: "pipe" });
  return fs.readFileSync(archive);
}

function artifactFetch(entries: ReadonlyArray<{ release: NpmPackageRelease; bytes: Buffer }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const entry = entries.find((candidate) => candidate.release.tarballUrl === url);
    if (entry === undefined) throw new Error(`unexpected npm tarball request: ${url}`);
    const bytes = entry.bytes;
    const response = new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch;
}

/** Extract a verified tarball's `package/` payload into the fixed stage root. */
function stageInto(sourceTarball: string, packageRoot: string, extractDir: string): void {
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true, mode: 0o700 });
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  try {
    execFileSync(resolveTarBin(), ["-xzf", sourceTarball, "-C", extractDir], { stdio: "pipe" });
    fs.cpSync(path.join(extractDir, "package"), packageRoot, { recursive: true });
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

async function buildStagedCandidate(
  buildRoot: string,
  stageDir: string,
  kind: "derived" | "registry",
): Promise<StagedCandidate> {
  const version = kind === "derived" ? DERIVED_VERSION : REGISTRY_VERSION;
  const manifest = kind === "derived" ? derivedOfficialManifest() : correctedOfficialManifest();
  const tarballBytes = buildGentleTarball(buildRoot, manifest, `gentle-${kind}`);
  const release: NpmPackageRelease = {
    version,
    tarballUrl: `https://registry.npmjs.org/gentle-engram/-/gentle-engram-${version}.tgz`,
    integrity: sri(tarballBytes),
  };
  const officialDestination = path.join(buildRoot, "downloads", `gentle-engram-${kind}-official.tgz`);
  fs.mkdirSync(path.dirname(officialDestination), { recursive: true, mode: 0o700 });
  const official = await downloadVerifiedNpmPackageTarball(
    "gentle-engram",
    release,
    officialDestination,
    artifactFetch([{ release, bytes: tarballBytes }]),
  );
  const destination = path.join(buildRoot, "derived", `gentle-engram-${kind}.tgz`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const evidence = await buildDerivedProviderArtifact({
    packageName: "gentle-engram",
    release,
    official,
    destination,
  });
  if (evidence.origin !== kind) throw new Error(`expected ${kind} origin, got ${evidence.origin}`);
  const sourceTarball = evidence.origin === "derived" ? evidence.derived.path : official.path;
  const packageRoot = path.join(stageDir, "gentle-engram", "pi-agent", "npm", "node_modules", "gentle-engram");
  stageInto(sourceTarball, packageRoot, path.join(buildRoot, `extract-${kind}`));
  const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  return {
    name: "gentle-engram",
    version,
    integrity: release.integrity,
    packageRoot,
    treeSha256: inventoryTreeSha256(packageRoot),
    bins: manifestOnDisk.bin,
    provenance: evidence,
    sourceTarball,
  };
}

type NativeDerivedFixture = {
  homeDir: string;
  agentDir: string;
  stageDir: string;
  settingsJson: string;
  modules: string;
  managed: string;
  stateDir: string;
  receiptPath: string;
  privateReceiptPath: string;
  projectionReceiptPath: string;
  derivedPackage: StagedCandidate;
  registryPackage: StagedCandidate;
  restage: (pkg: StagedCandidate) => void;
};

async function nativeDerivedFixture(): Promise<NativeDerivedFixture> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-derived-activate-"));
  roots.push(homeDir);
  const agentDir = path.join(homeDir, ".pi", "agent");
  const npmDir = path.join(agentDir, "npm");
  const modules = path.join(npmDir, "node_modules");
  const stageDir = path.join(homeDir, "stage-providers-test");
  const managed = path.join(npmDir, "jorgex-pi-managed");

  // Active gentle root, foreign root, private link and settings.
  const activeRoot = path.join(modules, "gentle-engram");
  fs.mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(activeRoot, "package.json"), `${JSON.stringify({ name: "gentle-engram", version: "0.0.9", bin: { "pi-engram": "cli.js" } })}\n`);
  fs.writeFileSync(path.join(activeRoot, "cli.js"), "old");
  fs.mkdirSync(path.join(modules, "foreign"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(modules, "foreign", "keep"), "foreign bytes");
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(managed, "release"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(managed, "release", "keep"), "private bytes");
  fs.symlinkSync(path.relative(modules, path.join(managed, "release")), path.join(modules, "jorgex-pi"), "dir");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const settingsJson = nativeSettings();
  fs.writeFileSync(path.join(agentDir, "settings.json"), settingsJson);

  // Preexisting private JorgeX Pi receipts must survive provider activation.
  const stateDir = path.join(homeDir, ".jorgex-stack");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const privateReceiptPath = path.join(stateDir, "pi-receipt.json");
  const projectionReceiptPath = path.join(stateDir, "pi-projection-receipt.json");
  fs.writeFileSync(privateReceiptPath, `${JSON.stringify({ schemaVersion: 1, private: "jorgex-pi" })}\n`);
  fs.writeFileSync(projectionReceiptPath, `${JSON.stringify({ schemaVersion: 1, private: "projection" })}\n`);

  // Build the real #1567 derived artifact and the corrected-registry artifact
  // through the verified npm seam. Registry is staged first so the derived
  // candidate is the one left in the stage root for the existing tests.
  const buildRoot = path.join(homeDir, "artifact-build");
  const registryPackage = await buildStagedCandidate(buildRoot, stageDir, "registry");
  const derivedPackage = await buildStagedCandidate(buildRoot, stageDir, "derived");
  const restage = (pkg: StagedCandidate): void => {
    stageInto(pkg.sourceTarball, pkg.packageRoot, fs.mkdtempSync(path.join(buildRoot, "restage-")));
  };

  return {
    homeDir,
    agentDir,
    stageDir,
    settingsJson,
    modules,
    managed,
    stateDir,
    receiptPath: path.join(stateDir, "pi-provider-receipt.json"),
    privateReceiptPath,
    projectionReceiptPath,
    derivedPackage,
    registryPackage,
    restage,
  };
}

it("rejects a staged derived provider before creating any transaction, backup or promotion", async () => {
  const f = await nativeDerivedFixture();
  const api = await load();
  const before = {
    settings: fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"),
    activeManifest: fs.readFileSync(path.join(f.modules, "gentle-engram", "package.json"), "utf8"),
    activeCli: fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8"),
    npmTree: inventoryTreeSha256(path.join(f.agentDir, "npm")),
    managedTree: inventoryTreeSha256(f.managed),
  };
  const verify = vi.fn(async () => {});

  const failure = await api.activatePiProviderPackages({
    homeDir: f.homeDir,
    agentDir: f.agentDir,
    stageDir: f.stageDir,
    settingsJson: f.settingsJson,
    packages: [f.derivedPackage],
    mcpTransport: "native",
    verify,
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String((failure as Error).message)).toMatch(/derived requires transactional receipt/i);
  expect(verify).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toEqual([]);
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(before.settings);
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "package.json"), "utf8")).toBe(before.activeManifest);
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8")).toBe(before.activeCli);
  expect(inventoryTreeSha256(path.join(f.agentDir, "npm"))).toBe(before.npmTree);
  expect(inventoryTreeSha256(f.managed)).toBe(before.managedTree);
  // The staged derived root must remain available for the future receipt flow.
  expect(fs.existsSync(f.derivedPackage.packageRoot)).toBe(true);
});

/**
 * T03 grouped-contract RED: `providerReceiptSnapshot: null` is the explicit
 * opt-in that lets a real derived candidate activate and publish the separate
 * schema1 provider receipt. Production does not declare the field yet, so only
 * that new input is bridged locally; the missing receipt lifecycle is the
 * runtime RED. The receipt is read as raw JSON (no future module import) and
 * the callback must observe the exact bytes left on disk.
 */
type ReceiptActivationInput = ActivatePiProviderPackagesInput & {
  readonly providerReceiptSnapshot?: string | null;
};

it("activates a derived provider under providerReceiptSnapshot null, publishing the schema1 receipt the callback observes", async () => {
  const f = await nativeDerivedFixture();
  const api = await load();
  const stateDir = path.join(f.homeDir, ".jorgex-stack");
  const receiptPath = path.join(stateDir, "pi-provider-receipt.json");
  const privateReceiptPath = path.join(stateDir, "pi-receipt.json");
  const projectionReceiptPath = path.join(stateDir, "pi-projection-receipt.json");

  expect(fs.existsSync(receiptPath)).toBe(false);
  const before = {
    privateReceipt: fs.readFileSync(privateReceiptPath, "utf8"),
    projectionReceipt: fs.readFileSync(projectionReceiptPath, "utf8"),
    managedTree: inventoryTreeSha256(f.managed),
    privateLink: fs.readlinkSync(path.join(f.modules, "jorgex-pi")),
    foreign: fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8"),
  };

  let observed: string | null = null;
  const verify = vi.fn(async () => {
    // The caller's runtime readback may inspect the published receipt.
    observed = fs.readFileSync(receiptPath, "utf8");
  });

  const input: ReceiptActivationInput = {
    homeDir: f.homeDir,
    agentDir: f.agentDir,
    stageDir: f.stageDir,
    settingsJson: f.settingsJson,
    packages: [f.derivedPackage],
    mcpTransport: "native",
    providerReceiptSnapshot: null,
    verify,
  };
  const result = await api.activatePiProviderPackages(input as ActivatePiProviderPackagesInput);

  expect(result).toEqual({ ok: true, changed: true, backupDir: expect.any(String) });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(observed).not.toBeNull();

  const receipt = JSON.parse(observed!) as Record<string, unknown>;
  expect(receipt["schemaVersion"]).toBe(1);
  expect(receipt["agentDir"]).toBe(path.resolve(f.agentDir));
  expect(receipt["mcpTransport"]).toBe("native");
  const providers = receipt["providers"] as Array<Record<string, unknown>>;
  expect(providers.map((entry) => entry["name"])).toEqual(["gentle-engram"]);

  const entry = providers[0]!;
  const activeRoot = path.join(f.modules, "gentle-engram");
  const activeManifestBytes = fs.readFileSync(path.join(activeRoot, "package.json"));
  expect(entry["version"]).toBe(DERIVED_VERSION);
  expect(entry["source"]).toBe(`npm:gentle-engram@${DERIVED_VERSION}`);
  expect(entry["packageRoot"]).toBe("npm/node_modules/gentle-engram");
  // The entry keeps the original registry SRI while the active root holds derived bytes.
  expect(entry["integrity"]).toBe(f.derivedPackage.integrity);
  expect(entry["treeSha256"]).toBe(inventoryTreeSha256(activeRoot));
  expect(entry["manifestSha256"]).toBe(createHash("sha256").update(activeManifestBytes).digest("hex"));
  expect(entry["bins"]).toEqual({ "pi-engram": "cli.js" });

  const provenance = entry["provenance"] as Record<string, unknown>;
  expect(provenance["origin"]).toBe("derived");
  const original = provenance["original"] as Record<string, unknown>;
  expect(original["integrity"]).toBe(f.derivedPackage.provenance?.original.integrity);
  expect(original["sha256"]).toBe(f.derivedPackage.provenance?.original.sha256);
  expect(original["sha512"]).toBe(f.derivedPackage.provenance?.original.sha512);
  expect(original["bytes"]).toBe(f.derivedPackage.provenance?.original.bytes);
  expect(original["manifestSha256"]).toBe(f.derivedPackage.provenance?.original.manifestSha256);
  const derived = provenance["derived"] as Record<string, unknown>;
  expect(derived["integrity"]).toBe(f.derivedPackage.provenance?.derived?.integrity);
  expect(derived["sha256"]).toBe(f.derivedPackage.provenance?.derived?.sha256);
  expect(derived["sha512"]).toBe(f.derivedPackage.provenance?.derived?.sha512);
  expect(derived["bytes"]).toBe(f.derivedPackage.provenance?.derived?.bytes);
  expect(derived["manifestSha256"]).toBe(f.derivedPackage.provenance?.derived?.manifestSha256);
  // No ephemeral stage path is persisted anywhere in the provenance.
  expect(derived["path"]).toBeUndefined();
  expect(JSON.stringify(provenance)).not.toContain(f.stageDir);

  // The callback observed the exact bytes that remain on disk.
  expect(fs.readFileSync(receiptPath, "utf8")).toBe(observed);

  // The separate read-only helper re-verifies the derived receipt offline.
  const offline = verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir });
  expect(offline.kind).toBe("derived");
  expect(offline.receipt?.providers[0]?.manifestSha256).toBe(entry["manifestSha256"]);

  // The registered loader source and version now point at the activated root.
  const settings = JSON.parse(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")) as { packages: unknown[] };
  expect(settings.packages[0]).toEqual({ source: `npm:gentle-engram@${DERIVED_VERSION}`, skills: [] });

  // Preexisting private receipts and foreign/private state stay untouched.
  expect(fs.readFileSync(privateReceiptPath, "utf8")).toBe(before.privateReceipt);
  expect(fs.readFileSync(projectionReceiptPath, "utf8")).toBe(before.projectionReceipt);
  expect(inventoryTreeSha256(f.managed)).toBe(before.managedTree);
  expect(fs.readlinkSync(path.join(f.modules, "jorgex-pi"))).toBe(before.privateLink);
  expect(fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8")).toBe(before.foreign);
});

/* ------------------------------------------------------------------ *
 * T03/T04 grouped lifecycle batch over the real derived/registry
 * candidates built by nativeDerivedFixture (no fake builder return data).
 * ------------------------------------------------------------------ */

type ActivationApi = {
  activatePiProviderPackages: (input: ActivatePiProviderPackagesInput) => Promise<{
    ok: true;
    changed: boolean;
    backupDir: string | null;
  }>;
};

function stableState(f: NativeDerivedFixture): { npmTree: string; settings: string; stateTree: string } {
  return {
    npmTree: inventoryTreeSha256(path.join(f.agentDir, "npm")),
    settings: fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"),
    stateTree: inventoryTreeSha256(f.stateDir),
  };
}

function preEffectDelta(f: NativeDerivedFixture): Record<string, string> {
  return { ...stableState(f), stageEntries: fs.readdirSync(f.stageDir).sort().join(",") };
}

/**
 * A rejected activation must leave no transaction state and no new backup dir.
 * A previous successful change legitimately retains its own backup, so new
 * backups are detected through the stage-entry delta rather than an empty list.
 */
function expectNoTransactionFiles(f: NativeDerivedFixture): void {
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
}

function expectTransactionCleared(f: NativeDerivedFixture): void {
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
}

function settingsBytes(f: NativeDerivedFixture): string {
  return fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8");
}

async function activateDerived(
  api: ActivationApi,
  f: NativeDerivedFixture,
  verify: () => void | Promise<void> = async () => {},
): Promise<void> {
  await api.activatePiProviderPackages({
    homeDir: f.homeDir,
    agentDir: f.agentDir,
    stageDir: f.stageDir,
    settingsJson: f.settingsJson,
    packages: [f.derivedPackage],
    mcpTransport: "native",
    providerReceiptSnapshot: null,
    verify,
  });
}

it("fails before effects when a managed receipt exists and the caller omits providerReceiptSnapshot", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  expect(fs.existsSync(f.receiptPath)).toBe(true);

  // A registry candidate keeps the derived provenance guard out of the way, so
  // the only reason to refuse is the managed receipt the caller must acknowledge.
  f.restage(f.registryPackage);
  const before = preEffectDelta(f);
  const verify = vi.fn(async () => {});

  const failure = await api.activatePiProviderPackages({
    homeDir: f.homeDir,
    agentDir: f.agentDir,
    stageDir: f.stageDir,
    settingsJson: settingsBytes(f),
    packages: [f.registryPackage],
    mcpTransport: "native",
    verify,
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(verify).not.toHaveBeenCalled();
  expect(preEffectDelta(f)).toEqual(before);
  expectNoTransactionFiles(f);
});

it("no-ops a freshly restaged identical candidate with the current receipt snapshot", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  const receiptBytes = fs.readFileSync(f.receiptPath, "utf8");
  const settingsAfter = settingsBytes(f);
  f.restage(f.derivedPackage);
  const before = preEffectDelta(f);
  const verify = vi.fn(async () => {});

  const result = await api.activatePiProviderPackages({
    homeDir: f.homeDir,
    agentDir: f.agentDir,
    stageDir: f.stageDir,
    settingsJson: settingsAfter,
    packages: [f.derivedPackage],
    mcpTransport: "native",
    providerReceiptSnapshot: receiptBytes,
    verify,
  });

  expect(result).toEqual({ ok: true, changed: false, backupDir: null });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(preEffectDelta(f)).toEqual(before);
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(receiptBytes);
  expectNoTransactionFiles(f);
});

it("rejects a stale snapshot or drifted active state before any effect", async () => {
  const api = await load() as ActivationApi;

  {
    // (a) Snapshot does not match the receipt bytes on disk.
    const f = await nativeDerivedFixture();
    await activateDerived(api, f);
    f.restage(f.derivedPackage);
    const before = preEffectDelta(f);
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: settingsBytes(f), packages: [f.derivedPackage], mcpTransport: "native",
      providerReceiptSnapshot: "{}\n", verify,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(verify).not.toHaveBeenCalled();
    expect(preEffectDelta(f)).toEqual(before);
    expectNoTransactionFiles(f);
  }

  {
    // (b) Active tree drifted after publish.
    const f = await nativeDerivedFixture();
    await activateDerived(api, f);
    f.restage(f.derivedPackage);
    const snapshot = fs.readFileSync(f.receiptPath, "utf8");
    fs.writeFileSync(path.join(f.modules, "gentle-engram", "drift.txt"), "drift");
    const before = preEffectDelta(f);
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: settingsBytes(f), packages: [f.derivedPackage], mcpTransport: "native",
      providerReceiptSnapshot: snapshot, verify,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/drift|tree/i);
    expect(verify).not.toHaveBeenCalled();
    expect(preEffectDelta(f)).toEqual(before);
    expectNoTransactionFiles(f);
  }

  {
    // (c) Registered loader source drifted from the receipt.
    const f = await nativeDerivedFixture();
    await activateDerived(api, f);
    f.restage(f.derivedPackage);
    const snapshot = fs.readFileSync(f.receiptPath, "utf8");
    const drifted = settingsBytes(f).replace(`npm:gentle-engram@${DERIVED_VERSION}`, "npm:gentle-engram@0.1.15");
    fs.writeFileSync(path.join(f.agentDir, "settings.json"), drifted);
    const before = preEffectDelta(f);
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: drifted, packages: [f.derivedPackage], mcpTransport: "native",
      providerReceiptSnapshot: snapshot, verify,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/source|settings/i);
    expect(verify).not.toHaveBeenCalled();
    expect(preEffectDelta(f)).toEqual(before);
    expectNoTransactionFiles(f);
  }

  {
    // (d) Receipt replaced by foreign bytes while the snapshot is the old receipt.
    const f = await nativeDerivedFixture();
    await activateDerived(api, f);
    f.restage(f.derivedPackage);
    const snapshot = fs.readFileSync(f.receiptPath, "utf8");
    fs.writeFileSync(f.receiptPath, '{"schemaVersion":1}\n');
    const before = preEffectDelta(f);
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: settingsBytes(f), packages: [f.derivedPackage], mcpTransport: "native",
      providerReceiptSnapshot: snapshot, verify,
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(verify).not.toHaveBeenCalled();
    expect(preEffectDelta(f)).toEqual(before);
    expectNoTransactionFiles(f);
  }
});

it("rejects a persisted derived receipt whose original payload no longer re-derives", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  const receipt = JSON.parse(fs.readFileSync(f.receiptPath, "utf8")) as {
    providers: Array<{ provenance: { original: { manifestBase64: string; manifestSha256: string } } }>;
  };
  // A corrected payload at the same version re-derives to registry, contradicting
  // the persisted derived origin.
  const corrected = Buffer.from(`${JSON.stringify(correctedOfficialManifest(DERIVED_VERSION), null, 2)}\n`);
  const provenance = receipt.providers[0]!.provenance;
  provenance.original.manifestBase64 = corrected.toString("base64");
  provenance.original.manifestSha256 = createHash("sha256").update(corrected).digest("hex");
  fs.writeFileSync(f.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir }))
    .toThrow(/derived|recipe|corrected|manifest/i);
});

it("rolls back roots, settings and the first receipt when verification fails after publishing", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  const before = stableState(f);
  const privateBefore = fs.readFileSync(f.privateReceiptPath, "utf8");

  const failure = await api.activatePiProviderPackages({
    homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
    settingsJson: f.settingsJson, packages: [f.derivedPackage], mcpTransport: "native",
    providerReceiptSnapshot: null,
    verify: async () => { throw new Error("derived RPC verification failed"); },
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("complete");
  expect(stableState(f)).toEqual(before);
  expect(fs.existsSync(f.receiptPath)).toBe(false);
  expect(fs.readFileSync(f.privateReceiptPath, "utf8")).toBe(privateBefore);
  expectTransactionCleared(f);
});

it("restores the previous derived receipt, roots and settings when a registry update fails", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  const derivedReceipt = fs.readFileSync(f.receiptPath, "utf8");
  const settingsAfter = settingsBytes(f);
  const before = stableState(f);
  f.restage(f.registryPackage);

  const failure = await api.activatePiProviderPackages({
    homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
    settingsJson: settingsAfter, packages: [f.registryPackage], mcpTransport: "native",
    providerReceiptSnapshot: derivedReceipt,
    verify: async () => { throw new Error("registry RPC verification failed"); },
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("complete");
  expect(stableState(f)).toEqual(before);
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(derivedReceipt);
  expect(verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir }).kind).toBe("derived");
  expectTransactionCleared(f);
});

it("retires the derived receipt only after a corrected registry activation succeeds", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  const derivedReceipt = fs.readFileSync(f.receiptPath, "utf8");
  const settingsAfter = settingsBytes(f);
  f.restage(f.registryPackage);
  const verify = vi.fn(async () => {});

  const result = await api.activatePiProviderPackages({
    homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
    settingsJson: settingsAfter, packages: [f.registryPackage], mcpTransport: "native",
    providerReceiptSnapshot: derivedReceipt, verify,
  });

  expect(result).toEqual({ ok: true, changed: true, backupDir: expect.any(String) });
  expect(verify).toHaveBeenCalledTimes(1);
  const verification = verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir });
  expect(verification.kind).toBe("registry");
  expect(verification.receipt?.providers[0]?.provenance?.origin).toBe("registry");
  const settings = JSON.parse(settingsBytes(f)) as { packages: unknown[] };
  expect(settings.packages[0]).toEqual({ source: `npm:gentle-engram@${REGISTRY_VERSION}`, skills: [] });
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8"))
    .toBe("// gentle-engram gentle-registry cli fixture\n");
});

it("preserves foreign receipt content and reports incomplete recovery when the callback alters it", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  const foreign = '{"schemaVersion":1,"foreign":"edited-by-concurrent-process"}\n';

  const failure = await api.activatePiProviderPackages({
    homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
    settingsJson: f.settingsJson, packages: [f.derivedPackage], mcpTransport: "native",
    providerReceiptSnapshot: null,
    verify: async () => {
      fs.writeFileSync(f.receiptPath, foreign);
      throw new Error("RPC failed after concurrent receipt edit");
    },
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("incomplete");
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(foreign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(true);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(true);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toHaveLength(1);
});

/* ------------------------------------------------------------------ *
 * Concurrent-receipt races at the publish and rollback FS seams.
 * Each case injects real foreign bytes through a public fs hook so the
 * no-replace/compare-expected guard is exercised on the actual write,
 * not simulated. The recovery marker and backup are asserted to survive.
 * ------------------------------------------------------------------ */

function providerBackups(f: NativeDerivedFixture): string[] {
  return fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"));
}

it("publishes the first receipt through a no-replace hardlink, preserving a foreign file that races the commit", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  const foreign = '{"schemaVersion":1,"foreign":"raced-first-publish"}\n';
  const originalLinkSync = fs.linkSync;
  // The foreign file lands between the absence recheck and the hardlink, so the
  // link itself must refuse to overwrite it (EEXIST), never replace it.
  const link = vi.spyOn(fs, "linkSync").mockImplementation((existing, newPath) => {
    if (String(newPath) === f.receiptPath) fs.writeFileSync(f.receiptPath, foreign);
    return originalLinkSync(existing, newPath);
  });
  const verify = vi.fn(async () => {});
  let failure: unknown;
  try {
    failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: f.settingsJson, packages: [f.derivedPackage], mcpTransport: "native",
      providerReceiptSnapshot: null, verify,
    }).then(() => null, (error: unknown) => error);
  } finally {
    link.mockRestore();
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("incomplete");
  expect(verify).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(foreign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(true);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(true);
  expect(providerBackups(f)).toHaveLength(1);
});

it("refuses to replace an existing receipt that drifted after root promotion, preserving the foreign bytes and the recovery marker", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  const settingsAfter = settingsBytes(f);
  const snapshot = fs.readFileSync(f.receiptPath, "utf8");
  const backupsBefore = providerBackups(f).length;
  f.restage(f.registryPackage);
  const foreign = '{"schemaVersion":1,"foreign":"raced-replace"}\n';
  const originalRename = fs.renameSync;
  // The foreign receipt appears while the candidate root is promoted, after the
  // lock recheck but before the receipt publish; the post-fsync comparison must
  // still see it and abort instead of renaming over it.
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === f.registryPackage.packageRoot) fs.writeFileSync(f.receiptPath, foreign);
    return originalRename(from, to);
  });
  const verify = vi.fn(async () => {});
  let failure: unknown;
  try {
    failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: settingsAfter, packages: [f.registryPackage], mcpTransport: "native",
      providerReceiptSnapshot: snapshot, verify,
    }).then(() => null, (error: unknown) => error);
  } finally {
    rename.mockRestore();
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("incomplete");
  expect(verify).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(foreign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(true);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(true);
  expect(providerBackups(f)).toHaveLength(backupsBefore + 1);
});

it("does not remove a foreign receipt that replaces its own during rollback of a first receipt", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  const foreign = '{"schemaVersion":1,"foreign":"raced-rollback-removal"}\n';
  const originalRename = fs.renameSync;
  let inject = false;
  // The foreign receipt lands while the promoted root is restored, after the
  // early rollback validation but before the receipt removal; the recheck at
  // restore time must keep it instead of unlinking it.
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (inject) {
      inject = false;
      fs.writeFileSync(f.receiptPath, foreign);
    }
    return originalRename(from, to);
  });
  const verify = vi.fn(async () => {
    inject = true;
    throw new Error("derived RPC verification failed");
  });
  let failure: unknown;
  try {
    failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: f.settingsJson, packages: [f.derivedPackage], mcpTransport: "native",
      providerReceiptSnapshot: null, verify,
    }).then(() => null, (error: unknown) => error);
  } finally {
    rename.mockRestore();
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("incomplete");
  expect(verify).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(foreign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(true);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(true);
  expect(providerBackups(f)).toHaveLength(1);
});

it("does not overwrite a foreign receipt that replaces its own while the rollback restore is being written", async () => {
  const f = await nativeDerivedFixture();
  const api = await load() as ActivationApi;
  await activateDerived(api, f);
  const settingsAfter = settingsBytes(f);
  const snapshot = fs.readFileSync(f.receiptPath, "utf8");
  const backupsBefore = providerBackups(f).length;
  f.restage(f.registryPackage);
  const foreign = '{"schemaVersion":1,"foreign":"raced-rollback-replace"}\n';
  const originalFsync = fs.fsyncSync;
  let inject = false;
  let fsyncsAfterFailure = 0;
  // After the failure, the rollback writes settings first and then the receipt
  // restore temp; mutating the target while that second temp is fsynced must be
  // caught by the expected-bytes comparison before the rename.
  const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
    if (inject) {
      fsyncsAfterFailure += 1;
      if (fsyncsAfterFailure === 2) fs.writeFileSync(f.receiptPath, foreign);
    }
    return originalFsync(fd);
  });
  const verify = vi.fn(async () => {
    inject = true;
    throw new Error("registry RPC verification failed");
  });
  let failure: unknown;
  try {
    failure = await api.activatePiProviderPackages({
      homeDir: f.homeDir, agentDir: f.agentDir, stageDir: f.stageDir,
      settingsJson: settingsAfter, packages: [f.registryPackage], mcpTransport: "native",
      providerReceiptSnapshot: snapshot, verify,
    }).then(() => null, (error: unknown) => error);
  } finally {
    fsync.mockRestore();
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as { recovery?: string }).recovery).toBe("incomplete");
  expect(verify).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(f.receiptPath, "utf8")).toBe(foreign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(true);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(true);
  expect(providerBackups(f)).toHaveLength(backupsBefore + 1);
});

it("creates the canonical gentle source and promotes its root for a fresh native install", async () => {
  const f = fixture(); const api = await load();
  const adapterActive = path.join(f.modules, "pi-mcp-adapter");
  const binDir = path.join(f.modules, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const adapterWrapper = path.join(binDir, "pi-mcp-adapter");
  fs.symlinkSync(path.relative(binDir, path.join(adapterActive, "cli.js")), adapterWrapper);

  // A prepared fresh caller has no gentle/adapter registration and no gentle root.
  fs.rmSync(path.join(f.modules, "gentle-engram"), { recursive: true, force: true });
  const preparedSettings = JSON.stringify({ quietStartup: false, packages: [
    { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] },
    "npm:foreign@1.0.0",
  ] });
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), preparedSettings);
  f.settingsJson = preparedSettings;

  const beforePrivate = inventoryTreeSha256(f.managed);
  const beforePrivateLink = fs.readlinkSync(path.join(f.modules, "jorgex-pi"));
  const beforeAdapterCli = fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8");
  const beforeAdapterManifest = fs.readFileSync(path.join(adapterActive, "package.json"), "utf8");
  const beforeAdapterWrapper = fs.readlinkSync(adapterWrapper);

  let readback = "";
  const verify = vi.fn(async () => {
    // Real readback inside the transaction, after the source is published.
    readback = fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8");
    const marker = JSON.parse(fs.readFileSync(path.join(f.managed, "active-transaction.json"), "utf8"));
    expect(marker.packages).toEqual(["gentle-engram"]);
  });
  const freshInput: ActivatePiProviderPackagesInput = {
    ...f, packages: [f.packages[0]!], mcpTransport: "native", registrationPolicy: "create-if-absent", verify,
  };
  const result = await api.activatePiProviderPackages(freshInput);

  expect(result).toEqual({ ok: true, changed: true, backupDir: expect.any(String) });
  expect(readback).not.toBe("");
  expect(JSON.parse(readback)).toEqual({ quietStartup: false, packages: [
    { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] },
    "npm:foreign@1.0.0",
    "npm:gentle-engram@9.1.0",
  ] });
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8")).toBe("new");
  expect(fs.existsSync(f.packages[0]!.packageRoot)).toBe(false);
  expect(fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8")).toBe(beforeAdapterCli);
  expect(fs.readFileSync(path.join(adapterActive, "package.json"), "utf8")).toBe(beforeAdapterManifest);
  expect(fs.readlinkSync(adapterWrapper)).toBe(beforeAdapterWrapper);
  expect(fs.lstatSync(path.join(f.modules, "jorgex-pi")).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(f.modules, "jorgex-pi"))).toBe(beforePrivateLink);
  expect(inventoryTreeSha256(f.managed)).toBe(beforePrivate);
  expect(fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8")).toBe("foreign bytes");
  expect(verify).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
});

it("rejects a fresh native install when an unregistered gentle root already exists, preserving it before any effect", async () => {
  const f = fixture(); const api = await load();
  const settings = freshSettings();
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), settings);
  f.settingsJson = settings;
  const beforeRootCli = fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8");
  const beforeRootManifest = fs.readFileSync(path.join(f.modules, "gentle-engram", "package.json"), "utf8");
  const verify = vi.fn(async () => {});
  const failure = await api.activatePiProviderPackages({
    ...f, packages: [f.packages[0]!], mcpTransport: "native", registrationPolicy: "create-if-absent", verify,
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  // Valid metadata must not be adopted as an update target: the root blocks the fresh path.
  expect((failure as Error).message).toBe("pi-provider-activation: fresh registration requires an absent provider root: gentle-engram");
  expect(verify).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "cli.js"), "utf8")).toBe(beforeRootCli);
  expect(fs.readFileSync(path.join(f.modules, "gentle-engram", "package.json"), "utf8")).toBe(beforeRootManifest);
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(settings);
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe("new");
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toEqual([]);
});

it.each([
  ["canonical", { source: "npm:gentle-engram@0.1.0", skills: [] }, "npm:gentle-engram@0.1.0"],
  ["bare", "npm:gentle-engram", "npm:gentle-engram"],
  ["unsafe selector", "npm:gentle-engram@file:foreign", "npm:gentle-engram@file:foreign"],
] as const)("rejects a fresh native install whose settings already claim gentle-engram (%s) before any effect", async (_label, gentleEntry, rawSource) => {
  const f = fixture();
  fs.rmSync(path.join(f.modules, "gentle-engram"), { recursive: true, force: true });
  const settings = freshSettings(gentleEntry);
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), settings);
  f.settingsJson = settings;
  const api = await load();
  const verify = vi.fn(async () => {});
  const failure = await api.activatePiProviderPackages({
    ...f, packages: [f.packages[0]!], mcpTransport: "native", registrationPolicy: "create-if-absent", verify,
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("pi-provider-activation: settings.json already registers a gentle-engram source; create-if-absent requires an absent registration");
  // The diagnostic is fixed and generic: it must not echo the raw source or settings JSON.
  expect((failure as Error).message).not.toContain(rawSource);
  expect((failure as Error).message).not.toContain("quietStartup");
  expect(verify).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(settings);
  expect(fs.existsSync(path.join(f.modules, "gentle-engram"))).toBe(false);
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe("new");
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toEqual([]);
});

it("rejects unknown or null registration policies and create-if-absent with legacy transport before any effect", async () => {
  const api = await load();
  const cases = [
    { label: "unknown policy", transport: "native" as const, policy: "bogus", message: "unknown provider registration policy" },
    { label: "null policy", transport: "native" as const, policy: null, message: "unknown provider registration policy" },
    { label: "create-if-absent legacy", transport: undefined, policy: "create-if-absent", message: "create-if-absent registration requires native transport" },
  ];
  for (const row of cases) {
    const f = fixture();
    const settings = freshSettings();
    fs.writeFileSync(path.join(f.agentDir, "settings.json"), settings);
    f.settingsJson = settings;
    const verify = vi.fn(async () => {});
    const failure = await api.activatePiProviderPackages({
      ...f,
      packages: row.transport === "native" ? [f.packages[0]!] : f.packages,
      mcpTransport: row.transport,
      registrationPolicy: row.policy,
      verify,
    } as unknown as ActivatePiProviderPackagesInput).then(() => null, (error: unknown) => error);

    expect(failure, row.label).toBeInstanceOf(Error);
    expect((failure as Error).message, row.label).toBe(`pi-provider-activation: ${row.message}`);
    expect(verify, row.label).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), row.label).toBe(settings);
    expect(fs.existsSync(path.join(f.managed, "transaction.lock")), row.label).toBe(false);
    expect(fs.existsSync(path.join(f.managed, "active-transaction.json")), row.label).toBe(false);
  }
});

it("does not seed a gentle registration for the default existing policy when settings and root are absent", async () => {
  const f = fixture(); const api = await load();
  fs.rmSync(path.join(f.modules, "gentle-engram"), { recursive: true, force: true });
  const settings = freshSettings();
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), settings);
  f.settingsJson = settings;
  const verify = vi.fn(async () => {});
  const failure = await api.activatePiProviderPackages({
    ...f, packages: [f.packages[0]!], mcpTransport: "native", verify,
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("pi-provider-activation: settings.json must contain exactly one canonical source for gentle-engram");
  expect(verify).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.modules, "gentle-engram"))).toBe(false);
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(settings);
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe("new");
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toEqual([]);
});

it("returns the freshly created gentle source and root to absence when verification fails, preserving private, foreign and unregistered adapter state", async () => {
  const f = fixture(); const api = await load();
  const adapterActive = path.join(f.modules, "pi-mcp-adapter");
  const binDir = path.join(f.modules, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const adapterWrapper = path.join(binDir, "pi-mcp-adapter");
  fs.symlinkSync(path.relative(binDir, path.join(adapterActive, "cli.js")), adapterWrapper);

  fs.rmSync(path.join(f.modules, "gentle-engram"), { recursive: true, force: true });
  const settings = freshSettings();
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), settings);
  f.settingsJson = settings;

  const beforePrivate = inventoryTreeSha256(f.managed);
  const beforePrivateLink = fs.readlinkSync(path.join(f.modules, "jorgex-pi"));
  const beforeAdapterCli = fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8");
  const beforeAdapterManifest = fs.readFileSync(path.join(adapterActive, "package.json"), "utf8");
  const beforeAdapterWrapper = fs.readlinkSync(adapterWrapper);
  const beforeForeign = fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8");

  const failure = await api.activatePiProviderPackages({
    ...f, packages: [f.packages[0]!], mcpTransport: "native", registrationPolicy: "create-if-absent",
    verify: async () => { throw new Error("fresh native RPC verification failed"); },
  }).then(() => null, (error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("fresh native RPC verification failed");
  expect((failure as { recovery?: string }).recovery).toBe("complete");
  // Both the source and the newly created root must return to their prior absence.
  expect(fs.existsSync(path.join(f.modules, "gentle-engram"))).toBe(false);
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(settings);
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe("new");
  expect(fs.readFileSync(path.join(adapterActive, "cli.js"), "utf8")).toBe(beforeAdapterCli);
  expect(fs.readFileSync(path.join(adapterActive, "package.json"), "utf8")).toBe(beforeAdapterManifest);
  expect(fs.readlinkSync(adapterWrapper)).toBe(beforeAdapterWrapper);
  expect(fs.lstatSync(path.join(f.modules, "jorgex-pi")).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(f.modules, "jorgex-pi"))).toBe(beforePrivateLink);
  expect(inventoryTreeSha256(f.managed)).toBe(beforePrivate);
  expect(fs.readFileSync(path.join(f.modules, "foreign", "keep"), "utf8")).toBe(beforeForeign);
  expect(fs.existsSync(path.join(f.managed, "transaction.lock"))).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
});

it("rejects and preserves a foreign gentle root that appears after the transaction lock but before the fresh absence check", async () => {
  const f = fixture(); const api = await load();
  fs.rmSync(path.join(f.modules, "gentle-engram"), { recursive: true, force: true });
  const settings = freshSettings();
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), settings);
  f.settingsJson = settings;

  const lockPath = path.join(f.managed, "transaction.lock");
  const foreignRoot = path.join(f.modules, "gentle-engram");
  const originalWriteFileSync = fs.writeFileSync;
  // Inject the racing root only while the transaction lock is being created, so
  // the fresh absence re-check under the lock is the code path under test.
  const write = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    originalWriteFileSync(...args);
    if (String(args[0]) === lockPath) {
      fs.mkdirSync(foreignRoot, { recursive: true });
      originalWriteFileSync(path.join(foreignRoot, "package.json"), JSON.stringify({ name: "gentle-engram", version: "0.1.0", bin: { "gentle-engram": "cli.js" } }));
      originalWriteFileSync(path.join(foreignRoot, "cli.js"), "foreign");
      originalWriteFileSync(path.join(foreignRoot, "marker.txt"), "foreign marker");
    }
  });
  let failure: unknown;
  try {
    failure = await api.activatePiProviderPackages({
      ...f, packages: [f.packages[0]!], mcpTransport: "native", registrationPolicy: "create-if-absent", verify: async () => {},
    }).then(() => null, (error: unknown) => error);
  } finally {
    write.mockRestore();
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("pi-provider-activation: fresh provider root appeared before promotion: gentle-engram");
  // The foreign root must survive verbatim: not adopted as existed:true, not promoted over, not backed up.
  expect(fs.readFileSync(path.join(foreignRoot, "cli.js"), "utf8")).toBe("foreign");
  expect(fs.readFileSync(path.join(foreignRoot, "marker.txt"), "utf8")).toBe("foreign marker");
  expect(JSON.parse(fs.readFileSync(path.join(foreignRoot, "package.json"), "utf8"))).toEqual({ name: "gentle-engram", version: "0.1.0", bin: { "gentle-engram": "cli.js" } });
  expect(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8")).toBe(settings);
  expect(fs.readFileSync(path.join(f.packages[0]!.packageRoot, "cli.js"), "utf8")).toBe("new");
  expect(fs.existsSync(lockPath)).toBe(false);
  expect(fs.existsSync(path.join(f.managed, "active-transaction.json"))).toBe(false);
  expect(fs.readdirSync(f.stageDir).filter((name) => name.startsWith(".provider-activation-"))).toEqual([]);
});
