import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { retireExtraEngramMonitor } from "../src/install.js";
let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-native-monitor-"); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
it("retires only the incompatible monitor while keeping memory plugin/hooks/MCP and client preferences", () => {
  fs.mkdirSync(path.join(root, "plugins"));
  fs.writeFileSync(path.join(root, "plugins", "engram.ts"), "official plugin sentinel");
  fs.writeFileSync(path.join(root, "opencode.json"), '{"mcp":{"engram":{"command":["engram","mcp"]}},"hooks":"sentinel"}');
  const target = path.join(root, "tui.jsonc");
  fs.writeFileSync(target, '// user comment\n{"plugin":["personal","opencode-subagent-statusline"],"theme":"personal"}');
  retireExtraEngramMonitor(root, path.join(root, "backups"));
  expect(fs.readFileSync(target, "utf8")).toContain("// user comment");
  expect(fs.readFileSync(target, "utf8")).toContain('"personal"');
  expect(fs.readFileSync(target, "utf8")).not.toContain("opencode-subagent-statusline");
  expect(fs.readFileSync(path.join(root, "plugins", "engram.ts"), "utf8")).toBe("official plugin sentinel");
  expect(fs.readFileSync(path.join(root, "opencode.json"), "utf8")).toContain('"hooks":"sentinel"');
});
it("does not leave a newly created monitor-only TUI file blocking v2 panel registration", () => {
  fs.writeFileSync(path.join(root, "tui.json"), '{"plugin":["opencode-subagent-statusline"]}');
  retireExtraEngramMonitor(root, path.join(root, "backups"), new Set(["tui.json"]));
  expect(fs.existsSync(path.join(root, "tui.json"))).toBe(false);
  expect(fs.readdirSync(path.join(root, "backups"))).toHaveLength(1);
});
