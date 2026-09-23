import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
});
