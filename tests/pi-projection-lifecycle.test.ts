import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

type ProjectionOperation = "install" | "sync" | "doctor" | "uninstall";

type ProjectionReceipt = {
  schemaVersion: 1;
  scope: ProjectionScope;
  owned: string[];
};

type ProjectionScope = {
  kind: "real" | "target-dir";
  home: string;
  codingAgentDir: string;
  receiptFile: string;
};

type StackManifest = {
  runtimes: {
    codex?: { owned: string[] };
    opencode?: { owned: string[] };
  };
};

type ProjectionResult =
  | { kind: "installed"; receipt: ProjectionReceipt }
  | { kind: "synced"; changed: boolean }
  | { kind: "healthy" }
  | { kind: "drift"; paths: string[] }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: "projection-cleanup-failed" };

type ProjectionDeps = {
  readText(file: string): string | null;
  backup(paths: string[]): void;
  writeText(file: string, content: string): void;
  copyFile(source: string, target: string): void;
  removeFile(file: string): void;
  readManifest(): StackManifest;
};

type PiProjectionLifecycle = {
  runPiProjectionLifecycle(
    input: {
      operation: ProjectionOperation;
      scope: ProjectionScope;
      packageSource: string;
      stackDir: string;
      engramBin: string;
      playwrightCliEnabled: boolean;
      models: typeof DEFAULT_MODEL_MAP.codex;
    },
    deps: ProjectionDeps,
  ): ProjectionResult;
};

