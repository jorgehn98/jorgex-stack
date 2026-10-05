import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { readManifest } from "../src/lib/manifest.js";
import { listBackups, restoreBackup } from "../src/lib/backup.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-pi-subagent-config-"); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const options = () => ({ runtimes: ["pi" as const], targetDir: root, scope: { section: "config" as const }, dryRun: false, yes: true });
const config = () => path.join(root, "pi-agent", "extensions", "subagent", "config.json");
const manifest = () => readManifest(path.join(root, ".jorgex-stack", "manifest.json"));
const field = '["extensions/subagent/config.json","timeoutMs"]';
function seed(content: string) { fs.mkdirSync(path.dirname(config()), { recursive: true }); fs.writeFileSync(config(), content); }

it("seeds a two-hour native default once and removes only its unchanged owned field", async () => {
  expect(await runInstall(options())).toBe(0);
  expect(JSON.parse(fs.readFileSync(config(), "utf8"))).toEqual({ timeoutMs: 7200000 });
  expect(manifest().runtimes.pi!.configOwned).toContain(field);
  const before = fs.readFileSync(config(), "utf8");
  const backups = listBackups(path.join(root, ".jorgex-stack", "backups"));
  expect(await runInstall({ ...options(), command: "update" })).toBe(0);
  expect(fs.readFileSync(config(), "utf8")).toBe(before);
  expect(listBackups(path.join(root, ".jorgex-stack", "backups"))).toEqual(backups);
  seed('{"timeoutMs":7200000,"personal":"keep"}');
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(JSON.parse(fs.readFileSync(config(), "utf8"))).toEqual({ personal: "keep" });
});

it.each([3600000, 7200000, 0, false, null])("preserves existing timeout %s byte-identically without claiming it", async (timeoutMs) => {
  const before = JSON.stringify({ timeoutMs, personal: "keep", waitTool: { defaultTimeoutMs: 12345 } }, null, 2) + "\n";
  seed(before);
  expect(await runInstall(options())).toBe(0);
  expect(manifest().runtimes.pi!.configOwned ?? []).not.toContain(field);
  expect(fs.readFileSync(config(), "utf8")).toBe(before);
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(fs.readFileSync(config(), "utf8")).toBe(before);
});

it("backs up a changed native file, preserves other deadlines and retains a later personal override", async () => {
  const before = '{\n  "waitTool": {"defaultTimeoutMs": 12345},\n  "toolTimeoutMs": 45678,\n  "personal": "keep"\n}\n';
  seed(before);
  expect(await runInstall(options())).toBe(0);
  expect(JSON.parse(fs.readFileSync(config(), "utf8"))).toEqual({ waitTool: { defaultTimeoutMs: 12345 }, toolTimeoutMs: 45678, personal: "keep", timeoutMs: 7200000 });
  const backups = path.join(root, ".jorgex-stack", "backups");
  const saved = listBackups(backups).find((info) => info.files.some((file) => file.original === config()))!;
  expect(saved).toBeDefined();
  expect(restoreBackup(saved.id, backups, root)).toBeGreaterThan(0);
  expect(fs.readFileSync(config(), "utf8")).toBe(before);
  expect(await runInstall(options())).toBe(0);
  const personal = fs.readFileSync(config(), "utf8").replace("7200000", "9000000");
  seed(personal);
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(fs.readFileSync(config(), "utf8")).toBe(personal);
});

it.each(["directory", "malformed", "array"] as const)("fails closed for %s native config without modifying it or other config", async (kind) => {
  fs.mkdirSync(path.dirname(config()), { recursive: true });
  const before = kind === "array" ? "[]" : "invalid private config";
  if (kind === "directory") fs.mkdirSync(config()); else seed(before);
  const mcp = path.join(root, "pi-agent", "mcp.json");
  fs.writeFileSync(mcp, '{"mcpServers":{}}');
  expect(await runInstall(options())).toBe(1);
  expect(fs.readFileSync(mcp, "utf8")).toBe('{"mcpServers":{}}');
  if (kind === "directory") expect(fs.statSync(config()).isDirectory()).toBe(true);
  else expect(fs.readFileSync(config(), "utf8")).toBe(before);
  expect(manifest().runtimes.pi).toBeUndefined();
});

it("fails closed on uninstall when the owned native config becomes unreadable", async () => {
  expect(await runInstall(options())).toBe(0);
  const before = manifest();
  const mcp = path.join(root, "pi-agent", "mcp.json");
  const mcpBefore = fs.readFileSync(mcp, "utf8");
  fs.unlinkSync(config()); fs.mkdirSync(config());
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(1);
  expect(fs.statSync(config()).isDirectory()).toBe(true);
  expect(manifest()).toEqual(before);
  expect(fs.readFileSync(mcp, "utf8")).toBe(mcpBefore);
});
