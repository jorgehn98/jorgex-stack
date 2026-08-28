import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  | {
    kind: "blocked";
    reason: "projection-backup-failed" | "projection-cleanup-failed" | "source-divergent";
  };

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
    },
    deps: ProjectionDeps,
  ): ProjectionResult;
};

type PiProjectionLifecycleSystem = {
  runPiProjectionLifecycleSystem(input: {
    operation: ProjectionOperation;
    targetDir?: string;
    packageSource: string;
    engramBin: string | null;
    playwrightCliEnabled: boolean;
  }): ProjectionResult;
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
  backupError: Error | null = null,
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
      if (backupError !== null) throw backupError;
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
      source,
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

  describe("package projection ownership", () => {
    it.each([
      ["non-empty skills and prompts", {
        source: "npm:jorgex-pi@0.4.0",
        skills: ["user-skill"],
        prompts: ["user-prompt"],
      }],
      ["an extra field", {
        source: "npm:jorgex-pi@0.4.0",
        skills: [],
        prompts: [],
        userOwned: true,
      }],
    ] as const)("rejects a source-divergent entry with %s without rewriting it", async (_case, divergentEntry) => {
      const { runPiProjectionLifecycle } = await lifecycle();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-source-divergent-"));
      const source = "npm:jorgex-pi@0.4.0";

      try {
        const target = seedTarget(root, source);
        const events: string[] = [];
        const deps = temporaryDeps(root, events, { runtimes: {} });
        const input = {
          scope: target.scope,
          packageSource: source,
          stackDir: stackRoot(),
          engramBin: path.join(root, "bin", "engram"),
          playwrightCliEnabled: false,
        };

        expect(runPiProjectionLifecycle({ ...input, operation: "install" }, deps)).toMatchObject({ kind: "installed" });
        const divergentSettings = JSON.stringify({
          foreign: { preserved: true },
          packages: [
            { source: "npm:foreign-package@1.0.0", skills: ["foreign-skill"] },
            divergentEntry,
          ],
        }, null, 2) + "\n";
        fs.writeFileSync(target.settings, divergentSettings);

        events.length = 0;
        expect(runPiProjectionLifecycle({ ...input, operation: "sync" }, deps)).toEqual({
          kind: "blocked",
          reason: "source-divergent",
        });
        expect(events).toEqual([]);
        expect(fs.readFileSync(target.settings, "utf8")).toBe(divergentSettings);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("projection receipt validation", () => {
    it.each(["an extra owned path", "a duplicate owned path"] as const)("rejects %s without mutating the prompt or owned files", async (tampering) => {
      const { runPiProjectionLifecycle } = await lifecycle();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-receipt-tamper-"));
      const source = "npm:jorgex-pi@0.4.0";

      try {
        const target = seedTarget(root, source);
        const events: string[] = [];
        const deps = temporaryDeps(root, events, { runtimes: {} });
        const input = {
          scope: target.scope,
          packageSource: source,
          stackDir: stackRoot(),
          engramBin: path.join(root, "bin", "engram"),
          playwrightCliEnabled: false,
        };
        expect(runPiProjectionLifecycle({ ...input, operation: "install" }, deps)).toMatchObject({ kind: "installed" });

        const prompt = path.join(target.agentDir, "AGENTS.md");
        const promptBefore = fs.readFileSync(prompt, "utf8");
        const receipt = JSON.parse(fs.readFileSync(target.projectionReceipt, "utf8")) as ProjectionReceipt;
        const firstOwned = receipt.owned[0];
        if (firstOwned === undefined) throw new Error("fixture did not create projection-owned paths");
        const foreignPath = path.join(target.home, ".foreign", "preserve-me.md");
        fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
        fs.writeFileSync(foreignPath, "# Foreign file\n");
        const tamperedReceipt = {
          ...receipt,
          owned: tampering === "an extra owned path"
            ? [...receipt.owned, foreignPath]
            : [...receipt.owned, firstOwned],
        };
        const receiptBefore = JSON.stringify(tamperedReceipt, null, 2) + "\n";
        fs.writeFileSync(target.projectionReceipt, receiptBefore);

        events.length = 0;
        expect(runPiProjectionLifecycle({ ...input, operation: "uninstall" }, deps)).toEqual({
          kind: "blocked",
          reason: "projection-cleanup-failed",
        });
        expect(events).toEqual([]);
        expect(fs.readFileSync(prompt, "utf8")).toBe(promptBefore);
        expect(fs.readFileSync(target.projectionReceipt, "utf8")).toBe(receiptBefore);
        expect(fs.readFileSync(foreignPath, "utf8")).toBe("# Foreign file\n");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("does not mutate the prompt when the projection receipt is corrupt", async () => {
      const { runPiProjectionLifecycle } = await lifecycle();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-receipt-corrupt-"));
      const source = "npm:jorgex-pi@0.4.0";

      try {
        const target = seedTarget(root, source);
        const events: string[] = [];
        const deps = temporaryDeps(root, events, { runtimes: {} });
        const input = {
          scope: target.scope,
          packageSource: source,
          stackDir: stackRoot(),
          engramBin: path.join(root, "bin", "engram"),
          playwrightCliEnabled: false,
        };
        expect(runPiProjectionLifecycle({ ...input, operation: "install" }, deps)).toMatchObject({ kind: "installed" });

        const prompt = path.join(target.agentDir, "AGENTS.md");
        const promptBefore = fs.readFileSync(prompt, "utf8");
        const receiptBefore = "{ this is not valid JSON\n";
        fs.writeFileSync(target.projectionReceipt, receiptBefore);

        events.length = 0;
        expect(runPiProjectionLifecycle({ ...input, operation: "uninstall" }, deps)).toEqual({
          kind: "blocked",
          reason: "projection-cleanup-failed",
        });
        expect(events).toEqual([]);
        expect(fs.readFileSync(prompt, "utf8")).toBe(promptBefore);
        expect(fs.readFileSync(target.projectionReceipt, "utf8")).toBe(receiptBefore);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("reports a backup failure without mutating a drifted projection", async () => {
    const { runPiProjectionLifecycle } = await lifecycle();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-backup-failure-"));
    const source = "npm:jorgex-pi@0.4.0";

    try {
      const target = seedTarget(root, source);
      const events: string[] = [];
      const input = {
        scope: target.scope,
        packageSource: source,
        stackDir: stackRoot(),
        engramBin: path.join(root, "bin", "engram"),
        playwrightCliEnabled: false,
      };
      expect(runPiProjectionLifecycle({ ...input, operation: "install" }, temporaryDeps(root, events, { runtimes: {} }))).toMatchObject({ kind: "installed" });

      const driftedPrompt = path.join(target.agentDir, "prompts", "lean-audit.md");
      fs.writeFileSync(driftedPrompt, "# Drifted managed prompt\n");
      events.length = 0;
      const failingDeps = temporaryDeps(root, events, { runtimes: {} }, new Set(), new Error("simulated backup failure"));
      let result: ProjectionResult | undefined;

      expect(() => {
        result = runPiProjectionLifecycle({ ...input, operation: "sync" }, failingDeps);
      }).not.toThrow();
      expect(result).toEqual({ kind: "blocked", reason: "projection-backup-failed" });
      expect(events).toEqual([]);
      expect(fs.readFileSync(driftedPrompt, "utf8")).toBe("# Drifted managed prompt\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the system target-dir wrapper inside its four isolated roots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-system-target-"));
    const targetRoot = path.join(root, "target");
    const fakeRealHome = path.join(root, "fake-real-home");
    const source = "npm:jorgex-pi@0.4.0";
    const sourceRoot = stackRoot();
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      delete process.env.PI_CODING_AGENT_DIR;
      vi.resetModules();
      vi.doMock("../src/lib/paths.js", async () => {
        const actual = await vi.importActual<typeof import("../src/lib/paths.js")>("../src/lib/paths.js");
        return {
          ...actual,
          HOME: fakeRealHome,
          dataDir: () => path.join(fakeRealHome, ".jorgex-stack"),
          stackRoot: () => sourceRoot,
        };
      });
      const mod = await import("../src/lib/pi-projection-lifecycle.js") as Partial<PiProjectionLifecycleSystem>;
      expect(mod.runPiProjectionLifecycleSystem).toBeTypeOf("function");
      const runPiProjectionLifecycleSystem = mod.runPiProjectionLifecycleSystem!;
      seedTarget(targetRoot, source);

      expect(runPiProjectionLifecycleSystem({
        operation: "install",
        targetDir: targetRoot,
        packageSource: source,
        engramBin: null,
        playwrightCliEnabled: false,
      })).toMatchObject({ kind: "installed" });

      expect(fs.existsSync(fakeRealHome)).toBe(false);
      expect(fs.readdirSync(targetRoot).sort()).toEqual(["backups", "home", "pi-agent", "state"]);
    } finally {
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      vi.doUnmock("../src/lib/paths.js");
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
