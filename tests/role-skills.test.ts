import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInstall } from "../src/install.js";
import { readManifest, writeRuntimeManifest } from "../src/lib/manifest.js";

const ROLES = ["analyst", "generalist", "implementer", "reviewer", "security-auditor", "simplifier"] as const;
const ROOT = path.resolve("stack/skills");

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-role-skills-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it("keeps the six roles as portable skills: only name and description, no model or runtime", () => {
  for (const role of ROLES) {
    const source = fs.readFileSync(path.join(ROOT, role, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
    expect(match, role).not.toBeNull();
    const fields = match![1]!.split("\n").map((line) => line.slice(0, line.indexOf(":")));
    expect(fields, role).toEqual(["name", "description"]);
    expect(match![1]).toContain(`name: ${role}`);
    expect(source).toContain("## Delegation");
    expect(source).not.toMatch(/\b(opus|sonnet|haiku|fable|gpt-|deepseek|claude)\b/i);
  }
});

it("installs the roles as shared skills and projects no agent file in any runtime", async () => {
  for (const runtime of ["claude-code", "codex", "opencode", "pi"] as const) {
    expect(await runInstall({ runtimes: [runtime], targetDir: root, dryRun: false, yes: true, opencodeTargetMajor: 2 }), runtime).toBe(0);
  }
  for (const role of ROLES) {
    expect(fs.existsSync(path.join(root, ".agents", "skills", role, "SKILL.md")), role).toBe(true);
  }
  for (const runtime of ["claude-code", "codex", "opencode", "pi-agent"]) {
    expect(fs.existsSync(path.join(root, runtime, "agents")), runtime).toBe(false);
  }
  for (const role of ROLES) {
    const link = path.join(root, "claude-code", "skills", role);
    expect(fs.lstatSync(link).isSymbolicLink(), role).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(root, ".agents", "skills", role)));
  }
});

it("retires agent files a previous version owned, with backup, and keeps foreign ones", async () => {
  const configDir = path.join(root, "pi-agent");
  const manifestFile = path.join(root, ".jorgex-stack", "manifest.json");
  const ownedAgent = path.join(configDir, "agents", "implementer.md");
  const foreignAgent = path.join(configDir, "agents", "personal.md");
  fs.mkdirSync(path.dirname(ownedAgent), { recursive: true });
  fs.writeFileSync(ownedAgent, "legacy implementer\n");
  fs.writeFileSync(foreignAgent, "personal\n");
  writeRuntimeManifest("pi", { configDir, owned: [ownedAgent], updatedAt: "legacy" }, manifestFile);

  expect(await runInstall({ runtimes: ["pi"], targetDir: root, dryRun: false, yes: true })).toBe(0);

  expect(fs.existsSync(ownedAgent)).toBe(false);
  expect(fs.readFileSync(foreignAgent, "utf8")).toBe("personal\n");
  expect(readManifest(manifestFile).runtimes.pi?.owned).not.toContain(ownedAgent);
  const backups = fs.readdirSync(path.join(root, ".jorgex-stack", "backups"));
  expect(backups.length).toBeGreaterThan(0);
});
