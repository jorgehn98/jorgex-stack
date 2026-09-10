import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPlaywrightCliPreference,
  savePlaywrightCliPreference,
} from "../src/lib/tool-preferences.js";

const RUNTIMES = ["opencode", "claude-code", "codex", "pi"] as const;
type Runtime = (typeof RUNTIMES)[number];
const tempDirs: string[] = [];

function tempPreference(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-runtime-selection-"));
  tempDirs.push(dir);
  return path.join(dir, "playwright-cli.json");
}

function writePreference(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readPreference(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Playwright CLI preference by runtime", () => {
  it.each([true, false])("reads legacy v1 enabled=%s for every runtime", (enabled) => {
    const file = tempPreference();
    writePreference(file, { version: 1, enabled });

    for (const runtime of RUNTIMES) {
      expect(loadPlaywrightCliPreference(file, runtime)).toBe(enabled);
    }
  });

  it("writes an explicit runtime selection as v2 and reads each selected state", () => {
    const file = tempPreference();
    const selection: Record<Runtime, boolean> = {
      opencode: true,
      "claude-code": false,
      codex: true,
      pi: false,
    };

    savePlaywrightCliPreference(file, true, selection);

    expect(readPreference(file)).toEqual({ version: 2, enabled: selection });
    for (const runtime of RUNTIMES) {
      expect(loadPlaywrightCliPreference(file, runtime)).toBe(selection[runtime]);
    }
  });

  it("migrates legacy enabled=true to all runtimes before merging a partial selection", () => {
    const file = tempPreference();
    writePreference(file, { version: 1, enabled: true });

    savePlaywrightCliPreference(file, true, { opencode: false });

    expect(readPreference(file)).toEqual({
      version: 2,
      enabled: {
        opencode: false,
        "claude-code": true,
        codex: true,
        pi: true,
      },
    });
  });

  it("merges a partial v2 selection without changing runtimes outside the selection", () => {
    const file = tempPreference();
    writePreference(file, {
      version: 2,
      enabled: { opencode: true, codex: false, pi: true },
    });

    savePlaywrightCliPreference(file, true, { "claude-code": false });

    expect(readPreference(file)).toEqual({
      version: 2,
      enabled: {
        opencode: true,
        codex: false,
        pi: true,
        "claude-code": false,
      },
    });
  });

  it("preserves a v2 runtime map when an update saves without a new selection", () => {
    const file = tempPreference();
    const state = {
      version: 2,
      enabled: { opencode: true, "claude-code": false, codex: false, pi: true },
    };
    writePreference(file, state);

    savePlaywrightCliPreference(file, true);

    expect(readPreference(file)).toEqual(state);
  });

  it("rejects a corrupt runtime map and leaves it untouched", () => {
    const file = tempPreference();
    const raw = JSON.stringify({ version: 2, enabled: { opencode: "yes", codex: true } }) + "\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw, "utf8");

    expect(loadPlaywrightCliPreference(file, "opencode")).toBeUndefined();
    expect(() => savePlaywrightCliPreference(file, true, { pi: true })).toThrow(/preferencia.*inv[aá]lida/i);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });
});
