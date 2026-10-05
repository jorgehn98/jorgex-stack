import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
afterEach(() => vi.unstubAllEnvs());

it("the local header is TUI-only, uses the active theme, and releases its component", () => {
  vi.stubEnv("NO_COLOR", "");
  const source = fs.readFileSync("stack/assets/pi/jorgex-header.ts", "utf8");
  const standalone = source.replace(/^import .*from "@earendil-works\/[^\"]+";\n/gm, "");
  const compiled = ts.transpileModule(standalone, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: (api: unknown) => void } };
  new Function("module", "exports", "require", "VERSION", "truncateToWidth", "visibleWidth", compiled)(
    module, module.exports, require, "fixture-host", (text: string) => text, (text: string) => text.length,
  );
  const handlers = new Map<string, (...args: any[]) => void>();
  const commands = new Map<string, any>();
  module.exports.default({ on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command) });
  const setHeader = vi.fn();
  handlers.get("session_start")!({}, { mode: "rpc", ui: { setHeader } });
  expect(setHeader).not.toHaveBeenCalled();
  handlers.get("session_start")!({}, { mode: "tui", cwd: "/fixture/project", ui: { setHeader } });
  const theme = { fg: vi.fn((_token: string, line: string) => `theme:${line}`) };
  const component = setHeader.mock.calls[0]![0]({ requestRender() {} }, theme);
  const lines: string[] = component.render(80);
  expect(lines.every((line) => line.startsWith("theme:"))).toBe(true);
  expect(lines.join("\n")).toContain("fixture-host");
  expect(lines.join("\n")).not.toMatch(/PACKAGE|RUNNABLE|PACKAGED/);
  handlers.get("session_shutdown")!();
  expect(() => component.dispose()).not.toThrow();
  expect(commands.has("jorgex:header")).toBe(true);
});
