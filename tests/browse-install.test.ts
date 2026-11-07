import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { ADAPTERS, runInstall, type NativeExecutor } from "../src/install.js";
import { readManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { runUninstall } from "../src/uninstall.js";
import * as detection from "../src/lib/detect.js";
import { expectedEngramAssetName } from "../src/lib/github.js";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/paths.js", async (original) => ({
  ...await original<typeof import("../src/lib/paths.js")>(),
  HOME: "/var/tmp",
  dataDir: () => path.join(isolated.root, ".jorgex-stack"),
}));

type Runtime = "opencode" | "pi";
const RUNTIMES = ["opencode", "pi"] as const;
let root: string;
let warn: MockInstance<typeof p.log.warn>;
beforeEach(() => {
  root = fs.mkdtempSync("/var/tmp/jx-browse-"); isolated.root = root;
  vi.spyOn(detection, "engramVersion").mockReturnValue("3.0.0");
  vi.spyOn(detection, "opencodeMajorVersion").mockReturnValue(2);
  warn = vi.spyOn(p.log, "warn").mockImplementation(() => {});
  const name = expectedEngramAssetName("3.0.0", process.platform, process.arch);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tag_name: "v3.0.0", assets: [{
    name, state: "uploaded", size: 1, digest: `sha256:${"0".repeat(64)}`,
    browser_download_url: `https://github.com/Gentleman-Programming/engram/releases/download/v3.0.0/${name}`,
  }] }))));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const configDir = (runtime: Runtime) => path.join(root, runtime === "pi" ? "pi-agent" : "opencode");
const mcpFile = (runtime: Runtime) => path.join(configDir(runtime), runtime === "pi" ? "mcp.json" : "opencode.json");
const promptFile = (runtime: Runtime) => path.join(configDir(runtime), "AGENTS.md");
const warnings = () => warn.mock.calls.map(([message]) => String(message)).join("\n");
const manifestRow = (runtime: Runtime) => readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes[runtime];
function serverEntry(runtime: Runtime, name: string): unknown {
  const config = JSON.parse(fs.readFileSync(mcpFile(runtime), "utf8"));
  return (runtime === "pi" ? config.mcpServers : config.mcp?.servers)?.[name];
}
function onPath(resolved: Record<string, string>) {
  vi.spyOn(detection, "lookPath").mockImplementation((command) => resolved[command] ?? null);
}

