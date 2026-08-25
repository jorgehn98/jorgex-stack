import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "pi-artifact.yml");

function readWorkflow(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function expectInOrder(haystack: string, needles: string[]): void {
  let cursor = -1;

  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    expect(index, `No se encontró "${needle}" después de la posición ${cursor}.`).toBeGreaterThan(-1);
    cursor = index;
  }
}

describe("JorgeX Pi artifact pull-request gate", () => {
  it("downloads and validates the exact frozen npm tarball before the complete quality suite", () => {
    const workflow = readWorkflow();
    const { name, version } = PI_RUNTIME_CANDIDATE.package;
    const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(workflow).toContain("pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("curl --fail");
    expect(workflow).toContain("--connect-timeout 15");
    expect(workflow).toContain("--max-time 300");
    expect(workflow).toContain(tarballUrl);
    expect(workflow).toContain("JORGEX_PI_TARBALL=$tarball");
    expect(workflow).not.toMatch(/\bnpm\s+(?:install|publish)\b/);
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toMatch(/(?:contents|id-token):\s*write/);

    expectInOrder(workflow, [
      "pnpm install --frozen-lockfile",
      tarballUrl,
      "JORGEX_PI_TARBALL=$tarball",
      "pnpm typecheck",
      "pnpm exec vitest run tests/pi-cross-repo-contract.test.ts",
      "pnpm test",
      "pnpm build",
    ]);
  });
});
