import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { stackRoot } from "../src/lib/paths.js";
import { nativePermission } from "./fixtures/opencode-native.js";

const binary = process.env.JORGEX_OPENCODE_BIN;
const permission = JSON.parse(fs.readFileSync(path.join(stackRoot(), "config", "defaults.json"), "utf8")).opencode.permission;
const models = { strong: { model: "fixture/fixture" }, standard: { model: "fixture/fixture" }, cheap: { model: "fixture/fixture" } };
const safeDiff = "git --no-pager -c core.fsmonitor=false -c log.showSignature=false diff --no-ext-diff --no-textconv --end-of-options";

describe.skipIf(!binary || process.platform === "win32")("OpenCode 1.18.30 native permission contract", () => {
  beforeAll(() => { expect(execFileSync(binary!, ["--version"], { encoding: "utf8" }).trim()).toBe("1.18.30"); });
  it.each([
    ["printf ordinary", "allow"], ["git status", "allow"], ["git diff", "allow"], ["git log -10", "allow"],
    ["rm -rf ordinary", "ask"], ["rm -rf /", "deny"], ["rm -rf /tmp/ordinary", "ask"], ["sudo rm -rf /", "deny"], ["rm -rf /etc/ordinary", "deny"], ["git reset --hard", "ask"], ["git clean -fd", "ask"],
    ["git push --force-with-lease origin main", "ask"], ["git push origin main -f", "ask"], ["sudo printf ordinary", "ask"],
    ["dd if=ordinary of=output", "deny"], ["mkfs.ext4 ordinary", "deny"], ["shred ordinary", "deny"],
    ["cat .env", "deny"], ["cat ~/.ssh/id_ed25519", "deny"], ["printf ordinary; rm -rf ordinary", "ask"],
  ] as const)("%s → %s", async (command, expected) => {
    expect(await nativePermission({ binary: binary!, permission, command })).toBe(expected);
  }, 25000);
  it.each([
    ["read", "ordinary.txt", "allow"], ["write", "ordinary.txt", "allow"], ["read", ".env", "deny"],
    ["write", ".ssh/id_rsa", "deny"], ["read", ".env.example", "allow"],
  ] as const)("%s %s → %s", async (tool, file, expected) => {
    expect(await nativePermission({ binary: binary!, permission, tool, file })).toBe(expected);
  }, 25000);
  it("a full writer still inherits protected edit paths", async () => {
    const [agent] = opencodeAdapter.renderAgent({ name: "probe", description: "Permission fixture", mode: "subagent", tier: "standard", readonly: false, bash: "full", spawn: true, body: "Use the local fixture." }, models);
    expect(await nativePermission({ binary: binary!, permission, tool: "write", file: ".env", agent: agent!.content })).toBe("deny");
  }, 25000);
  it.each([
    ["none", "printf ordinary", "deny"], ["full", "rm -rf ordinary", "ask"],
    ["git-read", "printf ordinary", "deny"], ["git-read", `${safeDiff} HEAD`, "allow"],
    ["git-read", `${safeDiff} HEAD; printf side-effect`, "deny"],
    ["git-read", `${safeDiff} $(printf side-effect)`, "deny"],
  ] as const)("%s subagent: %s → %s", async (bash, command, expected) => {
    const [agent] = opencodeAdapter.renderAgent({ name: "probe", description: "Permission fixture", mode: "subagent", tier: "standard", readonly: bash !== "full", bash, spawn: false, body: "Use the local fixture." }, models);
    expect(await nativePermission({ binary: binary!, permission, command, agent: agent!.content })).toBe(expected);
  }, 25000);
});
