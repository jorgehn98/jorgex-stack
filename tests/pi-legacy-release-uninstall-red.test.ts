// T07 RED legacy Pi uninstall (tests only, no prod change).
//
// Desired contract (GREEN implements in `src/lib/pi-private-release.ts`,
// same module as activation, same per-agent
// `npm/jorgex-pi-managed/transaction.lock` + `active-transaction.json`):
//   deactivateVerifiedLegacyPiEntry({homeDir,agentDir,receiptPath,
//     source,nextSettings,verify})
//     : { backupDir: string } (Stack-owned private backup, marker/lock cleared)
// Synchronous ONLY: `verify: () => void` runs inline after the owned
// removal (real fs readback); no Promise success may be claimed before the
// rollback decision. The helper NEVER calls Pi native `pi remove` nor swaps
// the shared npm root.
//
// Topology under test (real FS, os.tmpdir sandbox as fake home only, never
// real HOME, no network, no installed Pi):
// - agentDir/npm/node_modules/jorgex-pi is a REAL directory legacy install
//   with package.json name/version matching `source` (npm:jorgex-pi@0.8.24).
// - agentDir/npm/node_modules/foreign-pkg is foreign and must survive
//   byte-identically; agentDir/npm/package-lock.json is foreign root state
//   and must survive; the shared npm root is never copied/replaced.
// - settings.json holds the exact managed legacy object
//   `{source,skills:[],prompts:[]}` plus a foreign bare string; receipt v1
//   legacy (outside the agent dir, inside home) holds the 0.8.24 anchor from
//   prod pi-runtime-history.json with no managedPackage.
// - Success moves ONLY the owned entry + receipt into a unique Stack-owned
//   private backup under npm/jorgex-pi-managed, writes nextSettings verbatim
//   (legacy removed, foreign preserved), runs verify to confirm absence, and
//   retains the backup for rollback while clearing marker/lock.
// - Verify throw AFTER removal restores entry/settings/receipt
//   byte-identically with no dangling marker/lock and no foreign mutation.
// - External replacement during verify reports recovery incomplete, retains
//   backup/marker/lock, and never deletes the replacement.
// - A planted symlink at the legacy entry or any ancestor fails closed
//   before mutation.
//
// The 0.8.24 anchor is the prod history object, never a next-version selector.
// Only the managed-root marker/lock contract is asserted; no other backup
// layout internals are encoded (backups are located by content search).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import history from "../src/lib/pi-runtime-history.json" with { type: "json" };

type LegacyUninstallInput = {
  homeDir: string;
  agentDir: string;
  receiptPath: string;
  source: string;
  nextSettings: string;
  verify: () => void;
};

type LegacyUninstallResult = {
  readonly backupDir?: unknown;
  readonly kind?: unknown;
  readonly [key: string]: unknown;
};

type LegacyUninstallFn = (input: LegacyUninstallInput) => LegacyUninstallResult;

async function loadLegacyUninstall(): Promise<LegacyUninstallFn> {
  const mod = (await import("../src/lib/pi-private-release.js")) as Record<string, unknown>;
  expect(
    typeof mod["deactivateVerifiedLegacyPiEntry"],
    "missing export deactivateVerifiedLegacyPiEntry({homeDir,agentDir,receiptPath,source,nextSettings,verify})",
  ).toBe("function");
  return mod["deactivateVerifiedLegacyPiEntry"] as LegacyUninstallFn;
}

type HistoryCandidate = {
  readonly package: { readonly name: string; readonly version: string; readonly source: string };
  readonly provenance: { readonly commit: string };
  readonly tarball: { readonly bytes: number; readonly sha256: string; readonly sha512: string };
};

function historyCandidates(): readonly HistoryCandidate[] {
  const parsed = history as unknown as { readonly acceptedCandidates?: unknown };
  expect(Array.isArray(parsed.acceptedCandidates)).toBe(true);
  return parsed.acceptedCandidates as readonly HistoryCandidate[];
}

