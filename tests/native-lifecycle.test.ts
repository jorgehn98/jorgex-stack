import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { runUpdate } from "../src/update.js";
import { readManifest } from "../src/lib/manifest.js";
import * as detection from "../src/lib/detect.js";
import { expectedEngramAssetName } from "../src/lib/github.js";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/paths.js", async (original) => ({
  ...await original<typeof import("../src/lib/paths.js")>(),
  HOME: "/var/tmp",
  dataDir: () => path.join(isolated.root, ".jorgex-stack"),
}));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync("/var/tmp/jx-native-lifecycle-"); isolated.root = root;
  vi.spyOn(detection, "engramVersion").mockReturnValue("3.0.0");
  const name = expectedEngramAssetName("3.0.0", process.platform, process.arch);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tag_name: "v3.0.0", assets: [{
    name, state: "uploaded", size: 1, digest: `sha256:${"0".repeat(64)}`,
    browser_download_url: `https://github.com/Gentleman-Programming/engram/releases/download/v3.0.0/${name}`,
  }] }))));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("projects Pi twice without acquisition and preserves choices, foreign packages and official host layout", async () => {
  const config = path.join(root, "pi-agent");
  fs.mkdirSync(path.join(config, "install", "releases"), { recursive: true });
  fs.writeFileSync(path.join(config, "settings.json"), '{"packages":["npm:personal"],"defaultModel":"personal"}');
  const execute = vi.fn(() => "");
  const opts = { runtimes: ["pi"] as const, targetDir: root, dryRun: false, yes: true, execute };
  expect(await runInstall({ ...opts, runtimes: [...opts.runtimes] })).toBe(0);
  const agent = path.join(config, "agents", "implementer.md");
  fs.writeFileSync(agent, fs.readFileSync(agent, "utf8").replace("---\n", "---\nmodel: personal\n"));
  expect(await runInstall({ ...opts, runtimes: [...opts.runtimes] })).toBe(0);
  expect(fs.readFileSync(agent, "utf8")).toContain("model: personal");
  expect(fs.readFileSync(path.join(config, "settings.json"), "utf8")).toContain('"npm:personal"');
  expect(fs.existsSync(path.join(config, "install", "releases"))).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  const manifest = readManifest(path.join(root, ".jorgex-stack", "manifest.json"));
  expect(manifest.runtimes.pi?.owned).toContain(agent);
  expect(await runUninstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true, removeEngram: false })).toBe(0);
  expect(fs.existsSync(agent)).toBe(false);
  expect(fs.existsSync(path.join(config, "install", "releases"))).toBe(true);
});

