import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  downloadVerifiedPiTarball,
  resolveLatestPiRelease,
} from "./pi-release-resolver.js";

export interface ObservedPiCiArtifact {
  version: string;
  tarballUrl: string;
  integrity: string;
  bytes: number;
  sha256: string;
  sha512: string;
}

export interface PrepareObservedPiCiArtifactInput {
  tarballPath: string;
  candidatePath: string;
  fetchImpl: typeof fetch;
}

const MAX_CANDIDATE_BYTES = 64 * 1024;

function fail(message: string): never {
  throw new Error(`pi-ci-artifact: ${message}`);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function assertAbsolute(label: string, value: unknown): string {
  if (typeof value !== "string" || value === "" || !path.isAbsolute(value)) {
    fail(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function assertParentRealDir(resolvedFile: string, label: string): string {
  const dir = path.dirname(resolvedFile);
  const st = lstatOrNull(dir);
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) {
    fail(`${label} parent must be a real directory: ${dir}`);
  }
  return dir;
}

/**
 * T06 CI observed artifact: resolve the live `dist-tags.latest` candidate,
 * download the exact verified tarball, then freeze the observed identity as
 * a bounded private JSON. Filesystem guards run before any network.
 */
export async function prepareObservedPiCiArtifact(
  input: PrepareObservedPiCiArtifactInput,
): Promise<ObservedPiCiArtifact> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("input must be an object");
  }
  const { tarballPath, candidatePath, fetchImpl } = input as unknown as Record<string, unknown>;
  if (typeof fetchImpl !== "function") {
    fail("fetchImpl must be a function");
  }

  const tarballResolved = assertAbsolute("tarballPath", tarballPath);
  const candidateResolved = assertAbsolute("candidatePath", candidatePath);
  if (tarballResolved === candidateResolved) {
    fail("tarballPath and candidatePath must differ");
  }
  const candidateDir = assertParentRealDir(candidateResolved, "candidatePath");
  assertParentRealDir(tarballResolved, "tarballPath");

  const candidateExisting = lstatOrNull(candidateResolved);
  if (candidateExisting !== null) {
    fail(`candidate already exists: ${candidateResolved}`);
  }
  const tarballExisting = lstatOrNull(tarballResolved);
  if (tarballExisting !== null && tarballExisting.isSymbolicLink()) {
    fail(`tarball path must not be a symlink: ${tarballResolved}`);
  }

  let release: { version: string; tarballUrl: string; integrity: string };
  try {
    release = await resolveLatestPiRelease(fetchImpl as typeof fetch);
  } catch (error) {
    if (error instanceof Error && /^(pi-ci-artifact|pi-release-resolver): /.test(error.message)) {
      throw error;
    }
    fail(`provider release resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let artifact: { bytes: number; sha256: string; sha512: string };
  try {
    artifact = await downloadVerifiedPiTarball(
      release,
      tarballResolved,
      fetchImpl as typeof fetch,
    );
  } catch (error) {
    if (error instanceof Error && /^(pi-ci-artifact|pi-release-resolver): /.test(error.message)) {
      throw error;
    }
    fail(`verified tarball acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const payload: ObservedPiCiArtifact = {
    version: release.version,
    tarballUrl: release.tarballUrl,
    integrity: release.integrity,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    sha512: artifact.sha512,
  };
  const serialized = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(serialized, "utf8") >= MAX_CANDIDATE_BYTES) {
    fail("candidate JSON exceeds 64 KiB");
  }

  const tempPath = path.join(
    candidateDir,
    `pi-ci-candidate-partial-${process.pid}-${randomBytes(8).toString("hex")}.json`,
  );
  let fd: number;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
  } catch {
    fail(`cannot stage candidate temp: ${tempPath}`);
  }
  let fdClosed = false;
  const closeFd = (): void => {
    if (fdClosed) return;
    fdClosed = true;
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors; unlink below still cleans the temp.
    }
  };
  const discardStaged = (): void => {
    closeFd();
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort temp removal; destination was never touched.
    }
  };

  try {
    try {
      fs.writeSync(fd, serialized, null, "utf8");
    } catch {
      fail("cannot write candidate temp");
    }
    closeFd();
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      fail("cannot secure candidate temp");
    }
    try {
      // No-replace publish: link fails when the candidate exists (including
      // a symlink, without following it), so a raced file is never replaced.
      fs.linkSync(tempPath, candidateResolved);
    } catch {
      fail(`candidate already exists: ${candidateResolved}`);
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Published; temp unlink is best-effort hygiene only.
    }
  } catch (error) {
    discardStaged();
    if (error instanceof Error && error.message.startsWith("pi-ci-artifact: ")) throw error;
    fail(`candidate publish failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return payload;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
    console.error("pi-ci-artifact: expected <absolute-tarball> <absolute-candidate>");
    process.exit(1);
  }
  const [tarballArg, candidateArg] = args as [string, string];
  await prepareObservedPiCiArtifact({
    tarballPath: tarballArg,
    candidatePath: candidateArg,
    fetchImpl: fetch,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "pi-ci-artifact: failed");
    process.exit(1);
  });
}
