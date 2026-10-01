import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";
import type { ActivatePiProviderPackagesInput } from "../src/lib/pi-provider-activation.js";
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