/** Deliberate apply against an isolated config directory; every native command goes through `execute`. */
async function apply(runtime: Runtime, failing: (bin: string, args: string[]) => boolean = () => false) {
  const calls: Array<[string, string[]]> = [];
  const execute: NativeExecutor = (bin, args) => {
    calls.push([bin, args]);
    if (failing(bin, args)) throw new Error("native command failed");
    if (runtime === "pi" && args[0] === "install") {
      const file = path.join(configDir("pi"), "settings.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { packages: [] };
      (settings.packages ??= []).push(args[1]); fs.writeFileSync(file, JSON.stringify(settings));
    }
    return "";
  };
  const status = vi.fn();
  const exit = await runInstall({ runtimes: [runtime], dryRun: false, yes: true, engramBin: "/fake/engram", execute, onRuntimeStatus: status,
    verifyEngram: async () => true,
    detect: () => ({ id: runtime, name: runtime, installed: true, binPath: `/fake/${runtime}`, configDir: configDir(runtime) }) });
  return { exit, status, pnpmCalls: calls.filter(([bin]) => bin === "/fake/pnpm") };
}

it.each(RUNTIMES)("does not call pnpm when browse already resolves on PATH (%s)", async (runtime) => {
  onPath({ browse: "/fake/npm/bin/browse", pnpm: "/fake/pnpm" });
  const { exit, pnpmCalls } = await apply(runtime);
  expect(exit).toBe(0);
  expect(pnpmCalls).toEqual([]);
  expect(serverEntry(runtime, "browse")).toBeDefined();
  expect(manifestRow(runtime)?.mcpOwned).toContain("browse");
  expect(fs.readFileSync(promptFile(runtime), "utf8")).toContain("browse mcp");
});

it.each(RUNTIMES)("installs through pnpm only when the binary is missing (%s)", async (runtime) => {
  onPath({ pnpm: "/fake/pnpm" });
  const { exit, pnpmCalls } = await apply(runtime);
  expect(exit).toBe(0);
  expect(pnpmCalls).toEqual([["/fake/pnpm", ["add", "@opencode/browse@latest", "--global"]]]);
  expect(serverEntry(runtime, "browse")).toBeDefined();
});

it.each(RUNTIMES.flatMap((runtime) => [[runtime, "pnpm fails"], [runtime, "pnpm is missing"]] as const))(
  "warns with the remedy and completes the projection without the MCP (%s, %s)", async (runtime, cause) => {
    onPath(cause === "pnpm fails" ? { pnpm: "/fake/pnpm" } : {});
    const { exit, status } = await apply(runtime, (bin) => bin === "/fake/pnpm");
    expect(exit).toBe(0);
    expect(status).toHaveBeenCalledWith(runtime, "ok");
    expect(warnings()).toMatch(/Browse/);
    expect(warnings()).toContain("pnpm setup");
    expect(warnings()).toContain("@opencode/browse");
    expect(serverEntry(runtime, "browse")).toBeUndefined();
    expect(manifestRow(runtime)?.mcpOwned).not.toContain("browse");
    expect(fs.existsSync(path.join(root, ".agents", "skills", "lean-code", "SKILL.md"))).toBe(true);
    const prompt = fs.readFileSync(promptFile(runtime), "utf8");
    expect(prompt).toContain("<!-- jorgex:browser -->");
    expect(prompt).not.toContain("browse mcp");
  });

const ABSOLUTE = "/home/user/.local/bin/browse";
const entries: Record<Runtime, { absolute: object; incompatible: object[] }> = {
  opencode: {
    absolute: { type: "local", command: [ABSOLUTE, "mcp"], environment: { DEBUG: "1" } },
    incompatible: [
      { type: "remote", url: "https://browser.invalid/mcp" },
      { type: "local", command: ["browse", "mcp"], disabled: true },
      { type: "local", command: ["/opt/other/launcher", "mcp"] },
    ],
  },
  pi: {
    absolute: { command: ABSOLUTE, args: ["mcp"], env: { DEBUG: "1" } },
    incompatible: [
      { url: "https://browser.invalid/mcp" },
      { command: "browse", args: ["mcp"], disabled: true },
      { command: "/opt/other/launcher", args: ["mcp"] },
    ],
  },
};
function seed(runtime: Runtime, entry: object, name = "browse"): string {
  fs.mkdirSync(configDir(runtime), { recursive: true });
  const servers = { [name]: entry };
  fs.writeFileSync(mcpFile(runtime), `${JSON.stringify(runtime === "pi" ? { mcpServers: servers } : { mcp: { servers } }, null, 2)}\n`);
  // The entry exactly as it sits in the file, indentation included.
  const indent = runtime === "pi" ? "    " : "      ";
  return `"${name}": ${JSON.stringify(entry, null, 2).replace(/\n/g, `\n${indent}`)}`;
}
const target = (runtime: Runtime) => runInstall({ runtimes: [runtime], targetDir: root, opencodeTargetMajor: 2, dryRun: false, yes: true });
function own(runtime: Runtime, mcpOwned: string[]) {
  writeRuntimeManifest(runtime, {
    configDir: configDir(runtime), owned: [], mcpOwned, configOwned: [], packages: [],
    updatedAt: new Date().toISOString(),
  }, path.join(root, ".jorgex-stack", "manifest.json"));
}
const uninstall = (runtime: Runtime) => runUninstall({ runtimes: [runtime], targetDir: root, opencodeTargetMajor: 2, dryRun: false, yes: true, removeEngram: false });
const legacyEntry = (runtime: Runtime) => runtime === "pi"
  ? { command: "browser-control-mcp", args: [] }
  : { type: "local", command: ["browser-control-mcp"] };
const modifiedLegacyEntry = (runtime: Runtime) => runtime === "pi"
  ? { command: "browser-control-mcp", args: [], env: { DEBUG: "1" } }
  : { type: "local", command: ["browser-control-mcp"], environment: { DEBUG: "1" } };
const canonicalBrowse = (runtime: Runtime) => runtime === "pi"
  ? { command: "browse", args: ["mcp"] }
  : { type: "local", command: ["browse", "mcp"] };
const modifiedBrowse = (runtime: Runtime) => runtime === "pi"
  ? { command: "browse", args: ["mcp"], env: { DEBUG: "1" } }
  : { type: "local", command: ["browse", "mcp"], environment: { DEBUG: "1" } };

it.each(RUNTIMES)("keeps a personal absolute-path entry untouched and unclaimed (%s)", async (runtime) => {
  const raw = seed(runtime, entries[runtime].absolute);
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
  expect(await target(runtime)).toBe(0);
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
  expect(manifestRow(runtime)?.mcpOwned).not.toContain("browse");
  expect(warnings()).not.toMatch(/Browse/i);
  expect(fs.readFileSync(promptFile(runtime), "utf8")).toContain("browse mcp");
});

it.each(RUNTIMES.flatMap((runtime) => entries[runtime].incompatible.map((entry) => [runtime, entry] as const)))(
  "keeps an incompatible entry, warns and completes the projection (%s, %j)", async (runtime, entry) => {
    const raw = seed(runtime, entry);
    expect(await target(runtime)).toBe(0);
    expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
    expect(manifestRow(runtime)?.mcpOwned).not.toContain("browse");
    expect(warn.mock.calls.filter(([message]) => /Browse/i.test(String(message)))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".agents", "skills", "lean-code", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(promptFile(runtime), "utf8")).not.toContain("browse mcp");
    expect(await runDoctor({ runtimes: [runtime], targetDir: root, opencodeTargetMajor: 2 })).toBe(0);
  });

it.each(RUNTIMES)("retires a Stack-owned browser-control entry when migrating to browse (%s)", async (runtime) => {
  seed(runtime, legacyEntry(runtime), "browser-control");
  own(runtime, ["browser-control"]);
  expect(await target(runtime)).toBe(0);
  expect(serverEntry(runtime, "browser-control")).toBeUndefined();
  expect(serverEntry(runtime, "browse")).toBeDefined();
  expect(manifestRow(runtime)?.mcpOwned).toContain("browse");
  expect(manifestRow(runtime)?.mcpOwned).not.toContain("browser-control");
});

it.each(RUNTIMES)("keeps a Stack-owned browser-control entry when Browse cannot be installed (%s)", async (runtime) => {
  const raw = seed(runtime, legacyEntry(runtime), "browser-control");
  own(runtime, ["browser-control"]);
  onPath({});
  const { exit, status } = await apply(runtime);
  expect(exit).toBe(0);
  expect(status).toHaveBeenCalledWith(runtime, "ok");
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
  expect(serverEntry(runtime, "browse")).toBeUndefined();
  expect(manifestRow(runtime)?.mcpOwned).toContain("browser-control");
  expect(manifestRow(runtime)?.mcpOwned).not.toContain("browse");
  expect(warnings()).toMatch(/Browse no disponible/);
  expect(warnings()).toContain("browser-control");
});

it.each(RUNTIMES)("keeps a modified Stack-owned browser-control entry but releases ownership (%s)", async (runtime) => {
  const raw = seed(runtime, modifiedLegacyEntry(runtime), "browser-control");
  own(runtime, ["browser-control"]);
  expect(await target(runtime)).toBe(0);
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
  expect(serverEntry(runtime, "browse")).toBeDefined();
  expect(manifestRow(runtime)?.mcpOwned).not.toContain("browser-control");
  expect(warn.mock.calls.filter(([message]) => /browser-control.*personalizado/i.test(String(message)))).toHaveLength(1);
});

it.each(RUNTIMES)("uninstall removes a canonical Stack-owned browse entry (%s)", async (runtime) => {
  seed(runtime, canonicalBrowse(runtime));
  own(runtime, ["browse"]);
  expect(await uninstall(runtime)).toBe(0);
  expect(serverEntry(runtime, "browse")).toBeUndefined();
});

it.each(RUNTIMES)("uninstall preserves a modified browse entry (%s)", async (runtime) => {
  const raw = seed(runtime, modifiedBrowse(runtime));
  own(runtime, ["browse"]);
  expect(await uninstall(runtime)).toBe(0);
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
});

it.each(RUNTIMES)("uninstall removes a canonical browser-control entry from a never-migrated install (%s)", async (runtime) => {
  seed(runtime, legacyEntry(runtime), "browser-control");
  own(runtime, ["browser-control"]);
  expect(await uninstall(runtime)).toBe(0);
  expect(serverEntry(runtime, "browser-control")).toBeUndefined();
});

it.each(RUNTIMES)("uninstall preserves a modified browser-control entry (%s)", async (runtime) => {
  const raw = seed(runtime, modifiedLegacyEntry(runtime), "browser-control");
  own(runtime, ["browser-control"]);
  expect(await uninstall(runtime)).toBe(0);
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
});

it.each(RUNTIMES)("migrates on a later apply once Browse is available (%s)", async (runtime) => {
  const raw = seed(runtime, legacyEntry(runtime), "browser-control");
  own(runtime, ["browser-control"]);
  onPath({});
  expect((await apply(runtime)).exit).toBe(0);
  expect(fs.readFileSync(mcpFile(runtime), "utf8")).toContain(raw);
  expect(manifestRow(runtime)?.mcpOwned).toContain("browser-control");

  onPath({ browse: "/fake/bin/browse", pnpm: "/fake/pnpm" });
  expect((await apply(runtime)).exit).toBe(0);
  expect(serverEntry(runtime, "browser-control")).toBeUndefined();
  expect(serverEntry(runtime, "browse")).toBeDefined();
  expect(manifestRow(runtime)?.mcpOwned).toContain("browse");
  expect(manifestRow(runtime)?.mcpOwned).not.toContain("browser-control");
});

it("doctor accepts the projection applied without Browse instead of failing the unit", async () => {
  onPath({});
  expect((await apply("pi", (bin) => bin === "/fake/pnpm")).exit).toBe(0);
  vi.spyOn(ADAPTERS.pi, "detect").mockReturnValue({ id: "pi", name: "Pi", installed: true, binPath: "/fake/pi", configDir: configDir("pi") });
  vi.spyOn(detection, "detectEngram").mockReturnValue(null);
  const error = vi.spyOn(p.log, "error").mockImplementation(() => {});
  warn.mockClear();
  await runDoctor({ runtimes: ["pi"] });
  expect(warnings()).toMatch(/Browse ausente/);
  expect(error).not.toHaveBeenCalled();
});

it("accepts the canonical name, an absolute path to it and a Windows shim, and nothing that merely resembles it", async () => {
  const { isBrowseCommand } = await import("../src/lib/canonical.js");
  const compatible = (value: unknown) => isBrowseCommand(value, "browse");
  for (const value of ["browse", "/home/user/.local/share/pnpm/browse",
    "C:\\Users\\user\\AppData\\Local\\pnpm\\browse.cmd", "C:/Users/user/AppData/Local/pnpm/browse.CMD", "D:\\tools\\browse.exe"]) expect(compatible(value)).toBe(true);
  for (const value of ["browse.cmd", "other-mcp", "/usr/bin/other-mcp", "relative/browse", "/usr/bin/browse.cmd",
    "C:\\tools\\browse.js", "C:\\tools\\other.cmd", 7, null]) expect(compatible(value)).toBe(false);
});
