import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { readManifest } from "../src/lib/manifest.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-native-opencode-"); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const install = () => runInstall({ runtimes: ["opencode"], targetDir: root, opencodeTargetMajor: 2, yes: true, dryRun: false });

it("records only created v2 fields and preserves user models and permissions on repeated projection", async () => {
  const configDir = path.join(root, "opencode");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "opencode.json"), '{"model":"personal/model","permissions":[{"effect":"deny","action":"shell","resource":"*"}]}');
  expect(await install()).toBe(0);
  const row = readManifest(path.join(root, ".jorgex-stack", "manifest.json")).runtimes.opencode!;
  expect(row.configOwned).not.toContain('["opencode.json","model"]');
  expect(row.configOwned).toContain('["cli.json","plugins","./tui/subagents"]');
  const before = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");
  expect(await install()).toBe(0);
  expect(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).toBe(before);
  expect(before).toContain("personal/model");
  expect(JSON.parse(before).permissions).toEqual([{ effect: "deny", action: "shell", resource: "*" }]);
  expect(await runUninstall({ runtimes: ["opencode"], targetDir: root, dryRun: false, yes: true, removeEngram: false })).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).model).toBe("personal/model");
});

it("shares existing Stack-owned skills without rewriting and preserves them when the first consumer leaves", async () => {
  expect(await install()).toBe(0);
  const file = path.join(root, ".jorgex-stack", "manifest.json");
  const shared = readManifest(file).runtimes.opencode!.owned.filter((file) => file.includes(`${path.sep}.agents${path.sep}skills${path.sep}`));
  const before = shared.map((file) => fs.statSync(file).mtimeMs);
  expect(await runInstall({ runtimes: ["pi"], targetDir: root, yes: true, dryRun: false })).toBe(0);
  expect(readManifest(file).runtimes.pi!.owned).toEqual(expect.arrayContaining(shared));
  expect(shared.map((file) => fs.statSync(file).mtimeMs)).toEqual(before);
  expect(await runUninstall({ runtimes: ["opencode"], targetDir: root, dryRun: false, yes: true, removeEngram: false })).toBe(0);
  expect(shared.every((file) => fs.existsSync(file))).toBe(true);
});

it("requires isolated v2 evidence before any projection", async () => {
  expect(await runInstall({ runtimes: ["opencode"], targetDir: root, opencodeTargetMajor: 1, yes: true, dryRun: false })).toBe(1);
  expect(fs.readdirSync(root)).toEqual([]);
});
