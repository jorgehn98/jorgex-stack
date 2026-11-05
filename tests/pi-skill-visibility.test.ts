import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { readManifest } from "../src/lib/manifest.js";
import { listBackups } from "../src/lib/backup.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-pi-skill-visibility-"); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const options = () => ({ runtimes: ["pi" as const], targetDir: root, scope: { section: "config" as const }, dryRun: false, yes: true });
const settings = () => path.join(root, "pi-agent", "settings.json");
const manifest = () => readManifest(path.join(root, ".jorgex-stack", "manifest.json"));
const field = '["settings.json","subagents","agentOverrides","delegate","inheritSkills"]';
const read = () => JSON.parse(fs.readFileSync(settings(), "utf8")) as Record<string, unknown>;
function seed(value: unknown) { fs.mkdirSync(path.dirname(settings()), { recursive: true }); fs.writeFileSync(settings(), JSON.stringify(value)); }

it("enables the built-in subagent skills catalog once, idempotently, and removes only its unchanged leaf", async () => {
  expect(await runInstall(options())).toBe(0);
  expect(read()).toEqual({ subagents: { agentOverrides: { delegate: { inheritSkills: true } } } });
  expect(manifest().runtimes.pi!.configOwned).toContain(field);
  const before = fs.readFileSync(settings(), "utf8");
  const backups = listBackups(path.join(root, ".jorgex-stack", "backups"));
  expect(await runInstall({ ...options(), command: "update" })).toBe(0);
  expect(fs.readFileSync(settings(), "utf8")).toBe(before);
  expect(listBackups(path.join(root, ".jorgex-stack", "backups"))).toEqual(backups);
  seed({ subagents: { agentOverrides: { delegate: { inheritSkills: true } } }, personal: "keep" });
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(read()).toEqual({ personal: "keep" });
});

it.each([
  ["already true", { subagents: { agentOverrides: { delegate: { inheritSkills: true, thinking: "high" } } } }, true],
  ["explicitly false", { subagents: { agentOverrides: { delegate: { inheritSkills: false } } } }, false],
  ["another value", { subagents: { agentOverrides: { delegate: { inheritSkills: "personal" } } } }, "personal"],
] as const)("preserves and never claims an existing %s value", async (_label, value, expected) => {
  seed(value);
  const before = fs.readFileSync(settings(), "utf8");
  const warn = vi.spyOn(p.log, "warn").mockImplementation(() => {});
  expect(await runInstall(options())).toBe(0);
  expect(fs.readFileSync(settings(), "utf8")).toBe(before);
  expect(manifest().runtimes.pi!.configOwned ?? []).not.toContain(field);
  if (expected !== true) expect(warn.mock.calls.some(([message]) => String(message).includes("inheritSkills"))).toBe(true);
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(fs.readFileSync(settings(), "utf8")).toBe(before);
});

it("preserves a user override written after install and never removes it", async () => {
  expect(await runInstall(options())).toBe(0);
  seed({ subagents: { agentOverrides: { delegate: { inheritSkills: false } } } });
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(read()).toEqual({ subagents: { agentOverrides: { delegate: { inheritSkills: false } } } });
});

it.each(["invalid private config", "[]", '{"subagents":[]}'] as const)("fails closed on %s without modifying settings or other config", async (content) => {
  fs.mkdirSync(path.join(root, "pi-agent"), { recursive: true });
  fs.writeFileSync(settings(), content);
  const mcp = path.join(root, "pi-agent", "mcp.json");
  fs.writeFileSync(mcp, '{"mcpServers":{}}');
  expect(await runInstall(options())).toBe(1);
  expect(fs.readFileSync(settings(), "utf8")).toBe(content);
  expect(fs.readFileSync(mcp, "utf8")).toBe('{"mcpServers":{}}');
  expect(manifest().runtimes.pi).toBeUndefined();
});
