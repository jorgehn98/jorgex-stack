import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PiPackageReceipt,
  PiRuntimeCandidate,
} from "../src/lib/pi-package-lifecycle.js";

/**
 * T05 RED for T07 composed private-release activation (fresh install case;
 * legacy migration later). Tests only, no production change.
 *
 * Desired contract (GREEN in `src/lib/pi-install-activation.ts`):
 * - Export `activatePreparedPiInstall(input, deps)` where
 *   input = { homeDir, agentDir, receiptPath, engramBin,
 *     prepared: { candidate: PiRuntimeCandidate, stageDir, evidence },
 *     settingsJson, previousSource: string | null },
 *   deps = { verifyStage(stageDir, evidence), smokeStage(stageDir), verifyActive() },
 *   returns `{ kind: 'installed', receipt: PiPackageReceipt }`.
 * - Caller supplies REQUIRED verifyStage (recomputed inspectStagedPiNpm
 *   over lock/tree/six deps); the helper itself must:
 *   (a) run verifyStage BEFORE smokeStage and before plan/receipt writes
 *       or any active write,
 *   (b) plan via existing planPiManagedSettings (null on manual/ambiguous
 *       blocks before activation),
 *   (c) derive releaseId = SHA256(candidate.tarball.sha256 + ':' +
 *       evidence.lockSha256),
 *   (d) build schemaVersion 1 + managedPackage via existing
 *       createManagedPiReceipt with exact release/link/backup/deps,
 *   (e) invoke activateVerifiedPiRelease with nextSettings/nextReceipt and
 *       the verifyActive callback; return the receipt only after success,
 *       rollback (prior state restored) when verifyActive throws.
 *   No static candidate, no npm-root swap: only the owned relative link
 *   `npm/node_modules/jorgex-pi` moves; foreign packages survive
 *   byte-identically.
 *
 * Topology (real filesystem, os.tmpdir sandbox as fake home only, never
 * real HOME, no network):
 * - agentDir/npm/node_modules/foreign-pkg is foreign and must survive
 *   byte-identically; the shared npm root is never copied/replaced.
 * - stageDir is agentDir/stage-<32hex>/pi-agent holding a fake staged npm
 *   tree (staged jorgex-pi + one hoisted fixture standing in for the
 *   isolated Pi stage; six-dep evidence is the pre-verified inspector
 *   output, not re-resolved here).
 * - Candidate is synthetic stable 9.9.9 test-only with canonical six-dep
 *   evidence and valid digest shapes; never a claim about a published Pi
 *   release and never a next-version selector. No live Pi version JSON is
 *   asserted here.
 */

const SYNTHETIC_VERSION = "9.9.9";
const PREV_SOURCE = "npm:jorgex-pi@9.9.8";
const NEXT_SOURCE = `npm:jorgex-pi@${SYNTHETIC_VERSION}`;
const FOREIGN_ENTRY = "npm:foreign@1.0.0";

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const OLD_PI_INDEX = "// jorgex-pi 9.9.8 owned entry\nmodule.exports = 'old-pi';\n";
const NEW_PI_INDEX = "// jorgex-pi 9.9.9 staged entry\nmodule.exports = 'new-pi';\n";
const FOREIGN_INDEX = "// foreign package - must survive byte-identically\nmodule.exports = 'foreign';\n";
const HOISTED_INDEX = "// fake hoisted dep in the staged tree\nmodule.exports = 'hoisted';\n";

const OLD_RECEIPT = `${JSON.stringify({ schemaVersion: 1, state: "installed", note: "old-owned" })}\n`;

