import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "tsup";

// Built inside the repo so the bundle resolves its external dependencies from node_modules.
const cache = path.resolve("node_modules/.cache");
let dir: string;
const run = (script: string) => spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 15_000 });

beforeAll(async () => {
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(path.join(cache, "cli-entry-"));
  await build({ entry: { cli: "src/cli.ts" }, outDir: dir, format: ["esm"], target: "node22", splitting: false, dts: false, clean: false, silent: true, config: false });
  symlinkSync(path.join(dir, "cli.js"), path.join(dir, "jorgex-stack"));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

// `--help` is only a start probe: the flag is rejected before any menu or configuration access.
it("reaches the same entry point through the package manager's bin symlink as through the real file", () => {
  const real = run(path.join(dir, "cli.js"));
  const linked = run(path.join(dir, "jorgex-stack"));
  expect(real.status).toBe(1);
  expect(real.stderr).toContain("Solo entrada interactiva");
  expect({ status: linked.status, stderr: linked.stderr }).toEqual({ status: real.status, stderr: real.stderr });
});
