import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";

export interface ActivateVerifiedPiReleaseInput {
  homeDir: string;
  agentDir: string;
  stageDir: string;
  releaseId: string;
  receiptPath: string;
  nextSettings: string;
  nextReceipt: string;
  verify: () => void | Promise<void>;
  expectedPreviousEntry?: { kind: "absent" };
}

export type ActivateVerifiedPiReleaseResult = { ok: true; releaseDir: string };

const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/;
const EXPECTED_ENTRY = "jorgex-pi";

function resolved(p: string): string {
  return path.resolve(p);
}

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(resolved(root), resolved(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function assertStrictChild(child: string, root: string, label: string): void {
  if (!isStrictChild(child, root)) {
    throw new Error(`${label} escapes its owner root: ${child}`);
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function failIncomplete(reason: string): never {
  const err = new Error(reason) as Error & { recovery: string };
  err.recovery = "incomplete";
  throw err;
}

/** Every existing ancestor from dir up to stop (inclusive) must not be a symlink. */
function assertAncestorsClean(dir: string, stop: string, label: string): void {
  const stopResolved = resolved(stop);
  let cur = resolved(dir);
  if (!isStrictChild(cur, stopResolved) && cur !== stopResolved) {
    throw new Error(`${label} escapes owner root: ${dir}`);
  }
  for (;;) {
    const st = lstatOrNull(cur);
    if (st !== null && st.isSymbolicLink()) {
      throw new Error(`${label} ancestor is a symlink: ${cur}`);
    }
    if (cur === stopResolved) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    if (cur.length < stopResolved.length) break;
  }
}

/** File itself must not be a symlink and its dirname ancestors must be clean. */
function assertFilePathClean(file: string, stop: string, label: string): void {
  assertStrictChild(file, stop, label);
  const st = lstatOrNull(resolved(file));
  if (st !== null && st.isSymbolicLink()) {
    throw new Error(`${label} is a symlink: ${file}`);
  }
  assertAncestorsClean(path.dirname(resolved(file)), stop, label);
}

function assertDirClean(dir: string, stop: string, label: string): void {
  assertStrictChild(dir, stop, label);
  const st = lstatOrNull(resolved(dir));
  if (st !== null && st.isSymbolicLink()) {
    throw new Error(`${label} is a symlink: ${dir}`);
  }
  assertAncestorsClean(resolved(dir), stop, label);
}

/**
 * Physical symlink check: walk the raw relative target component by component
 * from the link parent with lstat, never following. Rejects absolute targets,
 * lexical escapes, broken entries, ANY symlink at an intermediate or final
 * component (chains/cycles), and wrong final kind. Containment is verified
 * before every lstat so no path outside the root is ever read.
 */
function assertLinkInsideRoot(
  linkPath: string,
  allowedRoot: string,
  label: string,
  finalKind: "file" | "dir",
): void {
  const allowedResolved = resolved(allowedRoot);
  const linkParent = path.dirname(resolved(linkPath));
  if (linkParent !== allowedResolved && !isStrictChild(linkParent, allowedResolved)) {
    throw new Error(`${label} escapes owner root: ${linkPath}`);
  }
  let target: string;
  try {
    target = fs.readlinkSync(linkPath);
  } catch {
    throw new Error(`${label} is broken or unreadable: ${linkPath}`);
  }
  if (target === "" || path.isAbsolute(target)) {
    throw new Error(`${label} must be a relative symlink: ${linkPath}`);
  }
  const parentStat = lstatOrNull(linkParent);
  if (parentStat === null || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`${label} parent is not a real directory: ${linkPath}`);
  }
  const ops = target.split("/").filter((part) => part !== "" && part !== ".");
  if (ops.length === 0) {
    throw new Error(`${label} must point inside owner root: ${linkPath} -> ${target}`);
  }
  let cur = linkParent;
  for (let i = 0; i < ops.length; i++) {
    const part = ops[i] as string;
    const isLast = i === ops.length - 1;
    if (part === "..") {
      cur = path.dirname(cur);
      if (cur !== allowedResolved && !isStrictChild(cur, allowedResolved)) {
        throw new Error(`${label} escapes owner root: ${linkPath} -> ${target}`);
      }
      const st = lstatOrNull(cur);
      if (st === null) {
        throw new Error(`${label} is broken: ${linkPath} -> ${target}`);
      }
      if (st.isSymbolicLink()) {
        throw new Error(`${label} is a symlink chain: ${linkPath} -> ${target}`);
      }
      if (isLast) {
        if (finalKind === "file") {
          throw new Error(`${label} must point to a regular file: ${linkPath} -> ${target}`);
        }
        if (!st.isDirectory()) {
          throw new Error(`${label} must point to a directory: ${linkPath} -> ${target}`);
        }
      } else if (!st.isDirectory()) {
        throw new Error(`${label} points through a non-directory: ${linkPath} -> ${target}`);
      }
      continue;
    }
    const next = path.join(cur, part);
    if (next !== allowedResolved && !isStrictChild(next, allowedResolved)) {
      throw new Error(`${label} escapes owner root: ${linkPath} -> ${target}`);
    }
    const st = lstatOrNull(next);
    if (st === null) {
      throw new Error(`${label} is broken: ${linkPath} -> ${target}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`${label} is a symlink chain: ${linkPath} -> ${target}`);
    }
    if (isLast) {
      if (finalKind === "file") {
        if (!st.isFile()) {
          throw new Error(`${label} must point to a regular file: ${linkPath} -> ${target}`);
        }
      } else if (!st.isDirectory()) {
        throw new Error(`${label} must point to a directory: ${linkPath} -> ${target}`);
      }
    } else {
      if (!st.isDirectory()) {
        throw new Error(`${label} points through a non-directory: ${linkPath} -> ${target}`);
      }
      cur = next;
    }
  }
}

/**
 * Staged links must point to a regular file inside the staged npm root.
 * A lexical path.resolve check is insufficient: an intermediate staged
 * symlink plus `..` can resolve inside lexically while the kernel opens
 * outside physically (Node realpathSync agrees with the lexical view here),
 * so every component is lstatted physically without following.
 * Direct npm .bin links (`../pkg/bin/file` through real dirs) stay accepted.
 */
function assertInternalSymlink(linkPath: string, allowedRoot: string, label: string): void {
  assertLinkInsideRoot(linkPath, allowedRoot, label, "file");
}

/** The managed active entry legitimately points to a release directory. */
function assertManagedEntrySymlink(linkPath: string, allowedRoot: string, label: string): void {
  assertLinkInsideRoot(linkPath, allowedRoot, label, "dir");
}

function validateStageTree(stagedNpm: string): void {
  const root = resolved(stagedNpm);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new Error(`staged tree unreadable: ${dir}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        assertInternalSymlink(full, root, "staged symlink");
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

/**
 * Atomic private write: random temp + O_EXCL in the same dir + rename.
 * Never reuses predictable temporaries and never follows a planted symlink:
 * callers validate ancestors first and the temp name is unguessable.
 */
function atomicWritePrivate(target: string, content: string): void {
  const dir = path.dirname(resolved(target));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(16).toString("hex")}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      fs.rmSync(tmp, { force: true });
    }
  }
  const tmpStat = lstatOrNull(tmp);
  if (tmpStat === null || !tmpStat.isFile()) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      failIncomplete(`cannot clean private temp (recovery incomplete): ${tmp}`);
    }
    throw new Error(`private temp is not a regular file: ${target}`);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      const original = err instanceof Error ? err.message : String(err ?? "rename failed");
      failIncomplete(`cannot clean private temp after rename failure (recovery incomplete): ${tmp}: ${original}`);
    }
    throw err;
  }
}

export async function activateVerifiedPiRelease(
  input: ActivateVerifiedPiReleaseInput,
): Promise<ActivateVerifiedPiReleaseResult> {
  const homeDir = resolved(input.homeDir);
  const agentDir = resolved(input.agentDir);
  const stageDir = resolved(input.stageDir);
  const receiptPath = resolved(input.receiptPath);
  const releaseId = input.releaseId;

  if (typeof input.homeDir !== "string" || input.homeDir === "") {
    throw new Error(`homeDir must be a non-empty absolute path`);
  }
  if (!path.isAbsolute(input.homeDir)) {
    throw new Error(`homeDir must be absolute: ${input.homeDir}`);
  }

  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`releaseId must be 64 lowercase hex`);
  }
  if (typeof input.nextSettings !== "string" || typeof input.nextReceipt !== "string") {
    throw new Error(`nextSettings and nextReceipt must be strings`);
  }
  if (typeof input.verify !== "function") {
    throw new Error(`verify must be a function`);
  }

  const homeStat = lstatOrNull(homeDir);
  if (homeStat === null || !homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error(`homeDir must be a real directory: ${input.homeDir}`);
  }

  if (!isStrictChild(agentDir, homeDir)) {
    throw new Error(`agentDir must live within the homeDir boundary`);
  }
  if (!isStrictChild(receiptPath, homeDir)) {
    throw new Error(`receiptPath must live within the homeDir boundary`);
  }
  if (receiptPath === agentDir || isStrictChild(receiptPath, agentDir)) {
    throw new Error(`receiptPath must live outside the agent dir`);
  }
  const agentStat = lstatOrNull(agentDir);
  if (agentStat === null || !agentStat.isDirectory() || agentStat.isSymbolicLink()) {
    throw new Error(`agentDir must be a real directory: ${input.agentDir}`);
  }

  if (!isStrictChild(stageDir, agentDir)) {
    throw new Error(`stageDir must be a private child of agentDir`);
  }
  const stageStat = lstatOrNull(stageDir);
  if (stageStat === null || !stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    throw new Error(`stageDir must be a real directory: ${input.stageDir}`);
  }

  const settingsPath = path.join(agentDir, "settings.json");
  const npmDir = path.join(agentDir, "npm");
  const nodeModules = path.join(npmDir, "node_modules");
  const linkPath = path.join(nodeModules, EXPECTED_ENTRY);
  const stagedNpm = path.join(stageDir, "npm");
  const stagedModules = path.join(stagedNpm, "node_modules");
  const stagedEntry = path.join(stagedModules, EXPECTED_ENTRY);
  const releaseRoot = path.join(npmDir, "jorgex-pi-managed", "releases");
  const releaseDir = path.join(releaseRoot, releaseId);
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const markerPath = path.join(managedRoot, "active-transaction.json");
  const lockPath = path.join(managedRoot, "transaction.lock");
  const backupDir = path.join(stageDir, ".activate-backup");
  const backupEntry = path.join(backupDir, "entry");
  const backupSettings = path.join(backupDir, "settings.json");
  const backupReceipt = path.join(backupDir, "receipt.json");
  const expectedTarget = `../jorgex-pi-managed/releases/${releaseId}/node_modules/${EXPECTED_ENTRY}`;

  assertStrictChild(agentDir, homeDir, "agentDir");
  assertStrictChild(receiptPath, homeDir, "receiptPath");
  assertStrictChild(releaseDir, agentDir, "releaseDir");
  assertStrictChild(managedRoot, agentDir, "managed root");
  assertStrictChild(backupDir, stageDir, "backupDir");
  assertStrictChild(linkPath, agentDir, "managed entry");
  assertStrictChild(stagedNpm, stageDir, "staged npm tree");

  assertAncestorsClean(agentDir, homeDir, "agentDir");
  assertDirClean(stageDir, homeDir, "stageDir");
  assertAncestorsClean(npmDir, homeDir, "npm root");
  assertAncestorsClean(nodeModules, homeDir, "node_modules");
  assertAncestorsClean(releaseRoot, homeDir, "release root");
  assertFilePathClean(settingsPath, homeDir, "settings.json");
  assertFilePathClean(receiptPath, homeDir, "receipt");

  const npmStat = lstatOrNull(npmDir);
  if (npmStat === null || !npmStat.isDirectory() || npmStat.isSymbolicLink()) {
    throw new Error(`npm root must be a real directory: ${npmDir}`);
  }
  const modulesStat = lstatOrNull(nodeModules);
  if (modulesStat === null || !modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
    throw new Error(`node_modules must be a real directory: ${nodeModules}`);
  }

  // Stable transaction state is consulted before staged validation and before
  // any mutation. Pure lstat probes only; the managed root itself is checked
  // first so a planted symlink is never followed into outside paths.
  const managedPreStat = lstatOrNull(managedRoot);
  if (managedPreStat !== null && (managedPreStat.isSymbolicLink() || !managedPreStat.isDirectory())) {
    throw new Error(`managed root must be a real directory: ${managedRoot}`);
  }
  const pendingLock = lstatOrNull(lockPath) !== null;
  const pendingMarker = lstatOrNull(markerPath) !== null;
  if (pendingLock) {
    failIncomplete(`transaction lock busy: concurrent activation holds the exclusive lock (recovery incomplete): ${lockPath}`);
  }
  if (pendingMarker) {
    failIncomplete(`active transaction pending from a prior crash: refusing to mutate (recovery incomplete): ${markerPath}`);
  }

  const stagedNpmStat = lstatOrNull(stagedNpm);
  if (stagedNpmStat === null || !stagedNpmStat.isDirectory() || stagedNpmStat.isSymbolicLink()) {
    throw new Error(`staged npm tree must be a real directory: ${stagedNpm}`);
  }
  assertAncestorsClean(stagedNpm, homeDir, "staged npm tree");
  const stagedEntryStat = lstatOrNull(stagedEntry);
  if (stagedEntryStat === null || stagedEntryStat.isSymbolicLink()) {
    throw new Error(`staged entry must be a real directory: ${stagedEntry}`);
  }
  if (!stagedEntryStat.isDirectory()) {
    throw new Error(`staged entry must be a real directory: ${stagedEntry}`);
  }
  validateStageTree(stagedNpm);

  const linkStat = lstatOrNull(linkPath);
  let oldEntryExisted = false;
  if (linkStat !== null) {
    oldEntryExisted = true;
    assertAncestorsClean(path.dirname(linkPath), homeDir, "managed entry");
    if (linkStat.isSymbolicLink()) {
      assertManagedEntrySymlink(linkPath, npmDir, "managed entry");
    } else if (!linkStat.isDirectory()) {
      throw new Error(`managed entry must be a directory or internal symlink: ${linkPath}`);
    }
  }

  if (lstatOrNull(releaseDir) !== null) {
    throw new Error(`release already exists: ${releaseDir}`);
  }
  if (lstatOrNull(backupDir) !== null) {
    failIncomplete(`interrupted backup present, refusing to mutate: ${backupDir}`);
  }

  let oldSettings: string | null = null;
  let oldReceipt: string | null = null;
  try {
    if (lstatOrNull(settingsPath) !== null) {
      oldSettings = fs.readFileSync(settingsPath, "utf8");
    }
    if (lstatOrNull(receiptPath) !== null) {
      oldReceipt = fs.readFileSync(receiptPath, "utf8");
    }
  } catch {
    throw new Error(`cannot read previous settings/receipt`);
  }

  let lockAcquired = false;
  let backupCreated = false;
  const releaseLock = (): void => {
    if (!lockAcquired) return;
    fs.rmSync(lockPath, { force: true });
    lockAcquired = false;
  };
  const isOwnBackupForCleanup = (): boolean => {
    if (!backupCreated) return false;
    const st = lstatOrNull(backupDir);
    if (st === null || !st.isDirectory() || st.isSymbolicLink()) return false;
    let entries: string[];
    try {
      entries = fs.readdirSync(backupDir);
    } catch {
      return false;
    }
    const allowed = new Set(["entry", "settings.json", "receipt.json", "meta.json"]);
    for (const entry of entries) {
      if (!allowed.has(entry)) return false;
    }
    const metaPath = path.join(backupDir, "meta.json");
    const metaStat = lstatOrNull(metaPath);
    if (metaStat !== null) {
      if (!metaStat.isFile() || metaStat.isSymbolicLink()) return false;
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { releaseId?: unknown };
        if (parsed.releaseId !== releaseId) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  const abortBeforePublish = (err: unknown): never => {
    if (backupCreated && !isOwnBackupForCleanup()) {
      try {
        fs.rmSync(markerPath, { force: true });
      } catch {
        // marker retained; fail closed below
      }
      try {
        releaseLock();
      } catch {
        // lock retained; fail closed below
      }
      const originalOwn = err instanceof Error ? err.message : String(err ?? "activation failed");
      failIncomplete(
        `backup drifted, preserving foreign state (recovery incomplete): ${backupDir}: ${originalOwn}`,
      );
    }
    const problems: string[] = [];
    try {
      fs.rmSync(markerPath, { force: true });
    } catch {
      problems.push("cannot remove marker");
    }
    try {
      releaseLock();
    } catch {
      problems.push("cannot release lock");
    }
    if (backupCreated && isOwnBackupForCleanup()) {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch {
        problems.push("cannot clear backup");
      }
    }
    const original = err instanceof Error ? err.message : String(err ?? "activation failed");
    if (problems.length > 0) {
      failIncomplete(`activation aborted (${problems.join("; ")}): ${original}`);
    }
    if (err instanceof Error) throw err;
    throw new Error(original);
  };

  // Exclusive cooperative lock plus stable marker, acquired before the first
  // mutable step and held until verify plus rollback/cleanup finish. Direct
  // wx writes (0600), no predictable temp files that could follow a symlink.
  fs.mkdirSync(managedRoot, { recursive: true });
  assertAncestorsClean(managedRoot, homeDir, "managed root");
  const managedRootStat = lstatOrNull(managedRoot);
  if (managedRootStat === null || !managedRootStat.isDirectory() || managedRootStat.isSymbolicLink()) {
    throw new Error(`cannot create managed root: ${managedRoot}`);
  }
  const lockToken = `${JSON.stringify({ pid: process.pid, stageDir, releaseId, startedAt: new Date().toISOString() })}\n`;
  try {
    fs.writeFileSync(lockPath, lockToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
    lockAcquired = true;
  } catch {
    failIncomplete(`transaction lock busy: concurrent activation holds the exclusive lock (recovery incomplete): ${lockPath}`);
  }
  if (lstatOrNull(markerPath) !== null) {
    try {
      fs.rmSync(lockPath, { force: true });
      lockAcquired = false;
    } catch {
      // lock retained as well; fail closed below
    }
    failIncomplete(`active transaction pending from a prior crash: refusing to mutate (recovery incomplete): ${markerPath}`);
  }
  const markerContent = `${JSON.stringify({ stageDir, backupDir, releaseId, releaseDir, phase: "prepared", pid: process.pid }, null, 2)}\n`;
  try {
    fs.writeFileSync(markerPath, markerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    try {
      fs.rmSync(lockPath, { force: true });
      lockAcquired = false;
    } catch {
      // lock retained as well; fail closed below
    }
    failIncomplete(`active transaction pending, cannot record marker (recovery incomplete): ${markerPath}`);
  }

  if (input.expectedPreviousEntry !== undefined) {
    const expectation = input.expectedPreviousEntry as unknown;
    if (
      expectation === null ||
      typeof expectation !== "object" ||
      Array.isArray(expectation) ||
      (expectation as { kind?: unknown }).kind !== "absent"
    ) {
      abortBeforePublish(new Error(`expected previous entry must be { kind: "absent" } when declared: ${linkPath}`));
    }
    if (lstatOrNull(linkPath) !== null) {
      abortBeforePublish(
        new Error(`expected previous entry absent but unowned entry present, refusing to claim foreign state: ${linkPath}`),
      );
    }
  }

  try {
    fs.mkdirSync(backupDir);
    backupCreated = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") {
      try {
        fs.rmSync(markerPath, { force: true });
      } catch {
        // marker retained; fail closed below
      }
      try {
        releaseLock();
      } catch {
        // lock retained; fail closed below
      }
      failIncomplete(
        `foreign backup collision between precheck and post-lock mkdir, refusing to mutate (recovery incomplete): ${backupDir}`,
      );
    }
    abortBeforePublish(err);
  }
  const backupStat = lstatOrNull(backupDir);
  if (backupStat === null || !backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    try {
      fs.rmSync(markerPath, { force: true });
    } catch {
      // marker retained; fail closed below
    }
    try {
      releaseLock();
    } catch {
      // lock retained; fail closed below
    }
    failIncomplete(`backup dir drifted after creation, refusing to delete foreign state (recovery incomplete): ${backupDir}`);
  }

  const persistBackupCopy = (target: string, content: string | null): void => {
    if (content === null) return;
    fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  };

  let entryMoved = false;
  let publishedLink = false;
  let wroteSettings = false;
  let wroteReceipt = false;
  try {
    persistBackupCopy(backupSettings, oldSettings);
    persistBackupCopy(backupReceipt, oldReceipt);
    fs.writeFileSync(
      path.join(backupDir, "meta.json"),
      `${JSON.stringify({ releaseId, oldEntryExisted }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    abortBeforePublish(new Error(`cannot persist private backup`));
  }

  const rollback = (verifyError: unknown): never => {
    const original =
      verifyError instanceof Error ? verifyError.message : String(verifyError ?? "verify failed");
    // Revalidate what THIS activation published and wrote before touching
    // anything. No lock assumption covers non-cooperative writers, so any
    // drift means foreign state: never unlink or overwrite it, retain
    // backup, marker and lock for manual recovery.
    let drift: string | null = null;
    if (publishedLink) {
      const cur = lstatOrNull(linkPath);
      if (cur === null || !cur.isSymbolicLink()) {
        drift = "published entry link missing or replaced";
      } else {
        let target: string | null = null;
        try {
          target = fs.readlinkSync(linkPath);
        } catch {
          target = null;
        }
        if (target !== expectedTarget) drift = "published entry link drifted";
      }
    } else if (lstatOrNull(linkPath) !== null) {
      drift = "managed entry replaced by foreign state before publish";
    }
    if (drift === null && wroteSettings) {
      let cur: string | null = null;
      try {
        cur = fs.readFileSync(settingsPath, "utf8");
      } catch {
        cur = null;
      }
      if (cur !== input.nextSettings) drift = "settings drifted";
    }
    if (drift === null && wroteReceipt) {
      let cur: string | null = null;
      try {
        cur = fs.readFileSync(receiptPath, "utf8");
      } catch {
        cur = null;
      }
      if (cur !== input.nextReceipt) drift = "receipt drifted";
    }
    if (drift !== null) {
      failIncomplete(`external drift during activation, refusing to touch foreign state (${drift}; recovery incomplete): ${original}`);
    }
    const problems: string[] = [];
    try {
      if (publishedLink) {
        const cur = lstatOrNull(linkPath);
        if (cur === null || !cur.isSymbolicLink()) {
          problems.push("published entry link missing");
        } else {
          fs.unlinkSync(linkPath);
        }
      } else if (lstatOrNull(linkPath) !== null) {
        problems.push("unexpected managed entry");
      }
    } catch {
      problems.push("cannot remove published symlink");
    }
    try {
      if (oldEntryExisted) {
        const backed = lstatOrNull(backupEntry);
        if (backed === null) {
          problems.push("backup entry missing");
        } else if (lstatOrNull(linkPath) !== null) {
          problems.push("managed entry still present");
        } else {
          fs.renameSync(backupEntry, linkPath);
        }
      } else if (lstatOrNull(linkPath) !== null) {
        problems.push("unexpected managed entry");
      }
    } catch {
      problems.push("cannot restore previous entry");
    }
    try {
      if (wroteSettings) {
        if (oldSettings !== null) {
          atomicWritePrivate(settingsPath, oldSettings);
        } else {
          fs.rmSync(settingsPath, { force: true });
        }
      }
    } catch {
      problems.push("cannot restore previous settings");
    }
    try {
      if (wroteReceipt) {
        if (oldReceipt !== null) {
          atomicWritePrivate(receiptPath, oldReceipt);
        } else {
          fs.rmSync(receiptPath, { force: true });
        }
      }
    } catch {
      problems.push("cannot restore previous receipt");
    }
    try {
      const destStat = lstatOrNull(releaseDir);
      const stagedStat = lstatOrNull(stagedNpm);
      if (destStat !== null && stagedStat === null) {
        fs.renameSync(releaseDir, stagedNpm);
      } else if (destStat !== null && stagedStat !== null) {
        problems.push("staged tree and promoted release both present");
      } else if (destStat === null && stagedStat === null) {
        problems.push("staged tree missing after rollback");
      }
    } catch {
      problems.push("cannot restore staged tree");
    }

    if (problems.length > 0) {
      failIncomplete(`rollback incomplete (${problems.join("; ")}): ${original}`);
    }
    if (backupCreated && !isOwnBackupForCleanup()) {
      failIncomplete(`backup drifted during rollback, preserving foreign state (recovery incomplete): ${original}`);
    }
    try {
      fs.rmSync(markerPath, { force: true });
      releaseLock();
      if (backupCreated && isOwnBackupForCleanup()) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    } catch {
      failIncomplete(`cannot clear transaction state after rollback: ${original}`);
    }
    if (verifyError instanceof Error) {
      (verifyError as Error & { recovery?: string }).recovery = "complete";
      throw verifyError;
    }
    const wrapped = new Error(String(verifyError ?? "verify failed")) as Error & { recovery: string };
    wrapped.recovery = "complete";
    throw wrapped;
  };

  try {
    if (oldEntryExisted) {
      fs.renameSync(linkPath, backupEntry);
      entryMoved = true;
    }
  } catch {
    abortBeforePublish(new Error(`cannot backup previous managed entry`));
  }

  try {
    fs.mkdirSync(releaseRoot, { recursive: true });
    assertAncestorsClean(releaseRoot, homeDir, "release root");
    const rootStat = lstatOrNull(releaseRoot);
    if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`cannot create release root: ${releaseRoot}`);
    }
    if (lstatOrNull(releaseDir) !== null) {
      throw new Error(`release already exists: ${releaseDir}`);
    }
    fs.renameSync(stagedNpm, releaseDir);
    fs.symlinkSync(expectedTarget, linkPath, "dir");
    publishedLink = true;
    atomicWritePrivate(settingsPath, input.nextSettings);
    wroteSettings = true;
    atomicWritePrivate(receiptPath, input.nextReceipt);
    wroteReceipt = true;
  } catch (err) {
    if (err instanceof Error && /release already exists/.test(err.message) && !entryMoved) {
      abortBeforePublish(err);
    }
    rollback(err);
  }

  try {
    await input.verify();
  } catch (err) {
    rollback(err);
  }

  // T07 §15: success removes the active marker and releases the lock so the
  // next install is not blocked, while the old backup under stageDir stays
  // recoverable until the v2 receipt lifecycle closes the rollback window.
  // Cleanup failure reports incomplete with evidence preserved, never success.
  try {
    fs.rmSync(markerPath, { force: true });
    releaseLock();
  } catch {
    failIncomplete(`cannot clear transaction state after activation (recovery incomplete): ${markerPath}`);
  }
  return { ok: true, releaseDir };
}

export interface DeactivateManagedDependency {
  name: string;
  version: string;
  integrity: string;
}

export interface DeactivateManagedPackage {
  releaseDir: string;
  linkPath: string;
  backupDir: string;
  lockSha256: string;
  treeSha256: string;
  dependencies: DeactivateManagedDependency[];
}

export interface DeactivateVerifiedPiReleaseInput {
  homeDir: string;
  agentDir: string;
  receiptPath: string;
  managedPackage: DeactivateManagedPackage;
  nextSettings: string;
  verify: () => void;
}

export type DeactivateVerifiedPiReleaseResult = { kind: "uninstalled"; backupDir: string };

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_UNINSTALL_LOCK_BYTES = 4 * 1024 * 1024;

function isManagedDependency(value: unknown): value is DeactivateManagedDependency {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["name"] === "string" && rec["name"] !== "" &&
    typeof rec["version"] === "string" && rec["version"] !== "" &&
    typeof rec["integrity"] === "string" && rec["integrity"] !== ""
  );
}

function readTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function safeReadlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
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

/**
 * Safe uninstall of a Stack-managed private Pi release (T07 GREEN).
 *
 * The caller has already authenticated the schema1 receipt, link, lock and
 * tree; this helper rechecks the owned relative symlink, the real release
 * dir and both digests before touching anything. It moves ONLY the owned
 * symlink, the private release and the receipt into a unique Stack-owned
 * backup under the managed npm root (never `pi remove`, never the shared
 * npm tree), writes nextSettings privately, then runs verify. On verify
 * failure it restores byte-identically when current state still belongs to
 * this operation; on external drift it retains both copies plus
 * marker/lock and reports incomplete. Success removes marker/lock but
 * retains the backup for rollback.
 */
export function deactivateVerifiedPiRelease(
  input: DeactivateVerifiedPiReleaseInput,
): DeactivateVerifiedPiReleaseResult {
  const mp = input.managedPackage;
  if (mp === null || typeof mp !== "object" || Array.isArray(mp)) {
    throw new Error(`managedPackage must be an object`);
  }
  if (
    typeof input.homeDir !== "string" || input.homeDir === "" ||
    typeof input.agentDir !== "string" || input.agentDir === "" ||
    typeof input.receiptPath !== "string" || input.receiptPath === "" ||
    typeof mp.releaseDir !== "string" || mp.releaseDir === "" ||
    typeof mp.linkPath !== "string" || mp.linkPath === "" ||
    typeof mp.backupDir !== "string" || mp.backupDir === ""
  ) {
    throw new Error(`homeDir, agentDir, receiptPath and managedPackage paths must be non-empty strings`);
  }
  if (!path.isAbsolute(input.homeDir)) {
    throw new Error(`homeDir must be absolute: ${input.homeDir}`);
  }
  if (typeof mp.lockSha256 !== "string" || !HEX64_PATTERN.test(mp.lockSha256)) {
    throw new Error(`managedPackage.lockSha256 must be 64 lowercase hex`);
  }
  if (typeof mp.treeSha256 !== "string" || !HEX64_PATTERN.test(mp.treeSha256)) {
    throw new Error(`managedPackage.treeSha256 must be 64 lowercase hex`);
  }
  if (!Array.isArray(mp.dependencies) || mp.dependencies.length === 0 || !mp.dependencies.every(isManagedDependency)) {
    throw new Error(`managedPackage.dependencies must be a non-empty array of {name,version,integrity}`);
  }
  if (typeof input.nextSettings !== "string") {
    throw new Error(`nextSettings must be a string`);
  }
  if (typeof input.verify !== "function") {
    throw new Error(`verify must be a function`);
  }

  const homeDir = resolved(input.homeDir);
  const agentDir = resolved(input.agentDir);
  const receiptPath = resolved(input.receiptPath);
  const releaseDir = resolved(mp.releaseDir);
  const linkPath = resolved(mp.linkPath);
  const activationBackupDir = resolved(mp.backupDir);

  const homeStat = lstatOrNull(homeDir);
  if (homeStat === null || !homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error(`homeDir must be a real directory: ${input.homeDir}`);
  }
  if (!isStrictChild(agentDir, homeDir)) {
    throw new Error(`agentDir must live within the homeDir boundary`);
  }
  if (!isStrictChild(receiptPath, homeDir)) {
    throw new Error(`receiptPath must live within the homeDir boundary`);
  }
  if (receiptPath === agentDir || isStrictChild(receiptPath, agentDir)) {
    throw new Error(`receiptPath must live outside the agent dir`);
  }
  const agentStat = lstatOrNull(agentDir);
  if (agentStat === null || !agentStat.isDirectory() || agentStat.isSymbolicLink()) {
    throw new Error(`agentDir must be a real directory: ${input.agentDir}`);
  }

  const settingsPath = path.join(agentDir, "settings.json");
  const npmDir = path.join(agentDir, "npm");
  const nodeModules = path.join(npmDir, "node_modules");
  const expectedLink = path.join(nodeModules, EXPECTED_ENTRY);
  const releaseRoot = path.join(npmDir, "jorgex-pi-managed", "releases");
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const markerPath = path.join(managedRoot, "active-transaction.json");
  const lockPath = path.join(managedRoot, "transaction.lock");

  if (linkPath !== expectedLink) {
    throw new Error(`managed link must be the owned entry: ${expectedLink}`);
  }
  const releaseId = path.basename(releaseDir);
  if (path.dirname(releaseDir) !== releaseRoot || !HEX64_PATTERN.test(releaseId)) {
    throw new Error(`managed release must live under the private releases root: ${releaseDir}`);
  }
  const expectedTarget = `../jorgex-pi-managed/releases/${releaseId}/node_modules/${EXPECTED_ENTRY}`;
  const packageRoot = path.join(releaseDir, "node_modules", EXPECTED_ENTRY);

  assertStrictChild(agentDir, homeDir, "agentDir");
  assertStrictChild(receiptPath, homeDir, "receiptPath");
  assertStrictChild(releaseDir, agentDir, "managed release");
  assertStrictChild(managedRoot, agentDir, "managed root");
  assertStrictChild(activationBackupDir, agentDir, "activation backup");
  if (activationBackupDir === npmDir || isStrictChild(activationBackupDir, npmDir)) {
    throw new Error(`activation backup must live outside the npm root: ${mp.backupDir}`);
  }
  assertStrictChild(linkPath, agentDir, "managed entry");
  assertStrictChild(settingsPath, agentDir, "settings.json");

  assertAncestorsClean(agentDir, homeDir, "agentDir");
  assertAncestorsClean(npmDir, homeDir, "npm root");
  assertAncestorsClean(nodeModules, homeDir, "node_modules");
  assertAncestorsClean(releaseRoot, homeDir, "release root");
  assertFilePathClean(settingsPath, homeDir, "settings.json");
  assertFilePathClean(receiptPath, homeDir, "receipt");

  const npmStat = lstatOrNull(npmDir);
  if (npmStat === null || !npmStat.isDirectory() || npmStat.isSymbolicLink()) {
    throw new Error(`npm root must be a real directory: ${npmDir}`);
  }
  const modulesStat = lstatOrNull(nodeModules);
  if (modulesStat === null || !modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
    throw new Error(`node_modules must be a real directory: ${nodeModules}`);
  }

  // Stable transaction state is consulted before release validation and
  // before any mutation. Pure lstat probes only; the managed root itself is
  // checked first so a planted symlink is never followed into outside paths.
  const managedPreStat = lstatOrNull(managedRoot);
  if (managedPreStat !== null && (managedPreStat.isSymbolicLink() || !managedPreStat.isDirectory())) {
    throw new Error(`managed root must be a real directory: ${managedRoot}`);
  }
  if (lstatOrNull(lockPath) !== null) {
    failIncomplete(`transaction lock busy: concurrent operation holds the exclusive lock (recovery incomplete): ${lockPath}`);
  }
  if (lstatOrNull(markerPath) !== null) {
    failIncomplete(`active transaction pending from a prior crash: refusing to mutate (recovery incomplete): ${markerPath}`);
  }

  const linkStat = lstatOrNull(linkPath);
  if (linkStat === null || !linkStat.isSymbolicLink()) {
    throw new Error(`managed entry must be the owned symlink: ${linkPath}`);
  }
  assertAncestorsClean(path.dirname(linkPath), homeDir, "managed entry");
  const observedTarget = safeReadlink(linkPath);
  if (observedTarget === null || observedTarget !== expectedTarget) {
    throw new Error(`managed entry points outside the owned release: ${linkPath}`);
  }
  assertManagedEntrySymlink(linkPath, npmDir, "managed entry");
  const packageRootStat = lstatOrNull(packageRoot);
  if (packageRootStat === null || !packageRootStat.isDirectory() || packageRootStat.isSymbolicLink()) {
    throw new Error(`managed package root must be a real directory: ${packageRoot}`);
  }
  let liveRealpath: string | null = null;
  try {
    liveRealpath = fs.realpathSync(linkPath);
  } catch {
    liveRealpath = null;
  }
  if (liveRealpath !== packageRoot) {
    throw new Error(`managed entry realpath mismatch: ${linkPath}`);
  }

  const releaseStat = lstatOrNull(releaseDir);
  if (releaseStat === null || !releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
    throw new Error(`managed release must be a real directory: ${releaseDir}`);
  }
  assertAncestorsClean(releaseDir, homeDir, "managed release");
  const activationBackupStat = lstatOrNull(activationBackupDir);
  if (activationBackupStat === null || !activationBackupStat.isDirectory() || activationBackupStat.isSymbolicLink()) {
    throw new Error(`activation backup must be a real directory: ${mp.backupDir}`);
  }
  assertAncestorsClean(activationBackupDir, homeDir, "activation backup");

  const lockFile = path.join(releaseDir, "package-lock.json");
  const lockStat = lstatOrNull(lockFile);
  if (lockStat === null || lockStat.isSymbolicLink() || !lockStat.isFile()) {
    throw new Error(`managed lock must be a regular file: ${lockFile}`);
  }
  if (lockStat.size > MAX_UNINSTALL_LOCK_BYTES) {
    throw new Error(`managed lock exceeds size bound: ${lockFile}`);
  }
  let lockBytes: Buffer;
  try {
    lockBytes = fs.readFileSync(lockFile);
  } catch {
    throw new Error(`cannot read managed lock: ${lockFile}`);
  }
  if (crypto.createHash("sha256").update(lockBytes).digest("hex") !== mp.lockSha256) {
    throw new Error(`managed lock digest mismatch: ${lockFile}`);
  }
  if (inventoryTreeSha256(releaseDir) !== mp.treeSha256) {
    throw new Error(`managed release inventory mismatch: ${releaseDir}`);
  }

  const receiptStat = lstatOrNull(receiptPath);
  if (receiptStat === null || !receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error(`managed receipt must be a regular file: ${receiptPath}`);
  }
  let oldSettings: string | null = null;
  let oldReceipt: string | null = null;
  try {
    if (lstatOrNull(settingsPath) !== null) {
      oldSettings = fs.readFileSync(settingsPath, "utf8");
    }
    oldReceipt = fs.readFileSync(receiptPath, "utf8");
  } catch {
    throw new Error(`cannot read previous settings/receipt`);
  }

  let lockAcquired = false;
  const releaseLock = (): void => {
    if (!lockAcquired) return;
    fs.rmSync(lockPath, { force: true });
    lockAcquired = false;
  };

  fs.mkdirSync(managedRoot, { recursive: true });
  assertAncestorsClean(managedRoot, homeDir, "managed root");
  const managedRootStat = lstatOrNull(managedRoot);
  if (managedRootStat === null || !managedRootStat.isDirectory() || managedRootStat.isSymbolicLink()) {
    throw new Error(`cannot create managed root: ${managedRoot}`);
  }
  let uninstallBackupDir = "";
  for (let i = 0; i < 5 && uninstallBackupDir === ""; i++) {
    const candidateDir = path.join(managedRoot, `uninstall-backup-${crypto.randomBytes(8).toString("hex")}`);
    if (lstatOrNull(candidateDir) === null) uninstallBackupDir = candidateDir;
  }
  if (uninstallBackupDir === "") {
    throw new Error(`cannot allocate a unique uninstall backup under: ${managedRoot}`);
  }
  assertStrictChild(uninstallBackupDir, managedRoot, "uninstall backup");
  const lockToken = `${JSON.stringify({ op: "uninstall", pid: process.pid, agentDir, releaseId, startedAt: new Date().toISOString() })}\n`;
  try {
    fs.writeFileSync(lockPath, lockToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
    lockAcquired = true;
  } catch {
    failIncomplete(`transaction lock busy: concurrent operation holds the exclusive lock (recovery incomplete): ${lockPath}`);
  }
  if (lstatOrNull(markerPath) !== null) {
    try {
      fs.rmSync(lockPath, { force: true });
      lockAcquired = false;
    } catch {
      // lock retained as well; fail closed below
    }
    failIncomplete(`active transaction pending from a prior crash: refusing to mutate (recovery incomplete): ${markerPath}`);
  }
  const markerContent = `${JSON.stringify({ phase: "uninstall", releaseDir, linkPath, receiptPath, backupDir: uninstallBackupDir, activationBackupDir, releaseId, pid: process.pid }, null, 2)}\n`;
  try {
    fs.writeFileSync(markerPath, markerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    try {
      fs.rmSync(lockPath, { force: true });
      lockAcquired = false;
    } catch {
      // lock retained as well; fail closed below
    }
    failIncomplete(`active transaction pending, cannot record marker (recovery incomplete): ${markerPath}`);
  }

  const abortOwnTransaction = (err: unknown): never => {
    const problems: string[] = [];
    try {
      fs.rmSync(markerPath, { force: true });
    } catch {
      problems.push("cannot remove marker");
    }
    try {
      releaseLock();
    } catch {
      problems.push("cannot release lock");
    }
    try {
      fs.rmSync(uninstallBackupDir, { recursive: true, force: true });
    } catch {
      problems.push("cannot clear backup");
    }
    const original = err instanceof Error ? err.message : String(err ?? "uninstall failed");
    if (problems.length > 0) {
      failIncomplete(`uninstall aborted (${problems.join("; ")}): ${original}`);
    }
    if (err instanceof Error) throw err;
    throw new Error(original);
  };

  const recheckLiveState = (): void => {
    let drift: string | null = null;
    if (safeReadlink(linkPath) !== observedTarget) {
      drift = "managed entry drifted before uninstall";
    } else {
      const restat = lstatOrNull(releaseDir);
      if (restat === null || !restat.isDirectory() || restat.isSymbolicLink()) {
        drift = "managed release drifted before uninstall";
      } else {
        const relockBytes = readTextOrNull(lockFile);
        if (relockBytes === null || crypto.createHash("sha256").update(relockBytes, "utf8").digest("hex") !== mp.lockSha256) {
          drift = "managed lock drifted before uninstall";
        } else {
          let retree: string | null = null;
          try {
            retree = inventoryTreeSha256(releaseDir);
          } catch {
            retree = null;
          }
          if (retree !== mp.treeSha256) drift = "managed release inventory drifted before uninstall";
        }
      }
    }
    if (drift !== null) {
      try {
        fs.rmSync(markerPath, { force: true });
        releaseLock();
      } catch {
        // marker/lock retained; fail closed below
      }
      failIncomplete(`live state drifted before uninstall (${drift}; recovery incomplete): ${linkPath}`);
    }
  };
  recheckLiveState();

  try {
    fs.mkdirSync(uninstallBackupDir, { recursive: true });
  } catch (err) {
    abortOwnTransaction(err);
  }
  const uninstallBackupStat = lstatOrNull(uninstallBackupDir);
  if (uninstallBackupStat === null || !uninstallBackupStat.isDirectory() || uninstallBackupStat.isSymbolicLink()) {
    abortOwnTransaction(new Error(`cannot create uninstall backup: ${uninstallBackupDir}`));
  }
  let backupEntries: string[] = [];
  try {
    backupEntries = fs.readdirSync(uninstallBackupDir);
  } catch {
    abortOwnTransaction(new Error(`cannot inspect uninstall backup: ${uninstallBackupDir}`));
  }
  if (backupEntries.length !== 0) {
    abortOwnTransaction(new Error(`uninstall backup is not empty: ${uninstallBackupDir}`));
  }

  const backupReleaseDir = path.join(uninstallBackupDir, "release");
  const backupReceiptFile = path.join(uninstallBackupDir, "pi-receipt.json");
  const backupSettingsFile = path.join(uninstallBackupDir, "settings.json");
  try {
    if (oldSettings !== null) {
      fs.writeFileSync(backupSettingsFile, oldSettings, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    fs.writeFileSync(
      path.join(uninstallBackupDir, "meta.json"),
      `${JSON.stringify({ phase: "uninstall", releaseDir, linkPath, receiptPath, linkTarget: observedTarget }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    abortOwnTransaction(new Error(`cannot persist uninstall backup`));
  }

  let removedLink = false;
  let movedRelease = false;
  let movedReceipt = false;
  let wroteSettings = false;

  const rollbackDeactivate = (cause: unknown): never => {
    const original = cause instanceof Error ? cause.message : String(cause ?? "verify failed");
    let drift: string | null = null;
    const curLink = lstatOrNull(linkPath);
    if (removedLink) {
      if (curLink !== null) drift = "managed entry reappeared during uninstall";
    } else if (curLink === null || !curLink.isSymbolicLink() || safeReadlink(linkPath) !== observedTarget) {
      drift = "managed entry drifted during uninstall";
    }
    if (drift === null) {
      const curRelease = lstatOrNull(releaseDir);
      const bakRelease = lstatOrNull(backupReleaseDir);
      if (movedRelease) {
        if (curRelease !== null) drift = "release reappeared during uninstall";
        else if (bakRelease === null || !bakRelease.isDirectory() || bakRelease.isSymbolicLink()) drift = "backed-up release missing";
      } else if (curRelease === null || !curRelease.isDirectory() || curRelease.isSymbolicLink()) {
        drift = "release drifted during uninstall";
      }
    }
    if (drift === null) {
      const curReceipt = lstatOrNull(receiptPath);
      const bakReceipt = lstatOrNull(backupReceiptFile);
      if (movedReceipt) {
        if (curReceipt !== null) drift = "receipt reappeared during uninstall";
        else if (bakReceipt === null || !bakReceipt.isFile() || bakReceipt.isSymbolicLink()) drift = "backed-up receipt missing";
      } else if (oldReceipt !== null && readTextOrNull(receiptPath) !== oldReceipt) {
        drift = "receipt drifted during uninstall";
      }
    }
    if (drift === null && wroteSettings && readTextOrNull(settingsPath) !== input.nextSettings) {
      drift = "settings drifted during uninstall";
    }
    if (drift === null && !wroteSettings && oldSettings !== null && readTextOrNull(settingsPath) !== oldSettings) {
      drift = "settings drifted during uninstall";
    }
    if (drift !== null) {
      failIncomplete(`external drift during uninstall, refusing to touch foreign state (${drift}; recovery incomplete): ${original}`);
    }
    const problems: string[] = [];
    if (movedRelease) {
      try {
        fs.renameSync(backupReleaseDir, releaseDir);
      } catch {
        problems.push("cannot restore release");
      }
    }
    if (removedLink) {
      try {
        fs.symlinkSync(observedTarget, linkPath, "dir");
      } catch {
        problems.push("cannot restore managed entry");
      }
    }
    if (wroteSettings) {
      try {
        if (oldSettings !== null) {
          atomicWritePrivate(settingsPath, oldSettings);
        } else {
          fs.rmSync(settingsPath, { force: true });
        }
      } catch {
        problems.push("cannot restore previous settings");
      }
    }
    if (movedReceipt) {
      try {
        fs.renameSync(backupReceiptFile, receiptPath);
      } catch {
        problems.push("cannot restore receipt");
      }
    }
    if (problems.length > 0) {
      failIncomplete(`uninstall rollback incomplete (${problems.join("; ")}): ${original}`);
    }
    try {
      fs.rmSync(markerPath, { force: true });
      releaseLock();
      fs.rmSync(uninstallBackupDir, { recursive: true, force: true });
    } catch {
      failIncomplete(`cannot clear transaction state after rollback: ${original}`);
    }
    if (cause instanceof Error) {
      (cause as Error & { recovery?: string }).recovery = "complete";
      throw cause;
    }
    const wrapped = new Error(String(cause ?? "verify failed")) as Error & { recovery: string };
    wrapped.recovery = "complete";
    throw wrapped;
  };

  try {
    fs.unlinkSync(linkPath);
    removedLink = true;
    fs.renameSync(releaseDir, backupReleaseDir);
    movedRelease = true;
    fs.renameSync(receiptPath, backupReceiptFile);
    movedReceipt = true;
    atomicWritePrivate(settingsPath, input.nextSettings);
    wroteSettings = true;
  } catch (err) {
    rollbackDeactivate(err);
  }

  // Synchronous contract: verify runs inline and must return void. A
  // thenable return fails closed with a synchronous rollback; attaching a
  // no-op rejection handler avoids an unhandled rejection if the thenable
  // later rejects, without swallowing a legitimate sync throw (handled
  // above before any thenable check).
  let verifyResult: unknown;
  try {
    verifyResult = input.verify();
  } catch (err) {
    rollbackDeactivate(err);
  }
  if (isThenable(verifyResult)) {
    try {
      verifyResult.then(undefined, () => {});
    } catch {
      // hostile thenable; rollback still runs below
    }
    rollbackDeactivate(new Error(`verify must be synchronous and return void, got thenable`));
  }

  // Success removes the active marker and releases the lock so the next
  // operation is not blocked, while the uninstall backup stays retained for
  // rollback. Cleanup failure reports incomplete with evidence preserved.
  try {
    fs.rmSync(markerPath, { force: true });
    releaseLock();
  } catch {
    failIncomplete(`cannot clear transaction state after uninstall (recovery incomplete): ${markerPath}`);
  }
  return { kind: "uninstalled", backupDir: uninstallBackupDir };
}

export interface DeactivateVerifiedLegacyPiEntryInput {
  homeDir: string;
  agentDir: string;
  receiptPath: string;
  source: string;
  nextSettings: string;
  verify: () => void;
}

export type DeactivateVerifiedLegacyPiEntryResult = { kind: "uninstalled"; backupDir: string };

const LEGACY_SOURCE_PATTERN = /^npm:jorgex-pi@((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;
const MAX_LEGACY_FILE_BYTES = 4 * 1024 * 1024;

function legacyPackageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = Reflect.get(entry, "source");
  return typeof source === "string" ? source : null;
}

function isLegacyPiSource(source: string): boolean {
  return source.includes("jorgex-pi");
}

function isExactLegacyManagedEntry(entry: unknown, source: string): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  const skills = Reflect.get(entry, "skills");
  const prompts = Reflect.get(entry, "prompts");
  return (
    keys.length === 3 &&
    keys.includes("source") &&
    keys.includes("skills") &&
    keys.includes("prompts") &&
    Reflect.get(entry, "source") === source &&
    Array.isArray(skills) &&
    skills.length === 0 &&
    Array.isArray(prompts) &&
    prompts.length === 0
  );
}

function stableStringifyLegacy(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringifyLegacy(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringifyLegacy(Reflect.get(value, key))}`);
  return `{${parts.join(",")}}`;
}

function readRegularTextLegacy(file: string, label: string): string {
  const st = lstatOrNull(file);
  if (st === null || !st.isFile() || st.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${file}`);
  }
  if (st.size > MAX_LEGACY_FILE_BYTES) {
    throw new Error(`${label} exceeds size bound: ${file}`);
  }
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read ${label}: ${file}`);
  }
}

/**
 * Safe uninstall of a legacy Stack-managed real-directory Pi entry (T07 GREEN).
 *
 * Preflight authenticates the owned `agentDir/npm/node_modules/jorgex-pi`
 * real directory (never a symlink), its package.json identity against the
 * strict `npm:jorgex-pi@semver` source, the schema1 installed receipt without
 * managedPackage holding the same candidate source plus exact agentDir scope,
 * and settings holding exactly one `{source,skills:[],prompts:[]}` managed
 * object. `nextSettings` must be exclusively that object's removal. Moves
 * ONLY the owned entry plus receipt into a unique private backup under the
 * managed root (never `pi remove`, never the shared npm root), writes
 * nextSettings atomically, runs sync verify inline, rolls back byte-identically
 * on failure, and reports incomplete with evidence preserved on drift.
 */
export function deactivateVerifiedLegacyPiEntry(
  input: DeactivateVerifiedLegacyPiEntryInput,
): DeactivateVerifiedLegacyPiEntryResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`input must be an object`);
  }
  if (
    typeof input.homeDir !== "string" || input.homeDir === "" ||
    typeof input.agentDir !== "string" || input.agentDir === "" ||
    typeof input.receiptPath !== "string" || input.receiptPath === "" ||
    typeof input.source !== "string" || input.source === ""
  ) {
    throw new Error(`homeDir, agentDir, receiptPath and source must be non-empty strings`);
  }
  if (!path.isAbsolute(input.homeDir)) {
    throw new Error(`homeDir must be absolute: ${input.homeDir}`);
  }
  const sourceMatch = LEGACY_SOURCE_PATTERN.exec(input.source);
  if (sourceMatch === null) {
    throw new Error(`source must be strict npm:jorgex-pi@semver: ${input.source}`);
  }
  const expectedVersion = sourceMatch[1] as string;
  if (typeof input.nextSettings !== "string") {
    throw new Error(`nextSettings must be a string`);
  }
  if (typeof input.verify !== "function") {
    throw new Error(`verify must be a function`);
  }

  const homeDir = resolved(input.homeDir);
  const agentDir = resolved(input.agentDir);
  const receiptPath = resolved(input.receiptPath);

  const homeStat = lstatOrNull(homeDir);
  if (homeStat === null || !homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error(`homeDir must be a real directory: ${input.homeDir}`);
  }
  if (!isStrictChild(agentDir, homeDir)) {
    throw new Error(`agentDir must live within the homeDir boundary`);
  }
  if (!isStrictChild(receiptPath, homeDir)) {
    throw new Error(`receiptPath must live within the homeDir boundary`);
  }
  if (receiptPath === agentDir || isStrictChild(receiptPath, agentDir)) {
    throw new Error(`receiptPath must live outside the agent dir`);
  }
  const agentStat = lstatOrNull(agentDir);
  if (agentStat === null || !agentStat.isDirectory() || agentStat.isSymbolicLink()) {
    throw new Error(`agentDir must be a real directory: ${input.agentDir}`);
  }

  const settingsPath = path.join(agentDir, "settings.json");
  const npmDir = path.join(agentDir, "npm");
  const nodeModules = path.join(npmDir, "node_modules");
  const legacyEntry = path.join(nodeModules, EXPECTED_ENTRY);
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const markerPath = path.join(managedRoot, "active-transaction.json");
  const lockPath = path.join(managedRoot, "transaction.lock");

  assertStrictChild(agentDir, homeDir, "agentDir");
  assertStrictChild(receiptPath, homeDir, "receiptPath");
  assertStrictChild(managedRoot, agentDir, "managed root");
  assertStrictChild(legacyEntry, agentDir, "managed entry");
  assertStrictChild(settingsPath, agentDir, "settings.json");

  assertAncestorsClean(agentDir, homeDir, "agentDir");
  assertAncestorsClean(npmDir, homeDir, "npm root");
  assertAncestorsClean(nodeModules, homeDir, "node_modules");
  assertFilePathClean(settingsPath, homeDir, "settings.json");
  assertFilePathClean(receiptPath, homeDir, "receipt");

  const npmStat = lstatOrNull(npmDir);
  if (npmStat === null || !npmStat.isDirectory() || npmStat.isSymbolicLink()) {
    throw new Error(`npm root must be a real directory: ${npmDir}`);
  }
  const modulesStat = lstatOrNull(nodeModules);
  if (modulesStat === null || !modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
    throw new Error(`node_modules must be a real directory: ${nodeModules}`);
  }

  const managedPreStat = lstatOrNull(managedRoot);
  if (managedPreStat !== null && (managedPreStat.isSymbolicLink() || !managedPreStat.isDirectory())) {
    throw new Error(`managed root must be a real directory: ${managedRoot}`);
  }
  if (lstatOrNull(lockPath) !== null) {
    failIncomplete(`transaction lock busy: concurrent operation holds the exclusive lock (recovery incomplete): ${lockPath}`);
  }
  if (lstatOrNull(markerPath) !== null) {
    failIncomplete(`active transaction pending from a prior crash: refusing to mutate (recovery incomplete): ${markerPath}`);
  }

  const entryStat = lstatOrNull(legacyEntry);
  if (entryStat === null || !entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    throw new Error(`managed entry must be a real directory, not a symlink: ${legacyEntry}`);
  }
  assertAncestorsClean(path.dirname(legacyEntry), homeDir, "managed entry");

  const manifestPath = path.join(legacyEntry, "package.json");
  const manifestStat = lstatOrNull(manifestPath);
  if (manifestStat === null || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`managed entry manifest must be a regular file: ${manifestPath}`);
  }
  let manifestParsed: unknown;
  try {
    manifestParsed = JSON.parse(readRegularTextLegacy(manifestPath, "managed entry manifest"));
  } catch (err) {
    if (err instanceof Error && /regular file|size bound|cannot read/.test(err.message)) throw err;
    throw new Error(`managed entry manifest is not valid JSON: ${manifestPath}`);
  }
  if (
    manifestParsed === null || typeof manifestParsed !== "object" || Array.isArray(manifestParsed) ||
    Reflect.get(manifestParsed, "name") !== "jorgex-pi" ||
    Reflect.get(manifestParsed, "version") !== expectedVersion
  ) {
    throw new Error(`managed entry manifest identity must match owned source: ${manifestPath}`);
  }

  const receiptText = readRegularTextLegacy(receiptPath, "managed receipt");
  let receiptParsed: unknown;
  try {
    receiptParsed = JSON.parse(receiptText) as unknown;
  } catch {
    throw new Error(`managed receipt is not valid JSON: ${receiptPath}`);
  }
  if (receiptParsed === null || typeof receiptParsed !== "object" || Array.isArray(receiptParsed)) {
    throw new Error(`managed receipt must be an object: ${receiptPath}`);
  }
  if (Reflect.get(receiptParsed, "schemaVersion") !== 1) {
    throw new Error(`managed receipt must be schemaVersion 1: ${receiptPath}`);
  }
  if (Reflect.get(receiptParsed, "state") !== "installed") {
    throw new Error(`managed receipt must be installed: ${receiptPath}`);
  }
  if ("managedPackage" in (receiptParsed as Record<string, unknown>)) {
    throw new Error(`legacy receipt must not carry managedPackage: ${receiptPath}`);
  }
  const candidate = Reflect.get(receiptParsed, "candidate");
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`managed receipt misses candidate: ${receiptPath}`);
  }
  const pkg = Reflect.get(candidate, "package");
  if (
    pkg === null || typeof pkg !== "object" || Array.isArray(pkg) ||
    Reflect.get(pkg, "name") !== "jorgex-pi" ||
    Reflect.get(pkg, "version") !== expectedVersion ||
    Reflect.get(pkg, "source") !== input.source
  ) {
    throw new Error(`managed receipt candidate must match owned source: ${receiptPath}`);
  }
  const scope = Reflect.get(receiptParsed, "scope");
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error(`managed receipt misses scope: ${receiptPath}`);
  }
  const scopeDir = Reflect.get(scope, "codingAgentDir");
  if (typeof scopeDir !== "string" || resolved(scopeDir) !== agentDir) {
    throw new Error(`managed receipt scope must match the exact agent dir: ${receiptPath}`);
  }

  const oldSettings = readRegularTextLegacy(settingsPath, "settings.json");
  let oldParsed: unknown;
  try {
    oldParsed = JSON.parse(oldSettings) as unknown;
  } catch {
    throw new Error(`settings.json is not valid JSON: ${settingsPath}`);
  }
  if (oldParsed === null || typeof oldParsed !== "object" || Array.isArray(oldParsed)) {
    throw new Error(`settings.json must be an object: ${settingsPath}`);
  }
  const oldPackages = Reflect.get(oldParsed, "packages");
  if (!Array.isArray(oldPackages)) {
    throw new Error(`settings.json misses packages: ${settingsPath}`);
  }
  const oldSources = oldPackages.map((entry) => legacyPackageSource(entry));
  if (oldSources.some((source) => source === null)) {
    throw new Error(`settings.json holds an entry without source: ${settingsPath}`);
  }
  const piIndexes: number[] = [];
  for (let index = 0; index < oldSources.length; index += 1) {
    const source = oldSources[index];
    if (typeof source === "string" && isLegacyPiSource(source)) piIndexes.push(index);
  }
  if (piIndexes.length !== 1) {
    throw new Error(`settings.json must hold exactly one managed jorgex-pi entry: ${settingsPath}`);
  }
  const ownedIndex = piIndexes[0] as number;
  if (oldSources[ownedIndex] !== input.source || !isExactLegacyManagedEntry(oldPackages[ownedIndex], input.source)) {
    throw new Error(`settings.json managed entry must be exactly {source,skills:[],prompts:[]}: ${settingsPath}`);
  }

  let nextParsed: unknown;
  try {
    nextParsed = JSON.parse(input.nextSettings) as unknown;
  } catch {
    throw new Error(`nextSettings is not valid JSON`);
  }
  if (nextParsed === null || typeof nextParsed !== "object" || Array.isArray(nextParsed)) {
    throw new Error(`nextSettings must be an object`);
  }
  const expectedNext = JSON.parse(JSON.stringify(oldParsed)) as Record<string, unknown>;
  (expectedNext["packages"] as unknown[]).splice(ownedIndex, 1);
  if (stableStringifyLegacy(nextParsed) !== stableStringifyLegacy(expectedNext)) {
    throw new Error(`nextSettings must be exclusively the removal of the owned entry`);
  }

  let lockAcquired = false;
  const releaseLock = (): void => {
    if (!lockAcquired) return;
    fs.rmSync(lockPath, { force: true });
    lockAcquired = false;
  };

  fs.mkdirSync(managedRoot, { recursive: true });
  assertAncestorsClean(managedRoot, homeDir, "managed root");
  const managedRootStat = lstatOrNull(managedRoot);
  if (managedRootStat === null || !managedRootStat.isDirectory() || managedRootStat.isSymbolicLink()) {
    throw new Error(`cannot create managed root: ${managedRoot}`);
  }
  let uninstallBackupDir = "";
  for (let i = 0; i < 5 && uninstallBackupDir === ""; i++) {
    const candidateDir = path.join(managedRoot, `uninstall-backup-${crypto.randomBytes(8).toString("hex")}`);
    if (lstatOrNull(candidateDir) === null) uninstallBackupDir = candidateDir;
  }
  if (uninstallBackupDir === "") {
    throw new Error(`cannot allocate a unique uninstall backup under: ${managedRoot}`);
  }
  assertStrictChild(uninstallBackupDir, managedRoot, "uninstall backup");
  const lockToken = `${JSON.stringify({ op: "uninstall-legacy", pid: process.pid, agentDir, source: input.source, startedAt: new Date().toISOString() })}\n`;
  try {
    fs.writeFileSync(lockPath, lockToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
    lockAcquired = true;
  } catch {
    failIncomplete(`transaction lock busy: concurrent operation holds the exclusive lock (recovery incomplete): ${lockPath}`);
  }
  if (lstatOrNull(markerPath) !== null) {
    try {
      fs.rmSync(lockPath, { force: true });
      lockAcquired = false;
    } catch {
      // lock retained as well; fail closed below
    }
    failIncomplete(`active transaction pending from a prior crash: refusing to mutate (recovery incomplete): ${markerPath}`);
  }
  const markerContent = `${JSON.stringify({ phase: "uninstall-legacy", legacyEntry, receiptPath, backupDir: uninstallBackupDir, source: input.source, pid: process.pid }, null, 2)}\n`;
  try {
    fs.writeFileSync(markerPath, markerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    try {
      fs.rmSync(lockPath, { force: true });
      lockAcquired = false;
    } catch {
      // lock retained as well; fail closed below
    }
    failIncomplete(`active transaction pending, cannot record marker (recovery incomplete): ${markerPath}`);
  }

  const abortOwnTransaction = (err: unknown): never => {
    const problems: string[] = [];
    try {
      fs.rmSync(markerPath, { force: true });
    } catch {
      problems.push("cannot remove marker");
    }
    try {
      releaseLock();
    } catch {
      problems.push("cannot release lock");
    }
    try {
      fs.rmSync(uninstallBackupDir, { recursive: true, force: true });
    } catch {
      problems.push("cannot clear backup");
    }
    const original = err instanceof Error ? err.message : String(err ?? "uninstall failed");
    if (problems.length > 0) {
      failIncomplete(`uninstall aborted (${problems.join("; ")}): ${original}`);
    }
    if (err instanceof Error) throw err;
    throw new Error(original);
  };

  const liveEntryStat = lstatOrNull(legacyEntry);
  if (liveEntryStat === null || !liveEntryStat.isDirectory() || liveEntryStat.isSymbolicLink()) {
    abortOwnTransaction(new Error(`managed entry drifted before uninstall: ${legacyEntry}`));
  }
  if (readTextOrNull(receiptPath) !== receiptText || readTextOrNull(settingsPath) !== oldSettings) {
    abortOwnTransaction(new Error(`receipt or settings drifted before uninstall: ${legacyEntry}`));
  }

  try {
    fs.mkdirSync(uninstallBackupDir, { recursive: true });
  } catch (err) {
    abortOwnTransaction(err);
  }
  const uninstallBackupStat = lstatOrNull(uninstallBackupDir);
  if (uninstallBackupStat === null || !uninstallBackupStat.isDirectory() || uninstallBackupStat.isSymbolicLink()) {
    abortOwnTransaction(new Error(`cannot create uninstall backup: ${uninstallBackupDir}`));
  }
  let backupEntries: string[] = [];
  try {
    backupEntries = fs.readdirSync(uninstallBackupDir);
  } catch {
    abortOwnTransaction(new Error(`cannot inspect uninstall backup: ${uninstallBackupDir}`));
  }
  if (backupEntries.length !== 0) {
    abortOwnTransaction(new Error(`uninstall backup is not empty: ${uninstallBackupDir}`));
  }

  const backupEntryDir = path.join(uninstallBackupDir, "entry");
  const backupReceiptFile = path.join(uninstallBackupDir, "pi-receipt.json");
  const backupSettingsFile = path.join(uninstallBackupDir, "settings.json");
  try {
    fs.writeFileSync(backupSettingsFile, oldSettings, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.writeFileSync(
      path.join(uninstallBackupDir, "meta.json"),
      `${JSON.stringify({ phase: "uninstall-legacy", legacyEntry, receiptPath, source: input.source }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    abortOwnTransaction(new Error(`cannot persist uninstall backup`));
  }

  let movedEntry = false;
  let movedReceipt = false;
  let wroteSettings = false;

  const rollbackLegacy = (cause: unknown): never => {
    const original = cause instanceof Error ? cause.message : String(cause ?? "verify failed");
    let drift: string | null = null;
    const curEntry = lstatOrNull(legacyEntry);
    const bakEntry = lstatOrNull(backupEntryDir);
    if (movedEntry) {
      if (curEntry !== null) drift = "managed entry reappeared during uninstall";
      else if (bakEntry === null || !bakEntry.isDirectory() || bakEntry.isSymbolicLink()) drift = "backed-up entry missing";
    } else if (curEntry === null || !curEntry.isDirectory() || curEntry.isSymbolicLink()) {
      drift = "managed entry drifted during uninstall";
    }
    if (drift === null) {
      const curReceipt = lstatOrNull(receiptPath);
      const bakReceipt = lstatOrNull(backupReceiptFile);
      if (movedReceipt) {
        if (curReceipt !== null) drift = "receipt reappeared during uninstall";
        else if (bakReceipt === null || !bakReceipt.isFile() || bakReceipt.isSymbolicLink()) drift = "backed-up receipt missing";
      } else if (readTextOrNull(receiptPath) !== receiptText) {
        drift = "receipt drifted during uninstall";
      }
    }
    if (drift === null && wroteSettings && readTextOrNull(settingsPath) !== input.nextSettings) {
      drift = "settings drifted during uninstall";
    }
    if (drift === null && !wroteSettings && readTextOrNull(settingsPath) !== oldSettings) {
      drift = "settings drifted during uninstall";
    }
    if (drift !== null) {
      failIncomplete(`external drift during uninstall, refusing to touch foreign state (${drift}; recovery incomplete): ${original}`);
    }
    const problems: string[] = [];
    if (movedReceipt) {
      try {
        fs.renameSync(backupReceiptFile, receiptPath);
      } catch {
        problems.push("cannot restore receipt");
      }
    }
    if (movedEntry) {
      try {
        fs.renameSync(backupEntryDir, legacyEntry);
      } catch {
        problems.push("cannot restore previous entry");
      }
    }
    if (wroteSettings) {
      try {
        atomicWritePrivate(settingsPath, oldSettings);
      } catch {
        problems.push("cannot restore previous settings");
      }
    }
    if (problems.length > 0) {
      failIncomplete(`uninstall rollback incomplete (${problems.join("; ")}): ${original}`);
    }
    try {
      fs.rmSync(markerPath, { force: true });
      releaseLock();
      fs.rmSync(uninstallBackupDir, { recursive: true, force: true });
    } catch {
      failIncomplete(`cannot clear transaction state after rollback: ${original}`);
    }
    if (cause instanceof Error) {
      (cause as Error & { recovery?: string }).recovery = "complete";
      throw cause;
    }
    const wrapped = new Error(String(cause ?? "verify failed")) as Error & { recovery: string };
    wrapped.recovery = "complete";
    throw wrapped;
  };

  try {
    fs.renameSync(legacyEntry, backupEntryDir);
    movedEntry = true;
    fs.renameSync(receiptPath, backupReceiptFile);
    movedReceipt = true;
    atomicWritePrivate(settingsPath, input.nextSettings);
    wroteSettings = true;
  } catch (err) {
    rollbackLegacy(err);
  }

  let verifyResult: unknown;
  try {
    verifyResult = input.verify();
  } catch (err) {
    rollbackLegacy(err);
  }
  if (isThenable(verifyResult)) {
    try {
      verifyResult.then(undefined, () => {});
    } catch {
      // hostile thenable; rollback still runs below
    }
    rollbackLegacy(new Error(`verify must be synchronous and return void, got thenable`));
  }

  try {
    fs.rmSync(markerPath, { force: true });
    releaseLock();
  } catch {
    failIncomplete(`cannot clear transaction state after uninstall (recovery incomplete): ${markerPath}`);
  }
  return { kind: "uninstalled", backupDir: uninstallBackupDir };
}
