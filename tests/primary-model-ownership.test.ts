import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPrimaryModelOwnership,
  primaryModelOwnershipError,
  primaryModelOwnershipFile,
  savePrimaryModelOwnership,
} from "../src/lib/tool-preferences.js";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("primary model ownership", () => {
  it("persiste por runtime, libera campos y rechaza estado corrupto", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-primary-model-"));
    temporary.push(stateDir);
    const file = primaryModelOwnershipFile(stateDir);

    expect(loadPrimaryModelOwnership(file, "codex")).toEqual(new Set());
    savePrimaryModelOwnership(file, "codex", "model", true);
    savePrimaryModelOwnership(file, "codex", "model_context_window", true);
    savePrimaryModelOwnership(file, "opencode", "model", true);
    expect(loadPrimaryModelOwnership(file, "codex")).toEqual(new Set(["model", "model_context_window"]));
    expect(loadPrimaryModelOwnership(file, "opencode")).toEqual(new Set(["model"]));

    savePrimaryModelOwnership(file, "codex", "model", false);
    expect(loadPrimaryModelOwnership(file, "codex")).toEqual(new Set(["model_context_window"]));

    fs.writeFileSync(file, "not-json");
    expect(primaryModelOwnershipError(file)).toContain("ownership inválido");
    expect(() => savePrimaryModelOwnership(file, "codex", "model", true)).toThrow("ownership inválido");
  });
});