function historical024(): HistoryCandidate {
  const found = historyCandidates().find((entry) => entry.package.version === "0.8.24");
  expect(found, "prod history must expose the immutable 0.8.24 anchor").toBeDefined();
  if (found === undefined) throw new Error("historical 0.8.24 missing");
  expect(found.package).toEqual({ name: "jorgex-pi", version: "0.8.24", source: "npm:jorgex-pi@0.8.24" });
  return found;
}

const LEGACY_SOURCE = "npm:jorgex-pi@0.8.24";
const FOREIGN = "npm:foreign@1.0.0";

const LEGACY_INDEX = "// jorgex-pi 0.8.24 legacy entry - owned\nmodule.exports = 'legacy-pi';\n";
const FOREIGN_INDEX = "// foreign package - must survive byte-identically\nmodule.exports = 'foreign';\n";
const REPLACEMENT_INDEX = "// foreign writer replacement - must never be deleted\nmodule.exports = 'replacement';\n";
const NPM_LOCK_CONTENT = `{"name":"legacy-root","lockfileVersion":1,"note":"foreign-root-preserve"}\n`;

const FOREIGN_WRITER_SETTINGS = `${JSON.stringify({ packages: ["foreign-writer"], scope: "foreign" }, null, 2)}\n`;
const FOREIGN_WRITER_RECEIPT = `${JSON.stringify({ schemaVersion: 1, state: "foreign-writer" }, null, 2)}\n`;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type LegacySandbox = {
  homeDir: string;
  agentDir: string;
  npmDir: string;
  nodeModules: string;
  legacyEntry: string;
  legacyIndex: string;
  legacyManifest: string;
  foreignIndex: string;
  npmLock: string;
  settingsPath: string;
  receiptPath: string;
  managedRoot: string;
  markerPath: string;
  lockPath: string;
  oldSettings: string;
  nextSettings: string;
  oldReceipt: string;
};

function managedLegacyObject(source: string): { source: string; skills: never[]; prompts: never[] } {
  return { source, skills: [], prompts: [] };
}

