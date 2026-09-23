import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T05 fix-check for T07 safe managed Pi private-release topology (tests only).
 *
 * Code-facing contract under lock:
 *   activateVerifiedPiRelease({homeDir,agentDir,stageDir,releaseId,receiptPath,nextSettings,nextReceipt,verify})
 * in `src/lib/pi-private-release.ts`.
 *
 * Receipt boundary per T07 (latest): the managed receipt lives in
 * `~/.jorgex-stack/pi-receipt.json` (or `targetDir/state/pi-receipt.json`),
 * OUTSIDE `PI_CODING_AGENT_DIR`. Both agentDir and receiptPath must reside
 * within the homeDir/target boundary with non-symlink ancestors; no fake
 * stack receipt is ever placed under the Pi agent dir. The stable transaction
 * marker agentDir/npm/jorgex-pi-managed/active-transaction.json (guarded by
 * transaction.lock) records stage/backup and phase before the first mutation;
 * rollback revalidates the published link identity and settings/receipt bytes
 * before undoing, and drift reports recovery incomplete without touching
 * foreign state.
 *
 * Retained-backup note per T07: a backup of the previous
 * entry/settings/receipt stays recoverable after successful activation until
 * the lifecycle explicitly closes its rollback window; it is never deleted as
 * incidental cleanup, and a pending backup after a crash blocks with
 * `recovery: incomplete`.
 *
 * Topology under test (real filesystem, os.tmpdir sandbox as fake home only,
 * never real HOME, no network, no second install on the live tree):
 * - agentDir/npm/node_modules/jorgex-pi is the ONLY owned entry that may move.
 * - agentDir/npm/node_modules/foreign-pkg is foreign and must survive
 *   byte-identically; the shared npm root is never copied/replaced.
 * - stageDir is a private child of agentDir holding the verified npm tree
 *   (staged jorgex-pi + one fake hoisted dep standing in for the six native-Pi
 *   hoisted deps).
 * - Activation publishes exactly one relative symlink:
 *     npm/node_modules/jorgex-pi -> ../jorgex-pi-managed/releases/<releaseId>/node_modules/jorgex-pi
 *   writes next settings/receipt, runs injected verify, and on verify failure
 *   restores the previous entry/settings/receipt byte-identically.
 * - Local receipt coherence is NOT cryptographic ownership proof; the upstream
 *   caller validates ownership before calling (not asserted here).
 */

type ActivateInput = {
  homeDir: string;
  agentDir: string;
  stageDir: string;
  releaseId: string;
  receiptPath: string;
  nextSettings: string;
  nextReceipt: string;
  verify: () => void | Promise<void>;
};

type PrivateReleaseModule = {
  activateVerifiedPiRelease: (input: ActivateInput) => Promise<{ ok: true; releaseDir: string }>;
};

async function loadModule(): Promise<PrivateReleaseModule> {
  const mod = (await import("../src/lib/pi-private-release.js")) as Partial<PrivateReleaseModule>;
  expect(mod.activateVerifiedPiRelease).toBeTypeOf("function");
  return mod as PrivateReleaseModule;
}

// Deterministic 64-hex release id standing in for the caller-derived id from
// the verified artifact/lock (caller-owned derivation, not derived here).
const RELEASE_ID = crypto.createHash("sha256").update("jorgex-pi-verified-artifact-lock").digest("hex");
const RELEASE_ID2 = crypto.createHash("sha256").update("jorgex-pi-verified-artifact-lock-stage2").digest("hex");

const OLD_SETTINGS = `${JSON.stringify({ packages: ["npm:jorgex-pi@0.8.24-owned"], scope: "managed" }, null, 2)}\n`;
const OLD_RECEIPT = `${JSON.stringify({ schemaVersion: 2, release: "owned-previous", package: "jorgex-pi@0.8.24" }, null, 2)}\n`;
const NEXT_SETTINGS = `${JSON.stringify({ packages: ["managed:jorgex-pi-release"], scope: "managed" }, null, 2)}\n`;
const NEXT_RECEIPT = `${JSON.stringify({ schemaVersion: 2, release: "private-next", package: "jorgex-pi@0.8.30" }, null, 2)}\n`;
// Bytes of a non-cooperative external writer (Pi/npm): must never be deleted
// or overwritten by a rollback that is not theirs.
const FOREIGN_WRITER_SETTINGS = `${JSON.stringify({ packages: ["foreign-writer"], scope: "foreign" }, null, 2)}\n`;
const FOREIGN_WRITER_RECEIPT = `${JSON.stringify({ schemaVersion: 2, release: "foreign-writer", package: "foreign-pkg@9.9.9" }, null, 2)}\n`;

const OLD_PI_INDEX = "// jorgex-pi 0.8.24 owned entry\nmodule.exports = 'old-pi';\n";
const NEW_PI_INDEX = "// jorgex-pi 0.8.30 staged entry\nmodule.exports = 'new-pi';\n";
const FOREIGN_INDEX = "// foreign package - must survive byte-identically\nmodule.exports = 'foreign';\n";
const HOISTED_INDEX = "// fake hoisted dep resolvable from the release realpath\nmodule.exports = 'hoisted';\n";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Sandbox = {
  sandbox: string;
  homeDir: string;
  agentDir: string;
  stageDir: string;
  receiptPath: string;
  linkPath: string;
  foreignIndex: string;
};

