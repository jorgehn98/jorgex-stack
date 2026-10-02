import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { smokePiProviderRuntime } from "../src/lib/pi-provider-smoke.js";
import { smokeStagedPiRuntime } from "../src/lib/pi-stage-smoke.js";

vi.mock("../src/lib/pi-stage-smoke.js", () => ({ smokeStagedPiRuntime: vi.fn() }));

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(smokeStagedPiRuntime).mockReset();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-provider-smoke-test-"));
  temporaryRoots.push(scratchRoot);
  const roots: Record<string, string> = {};
  for (const name of ["jorgex-pi", "gentle-engram", "pi-mcp-adapter"]) {
    const root = path.join(scratchRoot, name);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "3.2.0" }));
    roots[name] = root;
  }
  return { scratchRoot, piExecutable: process.execPath, engramBin: process.execPath,
    jorgexPackageRoot: roots["jorgex-pi"]!,
    providerRoots: { "gentle-engram": roots["gentle-engram"]!, "pi-mcp-adapter": roots["pi-mcp-adapter"]! } };
}

it("retains the original smoke failure when Windows-style cleanup fails", async () => {
  const input = fixture();
  const original = new Error("pi-stage-smoke: MCP failed to connect");
  const cleanup = Object.assign(new Error("EPERM: stage directory is busy"), { code: "EPERM" });
  vi.mocked(smokeStagedPiRuntime).mockRejectedValue(original);
  vi.spyOn(fs, "rmSync").mockImplementation(() => { throw cleanup; });
  const error = await smokePiProviderRuntime(input).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([original, cleanup]);
  expect((error as Error).message).toContain(original.message);
  expect((error as Error).cause).toBe(original);
});

it("writes isolated legacy settings and cleans successful probes with bounded retries", async () => {
  const input = fixture();
  let observedSettings: unknown = undefined;
  vi.mocked(smokeStagedPiRuntime).mockImplementation(async ({ stageDir }) => {
    observedSettings = JSON.parse(fs.readFileSync(path.join(stageDir, "settings.json"), "utf8"));
    return { commands: ["mcp"] };
  });
  const remove = vi.spyOn(fs, "rmSync");
  await expect(smokePiProviderRuntime(input)).resolves.toEqual({ commands: ["mcp"] });
  expect(remove).toHaveBeenCalledWith(expect.stringContaining("stage-providers-smoke-"), {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  });
  expect(observedSettings).toEqual({
    packages: ["npm:jorgex-pi@3.2.0", "npm:gentle-engram@3.2.0", "npm:pi-mcp-adapter@3.2.0"],
    extensions: ["-builtin:mcp"],
  });
});