function setupLegacySandbox(): LegacySandbox {
  const historical = historical024();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-legacy-uninstall-"));
  sandboxes.push(sandbox);
  expect(sandbox.startsWith(os.tmpdir())).toBe(true);
  expect(path.resolve(sandbox)).not.toBe(path.resolve(os.homedir()));

  const homeDir = sandbox;
  const agentDir = path.join(homeDir, "agent");
  const npmDir = path.join(agentDir, "npm");
  const nodeModules = path.join(npmDir, "node_modules");
  const legacyEntry = path.join(nodeModules, "jorgex-pi");
  const legacyIndex = path.join(legacyEntry, "index.js");
  const legacyManifest = path.join(legacyEntry, "package.json");
  const foreignIndex = path.join(nodeModules, "foreign-pkg", "index.js");
  const npmLock = path.join(npmDir, "package-lock.json");
  const settingsPath = path.join(agentDir, "settings.json");
  const receiptPath = path.join(homeDir, "state", "pi-receipt.json");
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const markerPath = path.join(managedRoot, "active-transaction.json");
  const lockPath = path.join(managedRoot, "transaction.lock");

  fs.mkdirSync(legacyEntry, { recursive: true });
  fs.writeFileSync(legacyManifest, `${JSON.stringify({ name: "jorgex-pi", version: "0.8.24" }, null, 2)}\n`);
  fs.writeFileSync(legacyIndex, LEGACY_INDEX);

  fs.mkdirSync(path.dirname(foreignIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(foreignIndex), "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
  fs.writeFileSync(foreignIndex, FOREIGN_INDEX);

  fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(npmLock, NPM_LOCK_CONTENT);

  const oldSettings = `${JSON.stringify({ theme: "custom", packages: [FOREIGN, managedLegacyObject(LEGACY_SOURCE)], extra: { note: "keep" } }, null, 2)}\n`;
  const nextSettings = `${JSON.stringify({ theme: "custom", packages: [FOREIGN], extra: { note: "keep" } }, null, 2)}\n`;
  expect(nextSettings).not.toContain(LEGACY_SOURCE);
  fs.writeFileSync(settingsPath, oldSettings);

  const engramBin = path.join(sandbox, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");
  const oldReceipt = `${JSON.stringify(
    {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { ...historical.package },
        tarball: { ...historical.tarball },
        provenance: { ...historical.provenance },
      },
      scope: { kind: "target-dir", codingAgentDir: agentDir },
      engram: { binary: engramBin },
    },
    null,
    2,
  )}\n`;
  expect(oldReceipt).toContain("0.8.24");
  expect(oldReceipt).not.toContain("managedPackage");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, oldReceipt);

  expect(path.relative(homeDir, agentDir).startsWith("..")).toBe(false);
  expect(path.relative(homeDir, receiptPath).startsWith("..")).toBe(false);
  expect(path.relative(agentDir, receiptPath).startsWith("..")).toBe(true);
  expect(fs.existsSync(path.join(agentDir, "state", "pi-receipt.json"))).toBe(false);
  expect(fs.lstatSync(legacyEntry).isDirectory()).toBe(true);
  expect(fs.lstatSync(legacyEntry).isSymbolicLink()).toBe(false);
  expect(fs.lstatSync(receiptPath).isFile()).toBe(true);
  expect(fs.lstatSync(receiptPath).isSymbolicLink()).toBe(false);

  return {
    homeDir,
    agentDir,
    npmDir,
    nodeModules,
    legacyEntry,
    legacyIndex,
    legacyManifest,
    foreignIndex,
    npmLock,
    settingsPath,
    receiptPath,
    managedRoot,
    markerPath,
    lockPath,
    oldSettings,
    nextSettings,
    oldReceipt,
  };
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function findFileWithContent(root: string, expected: string): string | null {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (st.isFile() && fs.readFileSync(full, "utf8") === expected) return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function backupDirFrom(result: LegacyUninstallResult): string {
  expect(result).not.toBeNull();
  expect(typeof result).toBe("object");
  expect(isThenable(result)).toBe(false);
  const backupDir = result.backupDir;
  expect(typeof backupDir).toBe("string");
  expect(path.isAbsolute(backupDir as string)).toBe(true);
  return backupDir as string;
}

describe("pi legacy release uninstall RED (T07)", () => {
  it("moves only the legacy entry and receipt into a private backup, writes nextSettings verbatim, and preserves foreign bytes without pi remove", async () => {
      const fn = await loadLegacyUninstall();
      const sb = setupLegacySandbox();

      expect(JSON.parse(fs.readFileSync(sb.legacyManifest, "utf8"))).toEqual({
        name: "jorgex-pi",
        version: "0.8.24",
      });
      expect(JSON.parse(sb.oldSettings)).toEqual({
        theme: "custom",
        packages: [FOREIGN, managedLegacyObject(LEGACY_SOURCE)],
        extra: { note: "keep" },
      });

      let verifyRan = false;
      const verify = (): void => {
        verifyRan = true;
        expect(lstatOrNull(sb.legacyEntry)).toBeNull();
        expect(fs.existsSync(sb.receiptPath)).toBe(false);
      };

      const result = fn({
        homeDir: sb.homeDir,
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        source: LEGACY_SOURCE,
        nextSettings: sb.nextSettings,
        verify,
      });
      const backupDir = backupDirFrom(result);

      expect(verifyRan).toBe(true);
      expect(path.relative(sb.homeDir, backupDir).startsWith("..")).toBe(false);
      expect(path.relative(sb.managedRoot, backupDir).startsWith("..")).toBe(false);
      expect(path.resolve(backupDir)).not.toBe(path.resolve(sb.legacyEntry));
      expect(path.resolve(backupDir)).not.toBe(path.resolve(sb.receiptPath));
      const backupStat = lstatOrNull(backupDir);
      expect(backupStat?.isDirectory()).toBe(true);
      expect(backupStat?.isSymbolicLink()).toBe(false);

      expect(lstatOrNull(sb.legacyEntry)).toBeNull();
      expect(fs.existsSync(sb.receiptPath)).toBe(false);
      expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.nextSettings);
      expect(fs.readFileSync(sb.settingsPath, "utf8")).not.toContain(LEGACY_SOURCE);
      expect(fs.readFileSync(sb.settingsPath, "utf8")).toContain(FOREIGN);

      expect(findFileWithContent(backupDir, LEGACY_INDEX)).not.toBeNull();
      expect(findFileWithContent(backupDir, sb.oldReceipt)).not.toBeNull();
      expect(fs.existsSync(backupDir)).toBe(true);

      expect(lstatOrNull(sb.markerPath)).toBeNull();
      expect(lstatOrNull(sb.lockPath)).toBeNull();

      expect(fs.lstatSync(sb.npmDir).isDirectory()).toBe(true);
      expect(fs.lstatSync(sb.npmDir).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(sb.nodeModules).isDirectory()).toBe(true);
      expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
      expect(fs.readFileSync(sb.npmLock, "utf8")).toBe(NPM_LOCK_CONTENT);
  });

  it("restores entry/settings/receipt byte-identically when verify throws, with no dangling marker/lock", async () => {
      const fn = await loadLegacyUninstall();
      const sb = setupLegacySandbox();
      const beforeManifest = fs.readFileSync(sb.legacyManifest, "utf8");

      let observedAfterRemoval = false;
      const verify = (): void => {
        expect(lstatOrNull(sb.legacyEntry)).toBeNull();
        expect(fs.existsSync(sb.receiptPath)).toBe(false);
        observedAfterRemoval = true;
        throw new Error("verify-boom-after-removal");
      };

      expect(() =>
        fn({
          homeDir: sb.homeDir,
          agentDir: sb.agentDir,
          receiptPath: sb.receiptPath,
          source: LEGACY_SOURCE,
          nextSettings: sb.nextSettings,
          verify,
        }),
      ).toThrow(/verify-boom-after-removal/);
      expect(observedAfterRemoval).toBe(true);

      expect(fs.lstatSync(sb.legacyEntry).isDirectory()).toBe(true);
      expect(fs.lstatSync(sb.legacyEntry).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(sb.legacyIndex, "utf8")).toBe(LEGACY_INDEX);
      expect(fs.readFileSync(sb.legacyManifest, "utf8")).toBe(beforeManifest);
      expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.oldSettings);
      expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(sb.oldReceipt);

      expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
      expect(fs.readFileSync(sb.npmLock, "utf8")).toBe(NPM_LOCK_CONTENT);

      expect(lstatOrNull(sb.markerPath)).toBeNull();
      expect(lstatOrNull(sb.lockPath)).toBeNull();
  });

  it("fails recovery incomplete and retains backup/marker/lock without deleting an external replacement during verify", async () => {
      const fn = await loadLegacyUninstall();
      const sb = setupLegacySandbox();

      let observedAfterRemoval = false;
      const verify = (): void => {
        expect(lstatOrNull(sb.legacyEntry)).toBeNull();
        expect(fs.existsSync(sb.receiptPath)).toBe(false);
        observedAfterRemoval = true;
        fs.mkdirSync(sb.legacyEntry, { recursive: true });
        fs.writeFileSync(path.join(sb.legacyEntry, "index.js"), REPLACEMENT_INDEX);
        fs.writeFileSync(sb.settingsPath, FOREIGN_WRITER_SETTINGS);
        fs.writeFileSync(sb.receiptPath, FOREIGN_WRITER_RECEIPT);
        throw new Error("verify-boom-foreign-writer");
      };

      let failure: unknown = null;
      try {
        fn({
          homeDir: sb.homeDir,
          agentDir: sb.agentDir,
          receiptPath: sb.receiptPath,
          source: LEGACY_SOURCE,
          nextSettings: sb.nextSettings,
          verify,
        });
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");
      expect(String((failure as Error).message)).toMatch(/incomplete|drift|foreign|recovery/i);
      expect(observedAfterRemoval).toBe(true);

      expect(fs.readFileSync(path.join(sb.legacyEntry, "index.js"), "utf8")).toBe(REPLACEMENT_INDEX);
      expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(FOREIGN_WRITER_SETTINGS);
      expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(FOREIGN_WRITER_RECEIPT);

      expect(findFileWithContent(sb.managedRoot, LEGACY_INDEX)).not.toBeNull();
      expect(findFileWithContent(sb.managedRoot, sb.oldReceipt)).not.toBeNull();
      expect(lstatOrNull(sb.markerPath)).not.toBeNull();
      expect(lstatOrNull(sb.lockPath)).not.toBeNull();

      expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
      expect(fs.readFileSync(sb.npmLock, "utf8")).toBe(NPM_LOCK_CONTENT);
  });

  it("fails closed before mutation when the legacy entry or an ancestor is a planted symlink", async () => {
      const fn = await loadLegacyUninstall();

      {
        const sb = setupLegacySandbox();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-legacy-outside-"));
        sandboxes.push(outside);
        const realTarget = path.join(outside, "real-target");
        fs.mkdirSync(realTarget, { recursive: true });
        fs.writeFileSync(path.join(realTarget, "package.json"), '{"name":"jorgex-pi","version":"0.8.24"}\n');
        fs.rmSync(sb.legacyEntry, { recursive: true, force: true });
        fs.symlinkSync(realTarget, sb.legacyEntry, "dir");
        expect(fs.lstatSync(sb.legacyEntry).isSymbolicLink()).toBe(true);

        let verifyRan = false;
        expect(() =>
          fn({
            homeDir: sb.homeDir,
            agentDir: sb.agentDir,
            receiptPath: sb.receiptPath,
            source: LEGACY_SOURCE,
            nextSettings: sb.nextSettings,
            verify: () => {
              verifyRan = true;
            },
          }),
        ).toThrow(/symlink|real directory|managed entry|ancestor|owner/i);
        expect(verifyRan).toBe(false);

        expect(fs.lstatSync(sb.legacyEntry).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.oldSettings);
        expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(sb.oldReceipt);
        expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
        expect(lstatOrNull(sb.markerPath)).toBeNull();
        expect(lstatOrNull(sb.lockPath)).toBeNull();
      }

      {
        const sb = setupLegacySandbox();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-legacy-ancestor-"));
        sandboxes.push(outside);
        fs.rmSync(sb.nodeModules, { recursive: true, force: true });
        fs.symlinkSync(outside, sb.nodeModules, "dir");
        expect(fs.lstatSync(sb.nodeModules).isSymbolicLink()).toBe(true);

        let verifyRan = false;
        expect(() =>
          fn({
            homeDir: sb.homeDir,
            agentDir: sb.agentDir,
            receiptPath: sb.receiptPath,
            source: LEGACY_SOURCE,
            nextSettings: sb.nextSettings,
            verify: () => {
              verifyRan = true;
            },
          }),
        ).toThrow(/symlink|real directory|ancestor|node_modules|owner/i);
        expect(verifyRan).toBe(false);

        expect(fs.lstatSync(sb.nodeModules).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.oldSettings);
        expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(sb.oldReceipt);
        expect(lstatOrNull(sb.markerPath)).toBeNull();
        expect(lstatOrNull(sb.lockPath)).toBeNull();
      }
  });
});
