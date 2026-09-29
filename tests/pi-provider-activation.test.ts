import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-activate-")); roots.push(homeDir);
  const agentDir = path.join(homeDir, ".pi", "agent");
  const modules = path.join(agentDir, "npm", "node_modules");
  const stageDir = path.join(agentDir, "stage-provider-test", "pi-agent");
  const settingsJson = JSON.stringify({ quietStartup: false, packages: [{ source: "npm:gentle-engram@0.1.0", skills: [] }, "npm:pi-mcp-adapter@latest", { source: "npm:jorgex-pi@0.8.37", extensions: ["bootstrap.ts"] }, "npm:foreign@1.0.0"] });
  const packages = (["gentle-engram", "pi-mcp-adapter"] as const).map(name => {
    const activeRoot = path.join(modules, name); const packageRoot = path.join(stageDir, "npm", "node_modules", name);
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