function setupSandbox(): Sandbox {
  // The mkdtemp sandbox acts as the fake home boundary (never real HOME).
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-private-release-"));
  sandboxes.push(sandbox);

  const homeDir = sandbox;
  const agentDir = path.join(homeDir, "agent");
  // Private staging child of the agent dir (never HOME, never shared root).
  const stageDir = path.join(agentDir, "stage-isolated");
  // Managed receipt OUTSIDE the agent dir, sibling state dir inside the home
  // boundary (mirrors targetDir/state and ~/.jorgex-stack layouts).
  const receiptPath = path.join(homeDir, "state", "pi-receipt.json");
  const linkPath = path.join(agentDir, "npm", "node_modules", "jorgex-pi");
  const foreignIndex = path.join(agentDir, "npm", "node_modules", "foreign-pkg", "index.js");

  // Old owned entry (real directory, exact bytes).
  fs.mkdirSync(path.join(linkPath, "bin"), { recursive: true });
  fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"jorgex-pi","version":"0.8.24"}\n');
  fs.writeFileSync(path.join(linkPath, "index.js"), OLD_PI_INDEX);

  // Foreign package sharing the same npm root (must never move).
  fs.mkdirSync(path.dirname(foreignIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(foreignIndex), "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
  fs.writeFileSync(foreignIndex, FOREIGN_INDEX);

  // Exact old settings (owned, inside agentDir) and receipt (outside agentDir).
  fs.writeFileSync(path.join(agentDir, "settings.json"), OLD_SETTINGS);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, OLD_RECEIPT);

  // Verified staged tree: new Pi entry + one fake hoisted dep.
  const stagedPi = path.join(stageDir, "npm", "node_modules", "jorgex-pi");
  const stagedHoisted = path.join(stageDir, "npm", "node_modules", "fake-hoisted-dep");
  fs.mkdirSync(stagedPi, { recursive: true });
  fs.writeFileSync(path.join(stagedPi, "package.json"), '{"name":"jorgex-pi","version":"0.8.30"}\n');
  fs.writeFileSync(path.join(stagedPi, "index.js"), NEW_PI_INDEX);
  fs.mkdirSync(stagedHoisted, { recursive: true });
  fs.writeFileSync(path.join(stagedHoisted, "package.json"), '{"name":"fake-hoisted-dep","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(stagedHoisted, "index.js"), HOISTED_INDEX);

  return { sandbox, homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex };
}

function expectedLinkTarget(): string {
  return `../jorgex-pi-managed/releases/${RELEASE_ID}/node_modules/jorgex-pi`;
}

// Builds a second valid staged tree at an arbitrary private stage root without
// touching the shared setupSandbox fixture.
function writeValidStagedTree(stageRoot: string): void {
  const stagedPi = path.join(stageRoot, "npm", "node_modules", "jorgex-pi");
  const stagedHoisted = path.join(stageRoot, "npm", "node_modules", "fake-hoisted-dep");
  fs.mkdirSync(stagedPi, { recursive: true });
  fs.writeFileSync(path.join(stagedPi, "package.json"), '{"name":"jorgex-pi","version":"0.8.30"}\n');
  fs.writeFileSync(path.join(stagedPi, "index.js"), NEW_PI_INDEX);
  fs.mkdirSync(stagedHoisted, { recursive: true });
  fs.writeFileSync(path.join(stagedHoisted, "package.json"), '{"name":"fake-hoisted-dep","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(stagedHoisted, "index.js"), HOISTED_INDEX);
}

function expectHomeBoundary(homeDir: string, agentDir: string, receiptPath: string): void {
  // Both roots live within the home boundary, receipt outside the agent dir,
  // and no fake stack receipt hides under the Pi agent.
  expect(path.relative(homeDir, agentDir).startsWith("..")).toBe(false);
  expect(path.relative(homeDir, receiptPath).startsWith("..")).toBe(false);
  expect(path.relative(agentDir, receiptPath).startsWith("..")).toBe(true);
  expect(fs.existsSync(path.join(agentDir, "state", "pi-receipt.json"))).toBe(false);
  expect(fs.existsSync(path.join(agentDir, ".jorgex-stack"))).toBe(false);
}

describe("pi private-release activation (T05 fix-check for T07)", () => {
  it("restores the previous entry/settings/receipt byte-identically when verify fails after the symlink is published, keeping foreign packages intact", async () => {
    expect(RELEASE_ID).toMatch(/^[0-9a-f]{64}$/);
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expect(path.relative(agentDir, stageDir).startsWith("..")).toBe(false);
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    let observedLink: string | null = null;
    const verify = () => {
      // Ordering proof: verify must run only after the new symlink is published.
      observedLink = fs.readlinkSync(linkPath);
      throw new Error("smoke-boom");
    };

    await expect(
      activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify,
      }),
    ).rejects.toThrow(/smoke-boom/);
    expect(observedLink).toBe(expectedLinkTarget());

    // Previous owned entry restored as a real directory with exact bytes
    // (not left as the new symlink).
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);

    // Foreign package and shared npm root untouched: no copy/replace of the
    // entire shared npm root to promote the candidate.
    expect(fs.lstatSync(path.join(agentDir, "npm", "node_modules")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.dirname(foreignIndex)).isDirectory()).toBe(true);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("CONTROL: publishes only the relative release symlink, resolves the staged hoisted dep from the realpath, and leaves foreign packages unchanged", async () => {
    expect(RELEASE_ID).toMatch(/^[0-9a-f]{64}$/);
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir,
      releaseId: RELEASE_ID,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: () => undefined,
    });

    const releaseEntry = path.join(
      agentDir,
      "npm",
      "jorgex-pi-managed",
      "releases",
      RELEASE_ID,
      "node_modules",
      "jorgex-pi",
    );
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(expectedLinkTarget());
    expect(fs.realpathSync(linkPath)).toBe(releaseEntry);
    // The runner reports the release realpath, not the lexical symlink: the
    // staged hoisted dep must resolve as a sibling of that realpath.
    expect(
      fs.readFileSync(path.join(path.dirname(fs.realpathSync(linkPath)), "fake-hoisted-dep", "index.js"), "utf8"),
    ).toBe(HOISTED_INDEX);
    expect(fs.readFileSync(path.join(releaseEntry, "index.js"), "utf8")).toBe(NEW_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(NEXT_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(NEXT_RECEIPT);
    // T07: the previous entry/settings/receipt backup stays recoverable after
    // success until the lifecycle explicitly closes the rollback window.
    const backupDir = path.join(stageDir, ".activate-backup");
    expect(fs.lstatSync(path.join(backupDir, "entry")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(backupDir, "entry", "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(backupDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(path.join(backupDir, "receipt.json"), "utf8")).toBe(OLD_RECEIPT);
    // T07 §15: success removes the active marker and releases the lock — the
    // next install must not be blocked — while the old backup stays.
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    expect(fs.existsSync(path.join(managedRoot, "active-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(managedRoot, "transaction.lock"))).toBe(false);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);

    // A fresh stage proceeds immediately after success (no lingering marker).
    const stage2 = path.join(agentDir, "stage-fresh");
    writeValidStagedTree(stage2);
    const second = await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir: stage2,
      releaseId: RELEASE_ID2,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: () => undefined,
    });
    expect(second).toEqual({ ok: true, releaseDir: path.join(managedRoot, "releases", RELEASE_ID2) });
    expect(fs.readlinkSync(linkPath)).toBe(`../jorgex-pi-managed/releases/${RELEASE_ID2}/node_modules/jorgex-pi`);
    expect(fs.existsSync(path.join(managedRoot, "active-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(managedRoot, "transaction.lock"))).toBe(false);
    expect(fs.readFileSync(path.join(backupDir, "entry", "index.js"), "utf8")).toBe(OLD_PI_INDEX);
  });

  it("refuses to mutate when a previous stage .activate-backup is present, leaving old entry/settings/receipt and stage untouched without auto-deleting the backup", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    const backupDir = path.join(stageDir, ".activate-backup");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "marker.json"), '{"pending":true}\n');

    let verifyRan = false;
    const failure = await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir,
      releaseId: RELEASE_ID,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: () => {
        verifyRan = true;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");
    expect(String((failure as Error).message)).toMatch(/backup|incomplete|interrupted/i);
    expect(verifyRan).toBe(false);

    // Nothing mutated and the pending backup is never auto-deleted.
    expect(fs.readFileSync(path.join(backupDir, "marker.json"), "utf8")).toBe('{"pending":true}\n');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(path.join(stageDir, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
  });

  it("rejects a staged internal symlink that lexically escapes the staged npm tree, mutating nothing", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    // Lexical .bin link inside the stage whose effective target escapes the
    // staged npm tree (resolves to stageDir/escape-outside, outside stagedNpm).
    const binDir = path.join(stageDir, "npm", "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync("../../../escape-outside", path.join(binDir, "evil-tool"));

    let verifyRan = false;
    await expect(
      activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }),
    ).rejects.toThrow(/staged symlink|symlink chain|staged tree unreadable/i);
    expect(verifyRan).toBe(false);

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
  });

  it("rejects a staged symlink chain that is lexically contained but resolves outside the staged npm tree at use time, mutating nothing", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    // Intermediate link points at the staged root itself, so the lexical-only
    // check accepts it; the decoy makes path.resolve(pkg/s) land on a real
    // file inside the staged tree.
    const stagedModules = path.join(stageDir, "npm", "node_modules");
    const pkgDir = path.join(stagedModules, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.symlinkSync("../..", path.join(pkgDir, "x"));
    const decoyContent = "// lexical decoy inside staged npm\n";
    fs.writeFileSync(path.join(stagedModules, "y"), decoyContent);
    // Effective target lives in the sandbox but outside the staged npm tree.
    const outsideContent = "// outside staged npm, inside sandbox\n";
    fs.writeFileSync(path.join(agentDir, "y"), outsideContent);
    const chainLink = path.join(pkgDir, "s");
    fs.symlinkSync("x/../../y", chainLink);

    // Measured, not assumed: the lexical check sees the inside decoy while a
    // real open follows the chain outside (Node realpathSync agrees with the
    // lexical view here, so it cannot close this either).
    expect(path.resolve(pkgDir, fs.readlinkSync(chainLink))).toBe(path.join(stagedModules, "y"));
    expect(fs.readFileSync(chainLink, "utf8")).toBe(outsideContent);

    let verifyRan = false;
    await expect(
      activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }),
    ).rejects.toThrow(/staged symlink|symlink chain|escapes|realpath/i);
    expect(verifyRan).toBe(false);

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
  });

  it("blocks a receiptPath whose ancestor is a symlink leading outside the home boundary before any write", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    const { activateVerifiedPiRelease } = await loadModule();

    // Redirect the receipt's parent dir outside the home boundary; the lexical
    // receiptPath still looks contained. Separate temp dir, never real HOME.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-private-release-outside-"));
    sandboxes.push(outside);
    fs.writeFileSync(path.join(outside, "pi-receipt.json"), OLD_RECEIPT);
    fs.rmSync(path.dirname(receiptPath), { recursive: true, force: true });
    fs.symlinkSync(outside, path.dirname(receiptPath));
    expect(path.relative(homeDir, receiptPath).startsWith("..")).toBe(false);

    let verifyRan = false;
    await expect(
      activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }),
    ).rejects.toThrow(/receipt ancestor is a symlink|receipt is a symlink/i);
    expect(verifyRan).toBe(false);

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
    expect(fs.existsSync(path.join(stageDir, ".activate-backup"))).toBe(false);
  });

  it("does not blindly unlink/restore when an external writer replaced the published entry/settings/receipt during verify: rejects recovery incomplete and preserves foreign state plus recoverable backup", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    // Non-cooperative foreign state the rollback must not touch.
    const foreignReal = path.join(agentDir, "foreign-real");
    fs.mkdirSync(foreignReal, { recursive: true });
    fs.writeFileSync(path.join(foreignReal, "marker.txt"), "foreign writer state\n");

    const verify = () => {
      // Ordering proof: A published before the external writer intervened.
      expect(fs.readlinkSync(linkPath)).toBe(expectedLinkTarget());
      fs.unlinkSync(linkPath);
      fs.symlinkSync("../foreign-real", linkPath, "dir");
      fs.writeFileSync(path.join(agentDir, "settings.json"), FOREIGN_WRITER_SETTINGS);
      fs.writeFileSync(receiptPath, FOREIGN_WRITER_RECEIPT);
      throw new Error("verify-boom-foreign-writer");
    };

    const failure = await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir,
      releaseId: RELEASE_ID,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");

    // Foreign writer state preserved, A's recoverable backup preserved.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe("../foreign-real");
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(FOREIGN_WRITER_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(FOREIGN_WRITER_RECEIPT);
    expect(fs.readFileSync(path.join(stageDir, ".activate-backup", "entry", "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(stageDir, ".activate-backup", "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(path.join(stageDir, ".activate-backup", "receipt.json"), "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("blocks on a stale stable active-transaction marker before moving anything, preserving marker/old backup/foreign and the fresh stage", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();

    // Simulated crash after move: old backup exists, staged npm is gone.
    const backupDir = path.join(stageDir, ".activate-backup");
    fs.mkdirSync(path.join(backupDir, "entry"), { recursive: true });
    fs.writeFileSync(path.join(backupDir, "entry", "index.js"), OLD_PI_INDEX);
    fs.writeFileSync(path.join(backupDir, "settings.json"), OLD_SETTINGS);
    fs.writeFileSync(path.join(backupDir, "receipt.json"), OLD_RECEIPT);
    fs.rmSync(path.join(stageDir, "npm"), { recursive: true, force: true });
    // Stable marker per T07: agentDir/npm/jorgex-pi-managed/active-transaction.json.
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    fs.mkdirSync(managedRoot, { recursive: true });
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const markerContent = `${JSON.stringify({ stageDir, backupDir, releaseId: RELEASE_ID, phase: "staged-moved" }, null, 2)}\n`;
    fs.writeFileSync(markerPath, markerContent);
    // Fresh valid stage for the new attempt.
    const stage2 = path.join(agentDir, "stage-fresh");
    writeValidStagedTree(stage2);

    let verifyRan = false;
    const failure = await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir: stage2,
      releaseId: RELEASE_ID2,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: () => {
        verifyRan = true;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");
    expect(String((failure as Error).message)).toMatch(/transaction|incomplete|pending|crash|recover/i);
    expect(verifyRan).toBe(false);

    // Marker, old backup, foreign state and the fresh stage are all preserved;
    // no release was created and the old entry still stands.
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerContent);
    expect(fs.readFileSync(path.join(backupDir, "entry", "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(backupDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(path.join(backupDir, "receipt.json"), "utf8")).toBe(OLD_RECEIPT);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(path.join(stage2, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(managedRoot, "releases"))).toBe(false);
  });

  it("fails a second concurrent activation on the exclusive lock while the first verifies, preserving the first activation state", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    expect(RELEASE_ID2).not.toBe(RELEASE_ID);
    const { activateVerifiedPiRelease } = await loadModule();

    const stage2 = path.join(agentDir, "stage-fresh");
    writeValidStagedTree(stage2);
    const releaseEntry1 = path.join(
      agentDir,
      "npm",
      "jorgex-pi-managed",
      "releases",
      RELEASE_ID,
      "node_modules",
      "jorgex-pi",
    );

    let bFailure: unknown = null;
    let bRan = false;
    await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir,
      releaseId: RELEASE_ID,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: async () => {
        // B starts while A is inside verify with a valid fresh stage.
        bRan = true;
        bFailure = await activateVerifiedPiRelease({
          homeDir,
          agentDir,
          stageDir: stage2,
          releaseId: RELEASE_ID2,
          receiptPath,
          nextSettings: NEXT_SETTINGS,
          nextReceipt: NEXT_RECEIPT,
          verify: () => undefined,
        }).then(
          () => null,
          (error: unknown) => error,
        );
      },
    });

    // B was refused on the exclusive lock before moving anything; A completed.
    expect(bRan).toBe(true);
    expect(bFailure).toBeInstanceOf(Error);
    expect(String((bFailure as Error).message)).toMatch(/lock|transaction|exclusive|concurrent|active|busy/i);
    expect(fs.readlinkSync(linkPath)).toBe(expectedLinkTarget());
    expect(fs.realpathSync(linkPath)).toBe(releaseEntry1);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(NEXT_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(NEXT_RECEIPT);
    expect(fs.readFileSync(path.join(stage2, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed", "releases", RELEASE_ID2))).toBe(false);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("restores the first private-release symlink/settings/receipt byte-identically when verify fails during a second update with an existing private symlink", async () => {
    expect(RELEASE_ID).toMatch(/^[0-9a-f]{64}$/);
    expect(RELEASE_ID2).toMatch(/^[0-9a-f]{64}$/);
    expect(RELEASE_ID2).not.toBe(RELEASE_ID);
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expect(path.relative(agentDir, stageDir).startsWith("..")).toBe(false);
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    const nodeModulesDir = path.join(agentDir, "npm", "node_modules");

    // Stage 1: initial activation from the real owned directory succeeds.
    await activateVerifiedPiRelease({
      homeDir,
      agentDir,
      stageDir,
      releaseId: RELEASE_ID,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: () => undefined,
    });

    const releaseEntry1 = path.join(managedRoot, "releases", RELEASE_ID, "node_modules", "jorgex-pi");
    const oldLinkTarget = expectedLinkTarget();
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(oldLinkTarget);
    expect(fs.realpathSync(linkPath)).toBe(releaseEntry1);
    const oldSettings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
    const oldReceipt = fs.readFileSync(receiptPath, "utf8");
    expect(oldSettings).toBe(NEXT_SETTINGS);
    expect(oldReceipt).toBe(NEXT_RECEIPT);
    expect(fs.readFileSync(path.join(releaseEntry1, "index.js"), "utf8")).toBe(NEW_PI_INDEX);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(path.join(managedRoot, "active-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(managedRoot, "transaction.lock"))).toBe(false);

    // Stage 2: verified new release; verify runs only after the new link is published.
    const stage2 = path.join(agentDir, "stage-second");
    writeValidStagedTree(stage2);
    const stage2PiIndex = path.join(stage2, "npm", "node_modules", "jorgex-pi", "index.js");
    const stage2HoistedIndex = path.join(stage2, "npm", "node_modules", "fake-hoisted-dep", "index.js");
    expect(fs.readFileSync(stage2PiIndex, "utf8")).toBe(NEW_PI_INDEX);
    const expectedStage2Target = `../jorgex-pi-managed/releases/${RELEASE_ID2}/node_modules/jorgex-pi`;
    const secondSettings = `${JSON.stringify({ packages: ["managed:jorgex-pi-release-stage2"], scope: "managed" }, null, 2)}\n`;
    const secondReceipt = `${JSON.stringify({ schemaVersion: 2, release: "private-stage2", package: "jorgex-pi@0.8.31" }, null, 2)}\n`;
    expect(secondSettings).not.toBe(oldSettings);
    expect(secondReceipt).not.toBe(oldReceipt);

    let observedNewLink: string | null = null;
    const failingVerify = () => {
      // Guard-runtime ordering proof: the second link is already published.
      observedNewLink = fs.readlinkSync(linkPath);
      expect(observedNewLink).toBe(expectedStage2Target);
      throw new Error("second-smoke-boom");
    };

    await expect(
      activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir: stage2,
        releaseId: RELEASE_ID2,
        receiptPath,
        nextSettings: secondSettings,
        nextReceipt: secondReceipt,
        verify: failingVerify,
      }),
    ).rejects.toThrow(/second-smoke-boom/);
    expect(observedNewLink).toBe(expectedStage2Target);

    // Rollback restored the first private release byte-identically.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(oldLinkTarget);
    expect(fs.realpathSync(linkPath)).toBe(releaseEntry1);
    expect(fs.readFileSync(path.join(releaseEntry1, "index.js"), "utf8")).toBe(NEW_PI_INDEX);
    expect(
      fs.readFileSync(path.join(path.dirname(fs.realpathSync(linkPath)), "fake-hoisted-dep", "index.js"), "utf8"),
    ).toBe(HOISTED_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(oldSettings);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(oldReceipt);

    // Foreign npm root untouched and no marker/lock left behind.
    expect(fs.lstatSync(nodeModulesDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.dirname(foreignIndex)).isDirectory()).toBe(true);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(path.join(managedRoot, "active-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(managedRoot, "transaction.lock"))).toBe(false);

    // Second stage npm tree restored/preserved with exact bytes.
    expect(fs.readFileSync(stage2PiIndex, "utf8")).toBe(NEW_PI_INDEX);
    expect(fs.readFileSync(stage2HoistedIndex, "utf8")).toBe(HOISTED_INDEX);
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] activateVerifiedPiRelease enforces a caller previous-entry expectation.
// Contract (final security review, coordinator-closed handoff — exact shape
// chosen here for the implementer): the helper accepts an OPTIONAL
// `expectedPreviousEntry: { kind: "absent" }` (legacy callers without the field
// keep current behavior, so every existing test above stays compatible). When
// the caller declares absent, the helper must re-lstat the owned entry AFTER
// acquiring the exclusive lock but BEFORE any entry move: a TOCTOU arrival of
// an unowned real dir/symlink/file after the caller preflight must fail closed
// with zero moves, zero verify, no backup/release, and no dangling
// marker/lock. Isolated os.tmpdir sandbox only, no HOME/network. RED: the
// helper currently ignores the expectation and would back up + claim the
// arrived entry, so this test fails with success instead of rejection.
// ---------------------------------------------------------------------------

describe("pi private-release previous-entry expectation (T07 TOCTOU)", () => {
  it("RED: expectedPreviousEntry absent rejects a TOCTOU unowned arrival before any move, with no dangling marker/lock", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    const { activateVerifiedPiRelease } = await loadModule();
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");

    // Caller preflight saw NO entry; the owned entry is removed to model it.
    fs.rmSync(linkPath, { recursive: true, force: true });
    expect(fs.existsSync(linkPath)).toBe(false);

    // TOCTOU arrival after the caller preflight but before the transaction:
    // an unowned real directory the helper must never back up or claim.
    const unownedIndex = "// unowned TOCTOU arrival - must never be moved or claimed\n";
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"jorgex-pi","version":"9.9.8-manual"}\n');
    fs.writeFileSync(path.join(linkPath, "index.js"), unownedIndex);
    const beforeSettings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
    const beforeReceipt = fs.readFileSync(receiptPath, "utf8");
    const beforeForeign = fs.readFileSync(foreignIndex, "utf8");
    expect(beforeSettings).toBe(OLD_SETTINGS);
    expect(beforeReceipt).toBe(OLD_RECEIPT);

    let verifyRan = false;
    const input = {
      homeDir,
      agentDir,
      stageDir,
      releaseId: RELEASE_ID,
      receiptPath,
      nextSettings: NEXT_SETTINGS,
      nextReceipt: NEXT_RECEIPT,
      verify: () => {
        verifyRan = true;
      },
      // Exact handoff shape: optional expectation, absent kind only here.
      expectedPreviousEntry: { kind: "absent" },
    } as any;
    await expect(activateVerifiedPiRelease(input)).rejects.toThrow(
      /absent|expect|previous|entry|unowned|foreign/i,
    );
    expect(verifyRan).toBe(false);

    // Nothing moved or published: the arrived entry stands byte-identically as
    // a real dir (never a symlink, never backed up), settings/receipt/foreign
    // untouched, no release/backup, and no dangling cooperative state.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(unownedIndex);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(beforeSettings);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(beforeForeign);
    expect(fs.existsSync(path.join(managedRoot, "releases"))).toBe(false);
    expect(fs.existsSync(path.join(stageDir, ".activate-backup"))).toBe(false);
    expect(fs.existsSync(path.join(managedRoot, "active-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(managedRoot, "transaction.lock"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] activate faults on backup-dir mkdir AFTER lock+marker.
// Final silent-failure review: activateVerifiedPiRelease writes exclusive
// transaction.lock + active-transaction.json BEFORE fs.mkdirSync(backupDir);
// an ENOSPC/EACCES thrown there strands lock+marker with a generic failure.
// Fault-injection on real FS with the existing sandbox fixture only (never
// real HOME): ENOSPC on the exact sandbox .activate-backup path. RED: the
// marker/lock remain stranded with a generic error.
// ---------------------------------------------------------------------------
describe("pi private-release backup mkdir fault (T07 silent-failure RED)", () => {
  it("RED: ENOSPC creating .activate-backup throws without mutating state and leaves no dangling marker/lock", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    expect(homeDir.startsWith(os.tmpdir())).toBe(true);
    const { activateVerifiedPiRelease } = await loadModule();
    const backupDir = path.join(stageDir, ".activate-backup");
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const lockPath = path.join(managedRoot, "transaction.lock");
    const resolvedHome = path.resolve(homeDir);
    const resolvedBackup = path.resolve(backupDir);

    const originalMkdir = fs.mkdirSync;
    const spy = vi.spyOn(fs, "mkdirSync");
    spy.mockImplementation(((target: unknown, options: unknown) => {
      if (
        typeof target === "string" &&
        path.resolve(target) === resolvedBackup &&
        path.resolve(target).startsWith(resolvedHome)
      ) {
        const err = new Error(`ENOSPC: no space left on device, mkdir '${target}'`) as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      return (originalMkdir as typeof fs.mkdirSync)(target as string, options as never);
    }) as typeof fs.mkdirSync);

    let failure: unknown = null;
    let verifyRan = false;
    try {
      await activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }).then(
        () => null,
        (error: unknown) => {
          failure = error;
          return null;
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(verifyRan).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/ENOSPC/);

    // Backup never prepared and nothing mutated.
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(path.join(managedRoot, "releases"))).toBe(false);

    // Successful-cleanup case: cleanup via plain rm is possible, so the
    // failure stays ordinary (or explicit recovery complete), never
    // incomplete, with no dangling marker/lock. Incomplete with marker
    // preserved belongs only to a separate cleanup-failure seam (not added
    // here; one test at the strongest seam if valuable).
    expect((failure as Error & { recovery?: string }).recovery).not.toBe("incomplete");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] atomic settings rename fault after fsync+close.
// Silent-failure review: `atomicWritePrivate` fsync+close succeeds then
// `fs.renameSync(tmp, settings.json)` throws; the temporary `.tmp-*`
// remains with a private copy of settings while activation rolls back and
// reports recovery complete. Real-FS fault injection with the existing
// sandbox fixture only (never real HOME): EACCES on the exact
// agentDir/settings.json rename whose source basename is `.tmp-*`.
// RED: the orphan `.tmp-*` remains in agentDir.
// ---------------------------------------------------------------------------
describe("pi private-release atomic settings rename fault (T07 silent-failure RED)", () => {
  it("RED: EACCES renaming .tmp-* to settings.json after close rolls back byte-identically with no orphan .tmp-* in agentDir", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    expect(homeDir.startsWith(os.tmpdir())).toBe(true);
    const { activateVerifiedPiRelease } = await loadModule();
    const settingsPath = path.join(agentDir, "settings.json");
    const resolvedSettings = path.resolve(settingsPath);
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const lockPath = path.join(managedRoot, "transaction.lock");

    const originalRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync");
    let injected = false;
    spy.mockImplementation(((oldPath: unknown, newPath: unknown) => {
      if (
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        path.resolve(newPath) === resolvedSettings &&
        path.basename(oldPath).startsWith(".tmp-")
      ) {
        if (!injected) {
          injected = true;
          const err = new Error(
            `EACCES: permission denied, rename '${oldPath}' -> '${newPath}'`,
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
      }
      return (originalRename as typeof fs.renameSync)(oldPath as string, newPath as string);
    }) as typeof fs.renameSync);

    let failure: unknown = null;
    let verifyRan = false;
    try {
      await activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }).then(
        () => null,
        (error: unknown) => {
          failure = error;
          return null;
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(verifyRan).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/EACCES/);
    // Activation rolled back but reports recovery complete.
    expect((failure as Error & { recovery?: string }).recovery).toBe("complete");

    // Previous owned entry/settings/receipt restored byte-identically.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);

    // Foreign package untouched and no cooperative marker/lock left behind.
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);

    // No orphan private temp remains in agentDir.
    const orphans = fs.readdirSync(agentDir).filter((name) => name.startsWith(".tmp-"));
    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] backup-dir race between pre-lock check and post-lock mkdir.
// Coordinator race: activateVerifiedPiRelease checks stageDir/.activate-backup
// absent before the transaction, then `fs.mkdirSync(backupDir,{recursive:true})`
// after lock+marker; a non-cooperative writer can create that same dir+foreign
// sentinel in between, recursive mkdir succeeds, and a later
// `rmSync(backupDir,{recursive:true})` in abort/rollback would destroy the
// foreign sentinel. Real-FS injection with the existing sandbox fixture only
// (never real HOME): vi.spyOn(fs,'mkdirSync') for the exact .activate-backup
// call creates the dir+sentinel with the original mkdir/write just before the
// original call, then resumes. RED: current code proceeds to publish (or
// clobbers the sentinel on abort/rollback) instead of blocking.
// ---------------------------------------------------------------------------
describe("pi private-release backup-dir race (T07 TOCTOU RED)", () => {
  it("RED: foreign .activate-backup arrival between pre-check and post-lock mkdir blocks without moving state and never deletes the sentinel", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    expect(homeDir.startsWith(os.tmpdir())).toBe(true);
    const { activateVerifiedPiRelease } = await loadModule();
    const backupDir = path.join(stageDir, ".activate-backup");
    const sentinelPath = path.join(backupDir, "foreign-sentinel.txt");
    const SENTINEL = "// foreign writer sentinel - must never be deleted\n";
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const lockPath = path.join(managedRoot, "transaction.lock");
    const resolvedHome = path.resolve(homeDir);
    const resolvedBackup = path.resolve(backupDir);

    const originalMkdir = fs.mkdirSync;
    const originalWriteFile = fs.writeFileSync;
    const spy = vi.spyOn(fs, "mkdirSync");
    let injected = false;
    spy.mockImplementation(((target: unknown, options: unknown) => {
      if (
        typeof target === "string" &&
        path.resolve(target) === resolvedBackup &&
        path.resolve(target).startsWith(resolvedHome)
      ) {
        if (!injected) {
          injected = true;
          (originalMkdir as typeof fs.mkdirSync)(target as string, options as never);
          (originalWriteFile as typeof fs.writeFileSync)(sentinelPath, SENTINEL, "utf8");
        }
      }
      return (originalMkdir as typeof fs.mkdirSync)(target as string, options as never);
    }) as typeof fs.mkdirSync);

    let failure: unknown = null;
    let verifyRan = false;
    try {
      await activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }).then(
        () => null,
        (error: unknown) => {
          failure = error;
          return null;
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    // Activation must block before publishing: verify never runs.
    expect(verifyRan).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/backup|incomplete|interrupted|foreign|race|drift|exists|refus/i);

    // Old owned entry/settings/receipt untouched (no move, no replace).
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);

    // Foreign sentinel preserved: never deleted by abort/rollback cleanup.
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe(SENTINEL);

    // No stage/new release activated and foreign package intact.
    expect(fs.readFileSync(path.join(stageDir, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(managedRoot, "releases", RELEASE_ID))).toBe(false);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);

    // Marker/lock may clear safely when nothing mutated, or retain with
    // recovery incomplete on drift — but the sentinel above must survive.
    const recovery = (failure as Error & { recovery?: string }).recovery;
    if (recovery !== "incomplete") {
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] activation backup cleanup must delete only verified files actually
// created by its transaction. A non-cooperative writer plants a FOREIGN
// directory at the allowed basename backupDir/settings.json (with
// foreign-sentinel.txt inside) between Stack mkdir(stage/.activate-backup)
// and Stack wx-write of backupSettings; the Stack write then throws EISDIR.
// Fixed behavior: abort reports recovery incomplete, preserves marker/lock
// for manual recovery, preserves the foreign sentinel directory, and leaves
// old entry/settings/receipt/foreign byte-identical with no activation.
// RED: current isOwnBackupForCleanup accepts basenames only and recursive-rm
// deletes the sentinel while clearing marker/lock without incomplete.
// ---------------------------------------------------------------------------
describe("pi private-release backup settings foreign-directory drift (T07 cleanup RED)", () => {
  it("RED: foreign directory at backup settings.json basename blocks with incomplete and never deletes the sentinel", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    expect(homeDir.startsWith(os.tmpdir())).toBe(true);
    const { activateVerifiedPiRelease } = await loadModule();
    const backupDir = path.join(stageDir, ".activate-backup");
    const backupSettings = path.join(backupDir, "settings.json");
    const sentinelPath = path.join(backupSettings, "foreign-sentinel.txt");
    const SENTINEL = "// foreign writer dir sentinel - must never be deleted\n";
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const lockPath = path.join(managedRoot, "transaction.lock");
    const resolvedHome = path.resolve(homeDir);
    const resolvedBackupSettings = path.resolve(backupSettings);

    const originalMkdir = fs.mkdirSync;
    const originalWriteFile = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync");
    let injected = false;
    spy.mockImplementation(((target: unknown, content: unknown, options: unknown) => {
      if (
        typeof target === "string" &&
        path.resolve(target) === resolvedBackupSettings &&
        path.resolve(target).startsWith(resolvedHome)
      ) {
        if (!injected) {
          injected = true;
          (originalMkdir as typeof fs.mkdirSync)(target as string);
          (originalWriteFile as typeof fs.writeFileSync)(sentinelPath, SENTINEL, "utf8");
        }
      }
      return (originalWriteFile as typeof fs.writeFileSync)(
        target as string,
        content as string,
        options as never,
      );
    }) as typeof fs.writeFileSync);

    let failure: unknown = null;
    let verifyRan = false;
    try {
      await activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }).then(
        () => null,
        (error: unknown) => {
          failure = error;
          return null;
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(verifyRan).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");
    expect(String((failure as Error).message)).toMatch(/EISDIR|drift|incomplete|backup|foreign/i);

    // Foreign sentinel directory preserved: never deleted by abort cleanup.
    expect(fs.lstatSync(backupSettings).isDirectory()).toBe(true);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe(SENTINEL);

    // Old owned entry/settings/receipt untouched, no activation success.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(path.join(stageDir, "npm", "node_modules", "jorgex-pi", "index.js"), "utf8")).toBe(
      NEW_PI_INDEX,
    );
    expect(fs.existsSync(path.join(managedRoot, "releases", RELEASE_ID))).toBe(false);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);

    // Backup drift preserves cooperative marker/lock for manual recovery.
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] atomicWritePrivate rename failure plus temp cleanup failure must
// stay incomplete. EACCES on rename(tmp -> settings.json) followed by EACCES
// on rmSync(exact tmp) raises recovery incomplete; activation rollback may
// restore old state but MUST NOT overwrite incomplete to complete nor clear
// marker/lock/backup, and the tmp stays for manual inspection. Real-FS fault
// injection on the existing sandbox fixture only (never real HOME).
// RED: current rollback overwrites recovery to complete and clears
// marker/lock/backup.
// ---------------------------------------------------------------------------
describe("pi private-release atomic tmp cleanup failure (T07 incomplete RED)", () => {
  it("RED: EACCES rename plus EACCES rm of the exact tmp stays incomplete with marker/lock/backup/tmp retained", async () => {
    const { homeDir, agentDir, stageDir, receiptPath, linkPath, foreignIndex } = setupSandbox();
    expectHomeBoundary(homeDir, agentDir, receiptPath);
    expect(homeDir.startsWith(os.tmpdir())).toBe(true);
    const { activateVerifiedPiRelease } = await loadModule();
    const settingsPath = path.join(agentDir, "settings.json");
    const resolvedSettings = path.resolve(settingsPath);
    const managedRoot = path.join(agentDir, "npm", "jorgex-pi-managed");
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const lockPath = path.join(managedRoot, "transaction.lock");
    const backupDir = path.join(stageDir, ".activate-backup");

    const originalRename = fs.renameSync;
    const originalRm = fs.rmSync;
    let capturedTmp: string | null = null;
    const renameSpy = vi.spyOn(fs, "renameSync");
    const rmSpy = vi.spyOn(fs, "rmSync");
    let renameInjected = false;
    renameSpy.mockImplementation(((oldPath: unknown, newPath: unknown) => {
      if (
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        path.resolve(newPath) === resolvedSettings &&
        path.basename(oldPath).startsWith(".tmp-")
      ) {
        if (!renameInjected) {
          renameInjected = true;
          capturedTmp = oldPath as string;
          const err = new Error(
            `EACCES: permission denied, rename '${oldPath}' -> '${newPath}'`,
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
      }
      return (originalRename as typeof fs.renameSync)(oldPath as string, newPath as string);
    }) as typeof fs.renameSync);
    rmSpy.mockImplementation(((target: unknown, options: unknown) => {
      if (
        typeof target === "string" &&
        capturedTmp !== null &&
        path.resolve(target) === path.resolve(capturedTmp)
      ) {
        const err = new Error(`EACCES: permission denied, rm '${target}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (originalRm as typeof fs.rmSync)(target as string, options as never);
    }) as typeof fs.rmSync);

    let failure: unknown = null;
    let verifyRan = false;
    try {
      await activateVerifiedPiRelease({
        homeDir,
        agentDir,
        stageDir,
        releaseId: RELEASE_ID,
        receiptPath,
        nextSettings: NEXT_SETTINGS,
        nextReceipt: NEXT_RECEIPT,
        verify: () => {
          verifyRan = true;
        },
      }).then(
        () => null,
        (error: unknown) => {
          failure = error;
          return null;
        },
      );
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
    expect(renameInjected).toBe(true);
    expect(capturedTmp).not.toBeNull();
    expect(verifyRan).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");
    expect(String((failure as Error).message)).toMatch(/EACCES|cannot clean|incomplete/i);

    // Old owned entry/settings/receipt/foreign restored and preserved.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(OLD_PI_INDEX);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);

    // Incomplete evidence retained: marker/lock/backup plus the exact tmp.
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(true);
    expect(fs.readFileSync(path.join(backupDir, "settings.json"), "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(path.join(backupDir, "receipt.json"), "utf8")).toBe(OLD_RECEIPT);
    expect(capturedTmp!).toContain(".tmp-");
    expect(fs.existsSync(capturedTmp!)).toBe(true);
    expect(fs.lstatSync(capturedTmp!).isFile()).toBe(true);
  });
});
