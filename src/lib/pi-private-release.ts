import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ActivateVerifiedPiReleaseInput {
  homeDir: string;
  agentDir: string;
  stageDir: string;
  releaseId: string;
  receiptPath: string;
  nextSettings: string;
  nextReceipt: string;
  verify: () => void | Promise<void>;
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
    fs.rmSync(tmp, { force: true });
    throw new Error(`private temp is not a regular file: ${target}`);
  }
  fs.renameSync(tmp, target);
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
  const releaseLock = (): void => {
    if (!lockAcquired) return;
    fs.rmSync(lockPath, { force: true });
    lockAcquired = false;
  };
  const abortBeforePublish = (err: unknown): never => {
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
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      problems.push("cannot clear backup");
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

  fs.mkdirSync(backupDir, { recursive: true });
  const backupStat = lstatOrNull(backupDir);
  if (backupStat === null || !backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw new Error(`cannot create private backup dir: ${backupDir}`);
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
    try {
      fs.rmSync(markerPath, { force: true });
      releaseLock();
      fs.rmSync(backupDir, { recursive: true, force: true });
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