async function lifecycle(): Promise<PiProjectionLifecycle> {
  const mod = await import("../src/lib/pi-projection-lifecycle.js") as Partial<PiProjectionLifecycle>;
  expect(mod.runPiProjectionLifecycle).toBeTypeOf("function");
  return mod as PiProjectionLifecycle;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function backupPaths(events: string[]): string[] {
  return events
    .filter((event) => event.startsWith("backup:"))
    .flatMap((event) => event.slice("backup:".length).split("|").filter(Boolean));
}

function expectBackupsBeforeMutation(events: string[], expected: string[]): void {
  const firstMutation = events.findIndex((event) => event.startsWith("write:")
    || event.startsWith("copy:")
    || event.startsWith("remove:"));
  expect(firstMutation).toBeGreaterThanOrEqual(0);
  expect(backupPaths(events.slice(0, firstMutation))).toEqual(expect.arrayContaining(expected.map((file) => path.resolve(file))));
}

function temporaryDeps(
  root: string,
  events: string[],
  manifest: StackManifest,
  failedDeletes = new Set<string>(),
): ProjectionDeps {
  const assertTarget = (file: string): void => {
    if (!isInside(root, file)) throw new Error(`test dependency escaped temporary root: ${file}`);
  };

  return {
    readText(file) {
      assertTarget(file);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
    backup(paths) {
      const resolved = paths.map((file) => {
        assertTarget(file);
        return path.resolve(file);
      });
      events.push(`backup:${resolved.join("|")}`);
    },
    writeText(file, content) {
      assertTarget(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      events.push(`write:${path.resolve(file)}`);
    },
    copyFile(source, target) {
      assertTarget(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      events.push(`copy:${path.resolve(target)}`);
    },
    removeFile(file) {
      assertTarget(file);
      events.push(`remove:${path.resolve(file)}`);
      if (failedDeletes.has(path.resolve(file))) throw new Error("simulated projection cleanup failure");
      fs.rmSync(file, { force: true });
    },
    readManifest: () => manifest,
  };
}

function seedTarget(root: string, source: string, scope: ProjectionScope = {
  kind: "target-dir",
  home: path.join(root, "home"),
  codingAgentDir: path.join(root, "pi-agent"),
  receiptFile: path.join(root, "state", "pi-projection-receipt.json"),
}): {
  home: string;
  agentDir: string;
  strictReceipt: string;
  projectionReceipt: string;
  scope: ProjectionScope;
  settings: string;
  userPrompt: string;
} {
  const { home, codingAgentDir: agentDir, receiptFile: projectionReceipt } = scope;
  const strictReceipt = path.join(root, "state", "pi-receipt.json");
  const settings = path.join(agentDir, "settings.json");
  const userPrompt = "# User-owned Pi policy\n\nDo not remove this paragraph.\n";

  fs.mkdirSync(path.dirname(strictReceipt), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), userPrompt);
  fs.writeFileSync(path.join(agentDir, "prompts", "custom.md"), "# User prompt\n");
  fs.writeFileSync(strictReceipt, "{\"strict\":\"package-receipt\"}\n");
  fs.writeFileSync(settings, JSON.stringify({
    foreign: { preserved: true },
    packages: [
      { source: "npm:foreign-package@1.0.0", skills: ["foreign-skill"] },
      { source, skills: ["agent-delegation", "tdd"] },
    ],
  }, null, 2) + "\n");

  return {
    home,
    agentDir,
    strictReceipt,
    projectionReceipt,
    scope,
    settings,
    userPrompt,
  };
}

describe("Pi shared projection lifecycle", () => {
  it("projects before filtering the package entry, reconciles the Playwright-only browser section, keeps target-dir state isolated, detects drift read-only, and cleans only receipt-owned resources retained by no Codex/OpenCode manifest", async () => {
    const { runPiProjectionLifecycle } = await lifecycle();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-lifecycle-"));
    const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-cleanup-"));
    const source = "npm:jorgex-pi@0.4.0";

    try {
      const target = seedTarget(root, source);
      const agentsFile = path.join(target.agentDir, "AGENTS.md");
      const leanAudit = path.join(target.agentDir, "prompts", "lean-audit.md");
      const userPrompt = path.join(target.agentDir, "prompts", "custom.md");
      const codexRetainedSkill = path.join(target.home, ".agents", "skills", "agent-delegation", "SKILL.md");
      const opencodeRetainedSkill = path.join(target.home, ".agents", "skills", "tdd", "SKILL.md");
      const removedSkill = path.join(target.home, ".agents", "skills", "diagnose", "SKILL.md");
      const foreignSkill = path.join(target.home, ".agents", "skills", "foreign", "SKILL.md");
      const manifest: StackManifest = {
        runtimes: {
          codex: { owned: [codexRetainedSkill] },
          opencode: { owned: [opencodeRetainedSkill] },
        },
      };
      fs.mkdirSync(path.dirname(codexRetainedSkill), { recursive: true });
      fs.writeFileSync(leanAudit, "# Previous managed prompt\n");
      fs.writeFileSync(codexRetainedSkill, "# Previous managed skill\n");
      const events: string[] = [];
      const deps = temporaryDeps(root, events, manifest);
      const input = {
        scope: target.scope,
        packageSource: source,
        stackDir: stackRoot(),
        engramBin: path.join(root, "bin", "engram"),
        playwrightCliEnabled: false,
        models: DEFAULT_MODEL_MAP.codex,
      };
      const strictReceiptBefore = fs.readFileSync(target.strictReceipt, "utf8");

      const installed = runPiProjectionLifecycle({ ...input, operation: "install" }, deps);
      expect(installed).toMatchObject({
        kind: "installed",
        receipt: {
          schemaVersion: 1,
          scope: target.scope,
          owned: expect.arrayContaining([leanAudit, codexRetainedSkill, removedSkill]),
        },
      });
      expectBackupsBeforeMutation(events, [agentsFile, target.settings, leanAudit, codexRetainedSkill]);
      expect(fs.existsSync(leanAudit)).toBe(true);
      expect(fs.existsSync(codexRetainedSkill)).toBe(true);
      expect(fs.existsSync(removedSkill)).toBe(true);
      expect(fs.readFileSync(agentsFile, "utf8")).toContain(target.userPrompt.trim());
      expect(JSON.parse(fs.readFileSync(target.settings, "utf8"))).toEqual({
        foreign: { preserved: true },
        packages: [
          { source: "npm:foreign-package@1.0.0", skills: ["foreign-skill"] },
          { source, skills: [], prompts: [] },
        ],
      });
      const installedPrompt = fs.readFileSync(agentsFile, "utf8");
      expect(installedPrompt).toContain("<!-- jorgex:engram-protocol -->");
      expect(installedPrompt).not.toContain("<!-- jorgex:browser -->");
      expect(fs.readFileSync(target.strictReceipt, "utf8")).toBe(strictReceiptBefore);
      expect(fs.existsSync(target.projectionReceipt)).toBe(true);
      expect(JSON.parse(fs.readFileSync(target.projectionReceipt, "utf8"))).toMatchObject({
        schemaVersion: 1,
        scope: target.scope,
        owned: expect.arrayContaining([leanAudit, codexRetainedSkill, removedSkill]),
      });

      const packageWrite = events.indexOf(`write:${path.resolve(target.settings)}`);
      const lastProjectionWrite = Math.max(
        events.indexOf(`write:${path.resolve(agentsFile)}`),
        events.indexOf(`write:${path.resolve(leanAudit)}`),
        events.indexOf(`copy:${path.resolve(codexRetainedSkill)}`),
      );
      expect(lastProjectionWrite).toBeGreaterThanOrEqual(0);
      expect(packageWrite).toBeGreaterThan(lastProjectionWrite);

      events.length = 0;
      expect(runPiProjectionLifecycle({ ...input, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: false });
      expect(events).toEqual([]);

      fs.writeFileSync(leanAudit, "# Drifted managed prompt\n");
      fs.writeFileSync(codexRetainedSkill, "# Drifted managed skill\n");
      fs.writeFileSync(target.settings, JSON.stringify({
        foreign: { preserved: true },
        packages: [
          { source: "npm:foreign-package@1.0.0", skills: ["foreign-skill"] },
          source,
        ],
      }, null, 2) + "\n");
      const browserEnabledInput = { ...input, playwrightCliEnabled: true };
      events.length = 0;
      expect(runPiProjectionLifecycle({ ...browserEnabledInput, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: true });
      expectBackupsBeforeMutation(events, [agentsFile, target.settings, leanAudit, codexRetainedSkill]);
      const browserEnabledPrompt = fs.readFileSync(agentsFile, "utf8");
      expect(browserEnabledPrompt).toContain(target.userPrompt.trim());
      expect(browserEnabledPrompt.match(/<!-- jorgex:browser -->/g)).toHaveLength(1);
      expect(browserEnabledPrompt).toContain("Playwright CLI");
      expect(browserEnabledPrompt).not.toContain("Chrome DevTools MCP");
      expect(browserEnabledPrompt).toContain("<!-- jorgex:engram-protocol -->");

      events.length = 0;
      expect(runPiProjectionLifecycle({ ...browserEnabledInput, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: false });
      expect(events).toEqual([]);

      fs.rmSync(removedSkill);
      events.length = 0;
      expect(runPiProjectionLifecycle({ ...browserEnabledInput, operation: "doctor" }, deps)).toEqual({
        kind: "drift",
        paths: expect.arrayContaining([removedSkill]),
      });
      expect(events).toEqual([]);

      expect(runPiProjectionLifecycle({ ...browserEnabledInput, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: true });
      expect(fs.existsSync(removedSkill)).toBe(true);
      expect(fs.readFileSync(target.strictReceipt, "utf8")).toBe(strictReceiptBefore);

      events.length = 0;
      expect(runPiProjectionLifecycle({ ...input, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: true });
      expectBackupsBeforeMutation(events, [agentsFile]);
      const browserDisabledPrompt = fs.readFileSync(agentsFile, "utf8");
      expect(browserDisabledPrompt).toContain(target.userPrompt.trim());
      expect(browserDisabledPrompt).toContain("<!-- jorgex:engram-protocol -->");
      expect(browserDisabledPrompt).not.toContain("<!-- jorgex:browser -->");

      events.length = 0;
      expect(runPiProjectionLifecycle({ ...input, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: false });
      expect(events).toEqual([]);

      fs.mkdirSync(path.dirname(foreignSkill), { recursive: true });
      fs.writeFileSync(foreignSkill, "# Foreign shared skill\n");
      fs.appendFileSync(agentsFile, [
        "",
        "<!-- jorgex:browser -->",
        "obsolete managed browser section",
        "<!-- /jorgex:browser -->",
        "",
      ].join("\n"));
      expect(fs.readFileSync(agentsFile, "utf8")).toContain("<!-- jorgex:browser -->");

      const receiptOwned = (JSON.parse(fs.readFileSync(target.projectionReceipt, "utf8")) as ProjectionReceipt).owned;
      expect(receiptOwned.every((file) => fs.existsSync(file))).toBe(true);
      events.length = 0;
      expect(runPiProjectionLifecycle({ ...input, operation: "uninstall" }, deps)).toEqual({ kind: "uninstalled" });
      expectBackupsBeforeMutation(events, [agentsFile, ...receiptOwned]);
      const uninstalledPrompt = fs.readFileSync(agentsFile, "utf8");
      expect(uninstalledPrompt).toContain(target.userPrompt.trim());
      expect(uninstalledPrompt).not.toContain("<!-- jorgex:system-prompt -->");
      expect(uninstalledPrompt).not.toContain("<!-- jorgex:engram-protocol -->");
      expect(uninstalledPrompt).not.toContain("<!-- jorgex:browser -->");
      expect(fs.existsSync(leanAudit)).toBe(false);
      expect(fs.existsSync(removedSkill)).toBe(false);
      expect(fs.existsSync(codexRetainedSkill)).toBe(true);
      expect(fs.existsSync(opencodeRetainedSkill)).toBe(true);
      expect(fs.readFileSync(userPrompt, "utf8")).toBe("# User prompt\n");
      expect(fs.readFileSync(foreignSkill, "utf8")).toBe("# Foreign shared skill\n");
      expect(fs.existsSync(target.projectionReceipt)).toBe(false);
      expect(fs.readFileSync(target.strictReceipt, "utf8")).toBe(strictReceiptBefore);

      const failed = seedTarget(failedRoot, source);
      const failedInput = {
        ...input,
        scope: failed.scope,
        engramBin: path.join(failedRoot, "bin", "engram"),
      };
      const failedEvents: string[] = [];
      const bootstrapDeps = temporaryDeps(failedRoot, failedEvents, { runtimes: {} });
      expect(runPiProjectionLifecycle({ ...failedInput, operation: "install" }, bootstrapDeps)).toMatchObject({ kind: "installed" });
      const failedReceiptBefore = fs.readFileSync(failed.projectionReceipt, "utf8");
      const failedLeanAudit = path.join(failed.agentDir, "prompts", "lean-audit.md");
      const failingDeps = temporaryDeps(
        failedRoot,
        failedEvents,
        { runtimes: {} },
        new Set([path.resolve(failedLeanAudit)]),
      );

      expect(runPiProjectionLifecycle({ ...failedInput, operation: "uninstall" }, failingDeps)).toEqual({
        kind: "blocked",
        reason: "projection-cleanup-failed",
      });
      expect(fs.readFileSync(failed.projectionReceipt, "utf8")).toBe(failedReceiptBefore);
      expect(fs.readFileSync(failed.strictReceipt, "utf8")).toBe("{\"strict\":\"package-receipt\"}\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(failedRoot, { recursive: true, force: true });
    }
  });

  it("accepts an explicit real scope without deriving paths from a target root", async () => {
    const { runPiProjectionLifecycle } = await lifecycle();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-real-scope-"));
    const source = "npm:jorgex-pi@0.4.0";

    try {
      const scope: ProjectionScope = {
        kind: "real",
        home: path.join(root, "test-user-home"),
        codingAgentDir: path.join(root, "test-pi-config", "agent"),
        receiptFile: path.join(root, "managed-state", "projection.json"),
      };
      seedTarget(root, source, scope);
      const deps = temporaryDeps(root, [], { runtimes: {} });

      const result = runPiProjectionLifecycle({
        operation: "install",
        scope,
        packageSource: source,
        stackDir: stackRoot(),
        engramBin: path.join(root, "bin", "engram"),
        playwrightCliEnabled: false,
        models: DEFAULT_MODEL_MAP.codex,
      }, deps);

      expect(result).toMatchObject({
        kind: "installed",
        receipt: {
          schemaVersion: 1,
          scope,
          owned: expect.arrayContaining([
            path.join(scope.home, ".agents", "skills", "diagnose", "SKILL.md"),
            path.join(scope.codingAgentDir, "prompts", "lean-audit.md"),
          ]),
        },
      });
      expect(fs.existsSync(path.join(scope.home, ".agents", "skills", "diagnose", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(scope.codingAgentDir, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(scope.codingAgentDir, "prompts", "lean-audit.md"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(scope.receiptFile, "utf8"))).toMatchObject({
        schemaVersion: 1,
        scope,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
