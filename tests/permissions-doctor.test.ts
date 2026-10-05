import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runDoctor } from "../src/doctor.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@clack/prompts", () => ({ log: logs }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-permissions-doctor-"); vi.clearAllMocks(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const output = () => [...logs.info.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls].flat().join("\n");
const options = (runtime: "pi" | "opencode" | "claude-code" | "codex") => ({ runtimes: [runtime], targetDir: root, opencodeTargetMajor: 2 });
async function install(runtime: "pi" | "opencode" | "claude-code" | "codex") {
  expect(await runInstall({ ...options(runtime), yes: true, dryRun: false })).toBe(0);
  vi.clearAllMocks();
}

it.each(["claude-code", "opencode", "codex"] as const)("reports differing %s permissions without changing or dumping user configuration", async (runtime) => {
  await install(runtime);
  const config = path.join(root, runtime, runtime === "claude-code" ? "settings.json" : runtime === "codex" ? "config.toml" : "opencode.json");
  const canary = "private-permission-canary";
  const initial = fs.readFileSync(config, "utf8");
  const content = runtime === "codex"
    ? initial.replace('default_permissions = "jorgex-read-anywhere"', 'default_permissions = "personal"') + `\n# ${canary}\n`
    : JSON.stringify({ ...JSON.parse(initial), permissions: runtime === "opencode" ? [{ action: "shell", resource: canary, effect: "deny" }] : { allow: [canary] } });
  fs.writeFileSync(config, content);
  await runDoctor(options(runtime));
  expect(output()).toMatch(/permission(?:s block| profile) differs/);
  expect(output()).toContain("--upgrade-permissions");
  expect(output()).not.toContain(canary);
  expect(fs.readFileSync(config, "utf8")).toBe(content);
});

it.each(["claude-code", "opencode", "codex"] as const)("does not report permission drift for a fresh %s projection", async (runtime) => {
  await install(runtime);
  expect(await runDoctor(options(runtime))).toBe(0);
  expect(output()).not.toMatch(/permission(?:s block| profile) differs/);
});

it("reads native Pi permission configuration without receipts, claims or repairs", async () => {
  await install("pi");
  const policy = path.join(root, "pi-agent", "extensions", "pi-permission-system", "config.json");
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  const content = '{"permission":{"read":"ask","private":"private-policy-canary"}}';
  fs.writeFileSync(policy, content);
  expect(await runDoctor(options("pi"))).toBe(0);
  expect(output()).toContain("proveedor controla su aplicación");
  expect(output()).not.toContain("private-policy-canary");
  expect(output()).not.toContain("--upgrade-permissions");
  expect(fs.readFileSync(policy, "utf8")).toBe(content);
});

it.each(["malformed", "invalid-root", "unreadable"] as const)("fails closed for %s Pi permission configuration without changing or exposing it", async (kind) => {
  await install("pi");
  const policy = path.join(root, "pi-agent", "extensions", "pi-permission-system", "config.json");
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  const content = kind === "malformed" ? 'private-policy-canary {{' : '{"permission":null,"private":"private-policy-canary"}';
  if (kind === "unreadable") fs.mkdirSync(policy); else fs.writeFileSync(policy, content);
  expect(await runDoctor(options("pi"))).toBe(1);
  expect(output()).toMatch(/inválida|no se puede leer/);
  expect(output()).not.toContain("private-policy-canary");
  expect(output()).not.toContain("--upgrade-permissions");
  if (kind === "unreadable") expect(fs.statSync(policy).isDirectory()).toBe(true);
  else expect(fs.readFileSync(policy, "utf8")).toBe(content);
});

it("does not infer an invalid Pi permission state when optional configuration is absent", async () => {
  await install("pi");
  expect(await runDoctor(options("pi"))).toBe(0);
  expect(output()).not.toContain("configuración nativa de permisos presente");
});