it("uses official unpinned Pi packages and native update, with no setup pi or private runtime", async () => {
  const calls: Array<[string, string[]]> = [];
  const configDir = path.join(root, "pi-agent");
  fs.mkdirSync(path.join(configDir, "install", "releases"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "settings.json"), '{"packages":["npm:jorgex-pi@historical","npm:personal"],"defaultModel":"personal"}');
  const execute = vi.fn((bin: string, args: string[]) => {
    calls.push([bin, args]);
    if (args[0] === "remove") {
      const file = path.join(configDir, "settings.json");
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      settings.packages = settings.packages.filter((source: string) => source !== args[1]);
      fs.writeFileSync(file, JSON.stringify(settings));
    }
    if (args[0] === "install") {
      fs.mkdirSync(configDir, { recursive: true });
      const file = path.join(configDir, "settings.json");
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { packages: [] };
      settings.packages.push(args[1]); fs.writeFileSync(file, JSON.stringify(settings));
    }
    return "";
  });
  const exit = await runInstall({ runtimes: ["pi"], dryRun: false, yes: true, engramBin: "/fake/engram", execute,
    detect: () => ({ id: "pi", name: "Pi", installed: true, binPath: "/fake/pi", configDir }) });
  expect(exit).toBe(0);
  expect(calls.filter(([bin]) => bin === "/fake/pi").map(([, args]) => args)).toEqual([
    ["remove", "npm:jorgex-pi@historical"], ["update", "--all"], ["install", "npm:pi-subagents"], ["install", "npm:@juicesharp/rpiv-ask-user-question"],
    ["install", "npm:pi-web-access"], ["install", "npm:@gotgenes/pi-permission-system"], ["install", "npm:gentle-engram"],
    ["install", "npm:@narumitw/pi-goal"], ["install", "npm:compact-tools"],
  ]);
  expect(calls.some(([bin]) => bin === "/fake/engram")).toBe(false);
  const settings = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
  expect(settings.packages).toContain("npm:personal");
  expect(settings.defaultModel).toBe("personal");
  expect(fs.existsSync(path.join(configDir, "install", "releases"))).toBe(true);
  const mcp = JSON.parse(fs.readFileSync(path.join(configDir, "mcp.json"), "utf8"));
  expect(mcp.mcpServers.engram).toBeUndefined();
  expect(mcp.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
  expect(mcp.mcpServers["browser-control"]).toEqual({ command: "browser-control-mcp", args: [] });
});

it("reports a package failure as partial and retains completed native registrations without global rollback", async () => {
  const calls: string[][] = [];
  const status = vi.fn();
  const execute = (_bin: string, args: string[]) => {
    calls.push(args); if (args[1] === "npm:compact-tools") throw new Error("package unavailable");
    if (args[0] === "install") {
      const file = path.join(root, "pi-agent", "settings.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { packages: [] };
      settings.packages.push(args[1]); fs.writeFileSync(file, JSON.stringify(settings));
    }
    return "";
  };
  expect(await runInstall({ runtimes: ["pi"], dryRun: false, yes: true, engramBin: "/fake/engram", execute, onRuntimeStatus: status,
    detect: () => ({ id: "pi", name: "Pi", installed: true, binPath: "/fake/pi", configDir: path.join(root, "pi-agent") }) })).toBe(1);
  expect(status).toHaveBeenCalledWith("pi", "failed");
  expect(readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes.pi?.packages).toContain("npm:gentle-engram");
  expect(calls.some((args) => args[0] === "remove")).toBe(false);
});

it("does not install an absent runtime or write configuration", async () => {
  const execute = vi.fn(() => "");
  expect(await runInstall({ runtimes: ["pi"], dryRun: false, yes: true, execute,
    detect: () => ({ id: "pi", name: "Pi", installed: false, binPath: null, configDir: path.join(root, "pi-agent") }) })).toBe(1);
  expect(execute).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual([]);
});

it.each(["claude-code", "codex"] as const)("refreshes complete official Engram on %s without adding a browser", async (runtime) => {
  const calls: Array<[string, string[]]> = [];
  const verification = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const execute = (bin: string, args: string[]) => { calls.push([bin, args]); return ""; };
  const configDir = path.join(root, runtime === "codex" ? ".codex" : ".claude");
  expect(await runInstall({ runtimes: [runtime], dryRun: false, yes: true, engramBin: "/fake/engram", execute, verifyEngram: verification,
    detect: () => ({ id: runtime, name: runtime, installed: true, binPath: `/fake/${runtime}`, configDir }) })).toBe(0);
  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(calls.some(([, args]) => args[0] === "export")).toBe(false);
  expect(calls).toContainEqual(["/fake/engram", ["setup", runtime]]);
  expect(calls.some(([, args]) => args.some((arg) => /browser-control/.test(arg)))).toBe(false);
  if (runtime === "claude-code") expect(calls).toContainEqual(["/fake/claude-code", ["plugin", "update", "engram"]]);
  else {
    expect(calls).toContainEqual(["/fake/codex", ["update"]]);
    expect(calls.some(([, args]) => args.includes("@openai/codex@latest"))).toBe(false);
    expect(calls).toContainEqual(["/fake/codex", ["plugin", "marketplace", "upgrade", "engram"]]);
    expect(calls).toContainEqual(["/fake/codex", ["plugin", "add", "engram@engram"]]);
  }
});

it.each(["install", "update"] as const)("%s resolves an outdated Engram but makes no changes when backup/update is declined", async (command) => {
  const bin = path.join(root, "engram"); fs.writeFileSync(bin, "previous binary", { mode: 0o755 });
  vi.mocked(detection.engramVersion).mockReturnValue("1.19.0");
  const execute = vi.fn(() => "");
  const operation = command === "install" ? runInstall : runUpdate;
  expect(await operation({ runtimes: ["codex"], dryRun: false, yes: true, engramBin: bin, backupEngramData: false, execute,
    detect: () => ({ id: "codex", name: "Codex", installed: true, binPath: "/fake/codex", configDir: path.join(root, ".codex") }) })).toBe(1);
  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(fs.readFileSync(bin, "utf8")).toBe("previous binary");
  expect(fs.readdirSync(root)).toEqual(["engram"]);
});

it("update resolves a current Engram without export/download and delegates the host to its native updater", async () => {
  const calls: string[][] = [];
  expect(await runUpdate({ runtimes: ["codex"], dryRun: false, yes: true, engramBin: "/fake/engram", execute: (_bin, args) => { calls.push(args); return ""; },
    verifyEngram: async () => true,
    detect: () => ({ id: "codex", name: "Codex", installed: true, binPath: "/fake/codex", configDir: path.join(root, ".codex") }) })).toBe(0);
  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(calls).toContainEqual(["update"]);
  expect(calls.some((args) => args[0] === "export" || args.includes("@openai/codex@latest"))).toBe(false);
});

it("does not turn an incomplete official setup into MCP-only success", async () => {
  const execute = vi.fn(() => "");
  const status = vi.fn();
  expect(await runInstall({ runtimes: ["codex"], dryRun: false, yes: true, engramBin: "/fake/engram", execute,
    verifyEngram: async () => false, onRuntimeStatus: status,
    detect: () => ({ id: "codex", name: "Codex", installed: true, binPath: "/fake/codex", configDir: path.join(root, ".codex") }) })).toBe(1);
  expect(status).toHaveBeenCalledWith("codex", "failed");
  expect(fs.existsSync(path.join(root, ".codex", "agents"))).toBe(false);
});

it("doctor is read-only and checks the same Pi projection rather than a private receipt", async () => {
  const { runDoctor } = await import("../src/doctor.js");
  expect(await runInstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true })).toBe(0);
  const file = path.join(root, ".jorgex-stack", "manifest.json");
  const before = fs.readFileSync(file, "utf8");
  expect(await runDoctor({ runtimes: ["pi"], targetDir: root })).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(await runInstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true })).toBe(0);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("preserves foreign files even when equal and blocks linked projection ancestors", async () => {
  const configDir = path.join(root, "pi-agent"); fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const foreign = path.join(configDir, "agents", "implementer.md"); fs.writeFileSync(foreign, "personal");
  expect(await runInstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true })).toBe(0);
  expect(fs.readFileSync(foreign, "utf8")).toBe("personal");
  expect(readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes.pi?.owned).not.toContain(foreign);
  const destination = path.join(root, "foreign"); fs.mkdirSync(destination);
  fs.rmSync(path.join(configDir, "agents"), { recursive: true }); fs.symlinkSync(destination, path.join(configDir, "agents"), "dir");
  expect(await runInstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true })).toBe(1);
  expect(fs.readdirSync(destination)).toEqual([]);
});