function syntheticHex(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${10 + index}`;
}

function managedEntry(source: string): { source: string; skills: never[]; prompts: never[] } {
  return { source, skills: [], prompts: [] };
}

type TestEvidence = {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
};

function syntheticCandidate(): PiRuntimeCandidate {
  return {
    package: {
      name: "jorgex-pi",
      version: SYNTHETIC_VERSION,
      source: NEXT_SOURCE,
    },
    provenance: { commit: syntheticHex("t07-activation-provenance").slice(0, 40) },
    tarball: {
      bytes: 424242,
      sha256: syntheticHex("t07-activation-tarball-sha256"),
      sha512: syntheticHex("t07-activation-tarball-a") + syntheticHex("t07-activation-tarball-b"),
    },
    pi: { testedVersions: ["0.87.1"] },
    contract: {
      schemaVersion: 1,
      capabilities: [],
      runner: {
        bin: "jorgex-pi",
        commands: [],
        schemaVersion: 1,
        maxStdoutBytes: 65_536,
      },
      managedExternalWrites: [],
    },
  };
}

function syntheticEvidence(): TestEvidence {
  return {
    lockSha256: syntheticHex("t07-activation-lock"),
    treeSha256: syntheticHex("t07-activation-tree"),
    dependencies: STAGED_DEP_NAMES.map((name, index) => ({
      name,
      version: syntheticDepVersion(index),
      integrity: syntheticIntegrity(31 + index),
    })),
  };
}

function expectedReleaseId(candidate: PiRuntimeCandidate, evidence: TestEvidence): string {
  return crypto
    .createHash("sha256")
    .update(`${candidate.tarball.sha256}:${evidence.lockSha256}`)
    .digest("hex");
}

type ActivateInput = {
  homeDir: string;
  agentDir: string;
  receiptPath: string;
  engramBin: string;
  prepared: {
    candidate: PiRuntimeCandidate;
    stageDir: string;
    evidence: TestEvidence;
  };
  settingsJson: string;
  previousSource: string | null;
  scopeKind?: "real" | "target-dir";
};

type ActivateDeps = {
  verifyStage: (stageDir: string, evidence: TestEvidence) => void | Promise<void>;
  smokeStage: (stageDir: string) => void | Promise<void>;
  verifyActive: () => void | Promise<void>;
};

type ActivateFn = (input: ActivateInput, deps: ActivateDeps) => Promise<{ kind: "installed"; receipt: PiPackageReceipt }>;

async function loadActivate(): Promise<ActivateFn> {
  // Static specifier keeps Vite's .js -> .ts resolution so GREEN resolves;
  // @ts-ignore keeps `pnpm typecheck` clean while the module is still
  // missing (RED), when the runtime import throws MODULE_NOT_FOUND.
  // @ts-ignore
  const mod = (await import("../src/lib/pi-install-activation.js")) as Record<string, unknown>;
  expect(mod["activatePreparedPiInstall"]).toBeTypeOf("function");
  return mod["activatePreparedPiInstall"] as ActivateFn;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Sandbox = {
  homeDir: string;
  agentDir: string;
  stageDir: string;
  receiptPath: string;
  settingsPath: string;
  linkPath: string;
  foreignIndex: string;
  engramBin: string;
  candidate: PiRuntimeCandidate;
  evidence: TestEvidence;
  releaseId: string;
};

function setupSandbox(opts: {
  withOldEntry: boolean;
  settingsJson: string;
  receiptContent: string | null;
}): Sandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-install-activation-"));
  sandboxes.push(sandbox);

  const homeDir = sandbox;
  const agentDir = path.join(homeDir, "agent");
  const stageHex = syntheticHex("jx-t07-activation-stage").slice(0, 32);
  const stageDir = path.join(agentDir, `stage-${stageHex}`, "pi-agent");
  const receiptPath = path.join(homeDir, "state", "pi-receipt.json");
  const settingsPath = path.join(agentDir, "settings.json");
  const linkPath = path.join(agentDir, "npm", "node_modules", "jorgex-pi");
  const foreignIndex = path.join(agentDir, "npm", "node_modules", "foreign-pkg", "index.js");
  const engramBin = path.join(sandbox, "bin", "engram");

  const candidate = syntheticCandidate();
  const evidence = syntheticEvidence();
  const releaseId = expectedReleaseId(candidate, evidence);
  expect(releaseId).toMatch(/^[0-9a-f]{64}$/);
  expect(candidate.package.source).toBe(NEXT_SOURCE);

  fs.mkdirSync(path.dirname(foreignIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(foreignIndex), "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
  fs.writeFileSync(foreignIndex, FOREIGN_INDEX);

  if (opts.withOldEntry) {
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"jorgex-pi","version":"9.9.8"}\n');
    fs.writeFileSync(path.join(linkPath, "index.js"), OLD_PI_INDEX);
  } else {
    fs.mkdirSync(path.join(agentDir, "npm", "node_modules"), { recursive: true });
  }

  fs.writeFileSync(settingsPath, opts.settingsJson);
  if (opts.receiptContent !== null) {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, opts.receiptContent);
  }

  const stagedPi = path.join(stageDir, "npm", "node_modules", "jorgex-pi");
  const stagedHoisted = path.join(stageDir, "npm", "node_modules", "fake-hoisted-dep");
  fs.mkdirSync(stagedPi, { recursive: true });
  fs.writeFileSync(path.join(stagedPi, "package.json"), `{"name":"jorgex-pi","version":"${SYNTHETIC_VERSION}"}\n`);
  fs.writeFileSync(path.join(stagedPi, "index.js"), NEW_PI_INDEX);
  fs.mkdirSync(stagedHoisted, { recursive: true });
  fs.writeFileSync(path.join(stagedHoisted, "package.json"), '{"name":"fake-hoisted-dep","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(stagedHoisted, "index.js"), HOISTED_INDEX);

  return { homeDir, agentDir, stageDir, receiptPath, settingsPath, linkPath, foreignIndex, engramBin, candidate, evidence, releaseId };
}

const FRESH_SETTINGS = JSON.stringify({ packages: [FOREIGN_ENTRY] });
const OWNED_SETTINGS = JSON.stringify({ packages: [FOREIGN_ENTRY, managedEntry(PREV_SOURCE)] });
const MANUAL_SETTINGS = JSON.stringify({ packages: [FOREIGN_ENTRY, PREV_SOURCE] });
const EDITED_SETTINGS = JSON.stringify({
  packages: [FOREIGN_ENTRY, { source: PREV_SOURCE, skills: ["custom"], prompts: [] }],
});

describe("pi install activation (T05 RED for T07 composed private release)", () => {
  it("smoke failure blocks before ANY active write, leaving old entry/settings/receipt and foreign byte-identical", async () => {
    const sb = setupSandbox({ withOldEntry: true, settingsJson: OWNED_SETTINGS, receiptContent: OLD_RECEIPT });
    const activate = await loadActivate();

    let verifyCalled = false;
    let smokeSeen: string | null = null;
    await expect(
      activate(
        {
          homeDir: sb.homeDir,
          agentDir: sb.agentDir,
          receiptPath: sb.receiptPath,
          engramBin: sb.engramBin,
          prepared: { candidate: sb.candidate, stageDir: sb.stageDir, evidence: sb.evidence },
          settingsJson: OWNED_SETTINGS,
          previousSource: PREV_SOURCE,
        },
        {
          verifyStage: () => undefined,
          smokeStage: (stageDir: string) => {
            smokeSeen = stageDir;
            throw new Error("stage-smoke-boom");
          },
          verifyActive: () => {
            verifyCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/stage-smoke-boom/);

    expect(smokeSeen).toBe(sb.stageDir);
    expect(verifyCalled).toBe(false);
    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(sb.linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(OWNED_SETTINGS);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(path.join(sb.stageDir, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(sb.agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
    expect(fs.existsSync(path.join(sb.stageDir, ".activate-backup"))).toBe(false);
  });

  it("verifyStage failure on a changed stage blocks before smoke or any active write", async () => {
    const sb = setupSandbox({ withOldEntry: true, settingsJson: OWNED_SETTINGS, receiptContent: OLD_RECEIPT });
    const activate = await loadActivate();

    let smokeCalled = false;
    let verifyCalled = false;
    await expect(
      activate(
        {
          homeDir: sb.homeDir,
          agentDir: sb.agentDir,
          receiptPath: sb.receiptPath,
          engramBin: sb.engramBin,
          prepared: { candidate: sb.candidate, stageDir: sb.stageDir, evidence: sb.evidence },
          settingsJson: OWNED_SETTINGS,
          previousSource: PREV_SOURCE,
        },
        {
          verifyStage: (stageDir: string, evidence: TestEvidence) => {
            expect(stageDir).toBe(sb.stageDir);
            expect(evidence).toEqual(sb.evidence);
            throw new Error("stage-changed-boom");
          },
          smokeStage: () => {
            smokeCalled = true;
          },
          verifyActive: () => {
            verifyCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/stage-changed-boom/);

    expect(smokeCalled).toBe(false);
    expect(verifyCalled).toBe(false);
    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(sb.linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(OWNED_SETTINGS);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(path.join(sb.stageDir, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(sb.agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
    expect(fs.existsSync(path.join(sb.stageDir, ".activate-backup"))).toBe(false);
    expect(
      fs.existsSync(path.join(sb.agentDir, "npm", "jorgex-pi-managed", "active-transaction.json")),
    ).toBe(false);
    expect(fs.existsSync(path.join(sb.agentDir, "npm", "jorgex-pi-managed", "transaction.lock"))).toBe(false);
  });

  it("fresh install publishes only the relative owned link plus v1 receipt/backup while foreign stays unchanged", async () => {
    const sb = setupSandbox({ withOldEntry: false, settingsJson: FRESH_SETTINGS, receiptContent: null });
    const activate = await loadActivate();

    let smokeSeen: string | null = null;
    let verifyCalled = false;
    const result = await activate(
      {
        homeDir: sb.homeDir,
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        engramBin: sb.engramBin,
        prepared: { candidate: sb.candidate, stageDir: sb.stageDir, evidence: sb.evidence },
        settingsJson: FRESH_SETTINGS,
        previousSource: null,
      },
      {
        verifyStage: () => undefined,
        smokeStage: (stageDir: string) => {
          smokeSeen = stageDir;
        },
        verifyActive: () => {
          verifyCalled = true;
        },
      },
    );

    expect(smokeSeen).toBe(sb.stageDir);
    expect(verifyCalled).toBe(true);
    expect(result.kind).toBe("installed");

    const receipt = result.receipt;
    expect(receipt.schemaVersion).toBe(1);
    const managed = receipt.managedPackage;
    expect(managed).toBeDefined();
    const expectedReleaseDir = path.join(sb.agentDir, "npm", "jorgex-pi-managed", "releases", sb.releaseId);
    const expectedLinkPath = path.join(sb.agentDir, "npm", "node_modules", "jorgex-pi");
    const expectedBackupDir = path.join(sb.stageDir, ".activate-backup");
    expect(managed?.releaseDir).toBe(expectedReleaseDir);
    expect(managed?.linkPath).toBe(expectedLinkPath);
    expect(managed?.backupDir).toBe(expectedBackupDir);
    expect(managed?.lockSha256).toBe(sb.evidence.lockSha256);
    expect(managed?.treeSha256).toBe(sb.evidence.treeSha256);
    expect(managed?.dependencies).toEqual(sb.evidence.dependencies);
    expect(receipt.candidate.package).toEqual(sb.candidate.package);
    expect(receipt.candidate.tarball).toEqual(sb.candidate.tarball);
    expect(receipt.candidate.provenance).toEqual(sb.candidate.provenance);
    expect(path.resolve(receipt.scope.codingAgentDir)).toBe(path.resolve(sb.agentDir));

    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(sb.linkPath)).toBe(
      `../jorgex-pi-managed/releases/${sb.releaseId}/node_modules/jorgex-pi`,
    );
    expect(fs.realpathSync(sb.linkPath)).toBe(path.join(expectedReleaseDir, "node_modules", "jorgex-pi"));
    expect(fs.readFileSync(path.join(expectedReleaseDir, "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    const settingsParsed = JSON.parse(fs.readFileSync(sb.settingsPath, "utf8")) as {
      packages: unknown[];
    };
    expect(settingsParsed.packages).toHaveLength(2);
    expect(settingsParsed.packages[0]).toBe(FOREIGN_ENTRY);
    expect(settingsParsed.packages[1]).toEqual(managedEntry(NEXT_SOURCE));
    expect(JSON.parse(fs.readFileSync(sb.receiptPath, "utf8"))).toEqual(receipt);
    expect(fs.lstatSync(expectedBackupDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("verify failure after publish restores the prior entry/settings/receipt byte-identically", async () => {
    const sb = setupSandbox({ withOldEntry: true, settingsJson: OWNED_SETTINGS, receiptContent: OLD_RECEIPT });
    const activate = await loadActivate();

    await expect(
      activate(
        {
          homeDir: sb.homeDir,
          agentDir: sb.agentDir,
          receiptPath: sb.receiptPath,
          engramBin: sb.engramBin,
          prepared: { candidate: sb.candidate, stageDir: sb.stageDir, evidence: sb.evidence },
          settingsJson: OWNED_SETTINGS,
          previousSource: PREV_SOURCE,
        },
        {
          verifyStage: () => undefined,
          smokeStage: () => undefined,
          verifyActive: () => {
            expect(fs.readlinkSync(sb.linkPath)).toBe(
              `../jorgex-pi-managed/releases/${sb.releaseId}/node_modules/jorgex-pi`,
            );
            throw new Error("active-verify-boom");
          },
        },
      ),
    ).rejects.toThrow(/active-verify-boom/);

    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(sb.linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(OWNED_SETTINGS);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("target-dir scope persists a target-dir receipt while keeping paths under the given home/agent roots", async () => {
    const sb = setupSandbox({ withOldEntry: false, settingsJson: FRESH_SETTINGS, receiptContent: null });
    const activate = await loadActivate();

    const result = await activate(
      {
        homeDir: sb.homeDir,
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        engramBin: sb.engramBin,
        prepared: { candidate: sb.candidate, stageDir: sb.stageDir, evidence: sb.evidence },
        settingsJson: FRESH_SETTINGS,
        previousSource: null,
        scopeKind: "target-dir",
      },
      {
        verifyStage: () => undefined,
        smokeStage: () => undefined,
        verifyActive: () => undefined,
      },
    );

    expect(result.kind).toBe("installed");
    expect(result.receipt.schemaVersion).toBe(1);
    expect(result.receipt.scope.kind).toBe("target-dir");
    expect(path.resolve(result.receipt.scope.codingAgentDir)).toBe(path.resolve(sb.agentDir));
    expect(path.relative(sb.homeDir, result.receipt.scope.codingAgentDir).startsWith("..")).toBe(false);
    expect(path.relative(sb.homeDir, sb.receiptPath).startsWith("..")).toBe(false);
    expect(JSON.parse(fs.readFileSync(sb.receiptPath, "utf8")).scope.kind).toBe("target-dir");
    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(sb.linkPath)).toBe(
      `../jorgex-pi-managed/releases/${sb.releaseId}/node_modules/jorgex-pi`,
    );
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("edited/manual settings block before activation without touching the active tree", async () => {
    const variants: Array<{ name: string; settingsJson: string }> = [
      { name: "manual-string", settingsJson: MANUAL_SETTINGS },
      { name: "edited-object", settingsJson: EDITED_SETTINGS },
    ];
    for (const variant of variants) {
      const sb = setupSandbox({
        withOldEntry: true,
        settingsJson: variant.settingsJson,
        receiptContent: OLD_RECEIPT,
      });
      const activate = await loadActivate();

      let verifyCalled = false;
      await expect(
        activate(
          {
            homeDir: sb.homeDir,
            agentDir: sb.agentDir,
            receiptPath: sb.receiptPath,
            engramBin: sb.engramBin,
            prepared: { candidate: sb.candidate, stageDir: sb.stageDir, evidence: sb.evidence },
            settingsJson: variant.settingsJson,
            previousSource: PREV_SOURCE,
          },
          {
            verifyStage: () => undefined,
            smokeStage: () => undefined,
            verifyActive: () => {
              verifyCalled = true;
            },
          },
        ),
        variant.name,
      ).rejects.toThrow(/settings|manual|ambiguous|managed/i);
      expect(verifyCalled, variant.name).toBe(false);

      expect(fs.lstatSync(sb.linkPath).isSymbolicLink(), variant.name).toBe(false);
      expect(fs.readFileSync(path.join(sb.linkPath, "index.js"), "utf8"), variant.name).toBe(OLD_PI_INDEX);
      expect(fs.readFileSync(sb.settingsPath, "utf8"), variant.name).toBe(variant.settingsJson);
      expect(fs.readFileSync(sb.receiptPath, "utf8"), variant.name).toBe(OLD_RECEIPT);
      expect(fs.readFileSync(sb.foreignIndex, "utf8"), variant.name).toBe(FOREIGN_INDEX);
      expect(fs.existsSync(path.join(sb.agentDir, "npm", "jorgex-pi-managed")), variant.name).toBe(false);
      expect(fs.existsSync(path.join(sb.stageDir, ".activate-backup")), variant.name).toBe(false);
    }
  });
});
