import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_ENTRY = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const VITEST_CONFIG = path.join(ROOT, "vitest.config.ts");

function relativeFiles(root: string, files: string[]): string[] {
  return files
    .map((file) => path.relative(root, path.resolve(file)).split(path.sep).join("/"))
    .sort();
}

function listFixtureFiles(root: string): string[] {
  const args = [VITEST_ENTRY, "list", "--filesOnly", "--json", "--static-parse"];
  if (fs.existsSync(VITEST_CONFIG)) args.push("--config", VITEST_CONFIG);
  args.push("--root", root);

  let output: string;
  try {
    output = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (error) {
    const details = error as { message?: string; stderr?: Buffer | string };
    const stderr = details.stderr === undefined ? "" : `\n${String(details.stderr)}`;
    throw new Error(`Vitest discovery command failed: ${details.message ?? String(error)}${stderr}`);
  }
  const listed = JSON.parse(output) as unknown;
  if (!Array.isArray(listed)) throw new Error("Vitest list did not return an array");

  return listed.map((entry) => {
    const file = (entry as { file?: unknown }).file;
    if (typeof file !== "string" || file.length === 0) {
      throw new Error("Vitest list returned an invalid file entry");
    }
    return file;
  });
}

describe("repository test discovery", () => {
  it("discovers only canonical fixture tests and ignores worktree/store copies", () => {
    const fixture = fs.mkdtempSync(path.join(ROOT, ".vitest-discovery-"));
    try {
      fs.mkdirSync(path.join(fixture, "tests", "nested"), { recursive: true });
      fs.mkdirSync(path.join(fixture, "worktrees", "copied"), { recursive: true });
      fs.mkdirSync(path.join(fixture, ".pnpm-store", "copied"), { recursive: true });

      fs.writeFileSync(path.join(fixture, "tests", "canonical.test.ts"), "export {}\n");
      fs.writeFileSync(path.join(fixture, "tests", "nested", "canonical.spec.ts"), "export {}\n");
      fs.writeFileSync(path.join(fixture, "worktrees", "copied", "copy.test.ts"), "export {}\n");
      fs.writeFileSync(path.join(fixture, ".pnpm-store", "copied", "copy.spec.ts"), "export {}\n");

      const discovered = relativeFiles(fixture, listFixtureFiles(fixture));
      expect(discovered).toEqual([
        "tests/canonical.test.ts",
        "tests/nested/canonical.spec.ts",
      ]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
