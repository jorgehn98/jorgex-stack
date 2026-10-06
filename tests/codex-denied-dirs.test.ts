import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runDoctor } from "../src/doctor.js";
import { codexAdapter } from "../src/adapters/codex.js";
import * as detection from "../src/lib/detect.js";
import { expectedEngramAssetName } from "../src/lib/github.js";

// Synthetic HOME: the denied directories are resolved under it, never under the real one.
const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/paths.js", async (original) => ({
  ...await original<typeof import("../src/lib/paths.js")>(),
  get HOME() { return isolated.root; },
  dataDir: () => path.join(isolated.root, ".jorgex-stack"),
}));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@clack/prompts", () => ({ log: logs }));

let root: string;
let configDir: string;
const ssh = () => path.join(root, ".ssh");
const aws = () => path.join(root, ".aws");
const mode = (dir: string) => fs.statSync(dir).mode & 0o777;
const warnings = () => logs.warn.mock.calls.flat().join("\n");
const detect = () => ({ id: "codex" as const, name: "Codex", installed: true, binPath: "/fake/codex", configDir });
const realInstall = (extra: { dryRun?: boolean } = {}) => runInstall({
  runtimes: ["codex"], dryRun: false, yes: true, engramBin: "/fake/engram", execute: () => "", verifyEngram: async () => true, detect, ...extra,
});

beforeEach(() => {
  root = fs.mkdtempSync("/var/tmp/jx-codex-denied-dirs-"); isolated.root = root;
  configDir = path.join(root, ".codex");
  vi.clearAllMocks();
  vi.spyOn(detection, "engramVersion").mockReturnValue("3.0.0");
  const name = expectedEngramAssetName("3.0.0", process.platform, process.arch);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tag_name: "v3.0.0", assets: [{
    name, state: "uploaded", size: 1, digest: `sha256:${"0".repeat(64)}`,
    browser_download_url: `https://github.com/Gentleman-Programming/engram/releases/download/v3.0.0/${name}`,
  }] }))));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("creates the missing denied directories with mode 700 when a real install seeds the fresh profile", async () => {
  expect(await realInstall()).toBe(0);
  expect(fs.readFileSync(path.join(configDir, "config.toml"), "utf8")).toContain('"~/.aws" = "deny"');
  expect(mode(ssh())).toBe(0o700);
  expect(mode(aws())).toBe(0o700);
});

it("leaves an existing denied directory and its permissions untouched", async () => {
  fs.mkdirSync(ssh(), { mode: 0o755 });
  fs.chmodSync(ssh(), 0o755);
  fs.writeFileSync(path.join(ssh(), "known_hosts"), "kept");
  expect(await realInstall()).toBe(0);
  expect(mode(ssh())).toBe(0o755);
  expect(fs.readFileSync(path.join(ssh(), "known_hosts"), "utf8")).toBe("kept");
  expect(mode(aws())).toBe(0o700);
});

it("does not create directories on dry-run", async () => {
  expect(await realInstall({ dryRun: true })).toBe(0);
  expect(fs.existsSync(ssh())).toBe(false);
  expect(fs.existsSync(aws())).toBe(false);
});

it("does not create directories with --target-dir", async () => {
  expect(await runInstall({ runtimes: ["codex"], targetDir: root, dryRun: false, yes: true })).toBe(0);
  expect(fs.readFileSync(path.join(root, "codex", "config.toml"), "utf8")).toContain('"~/.aws" = "deny"');
  expect(fs.existsSync(ssh())).toBe(false);
  expect(fs.existsSync(aws())).toBe(false);
});

it("does not create directories when an existing configuration is preserved without seeding", async () => {
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "config.toml"), 'other = "value"\n');
  expect(await realInstall()).toBe(0);
  expect(fs.readFileSync(path.join(configDir, "config.toml"), "utf8")).not.toContain("jorgex-yolo");
  expect(fs.existsSync(ssh())).toBe(false);
  expect(fs.existsSync(aws())).toBe(false);
});

it("doctor reports an active profile denying a missing directory, with the concrete remedy, and repairs nothing", async () => {
  expect(await realInstall()).toBe(0);
  vi.spyOn(codexAdapter, "detect").mockImplementation(detect);
  vi.clearAllMocks();
  await runDoctor({ runtimes: ["codex"] });
  expect(warnings()).not.toContain("mkdir -m 700");

  fs.rmdirSync(aws());
  await runDoctor({ runtimes: ["codex"] });
  expect(warnings()).toContain("mkdir -m 700 ~/.aws");
  expect(warnings()).not.toContain("mkdir -m 700 ~/.ssh");
  expect(fs.existsSync(aws())).toBe(false);
});

it("doctor stays silent when the active profile is not jorgex-yolo", async () => {
  expect(await realInstall()).toBe(0);
  const file = path.join(configDir, "config.toml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('default_permissions = "jorgex-yolo"', 'default_permissions = "personal"'));
  fs.rmdirSync(aws());
  vi.spyOn(codexAdapter, "detect").mockImplementation(detect);
  vi.clearAllMocks();
  await runDoctor({ runtimes: ["codex"] });
  expect(warnings()).not.toContain("mkdir -m 700");
});
