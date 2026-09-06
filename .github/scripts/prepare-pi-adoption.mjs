import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleepDefault } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPiPin } from "./pi-pin.mjs";
import { waitForNpmAvailability } from "./npm-readback.mjs";

const PIN = "src/lib/pi-runtime-pin.json";
const ARTIFACTS = "tests/fixtures/pi-runtime-artifacts.json";
const TARGETS = [PIN, ARTIFACTS];
const PARITY = "contract/parity.v2.json";
const CONTRACTS = [
  "package.json", "contract/jorgex-pi.v1.json", PARITY, "contract/runtime-agents.v1.json",
  "contract/runner.v1.json", "contract/assets.v1.json", "contract/components.v1.json",
  "contract/schemas/runner-response.v1.schema.json", "contract/schemas/quality-receipt.v1.schema.json",
  "contract/schemas/quality-capabilities.v1.schema.json",
];
const MAX_JSON = 1024 * 1024;
const MAX_TARBALL = 125_829_120;
const fullSha = (value) => typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
const readJson = (root, name) => JSON.parse(readFileSync(join(root, name), "utf8"));

function assertPinData(pin) {
  readPiPin(pin);
  assert.deepEqual(Object.keys(pin).sort(), ["package", "provenance", "tarball"], "Unsupported pin fields");
  assert.deepEqual(Object.keys(pin.package).sort(), ["name", "source", "version"]);
  assert.deepEqual(Object.keys(pin.provenance), ["commit"]);
  assert.deepEqual(Object.keys(pin.tarball).sort(), ["bytes", "sha256", "sha512"]);
}

function git(root, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|REPLACE_REF_BASE)$/.test(key)) delete env[key];
  return execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * MAX_JSON, timeout: 30_000, windowsHide: true,
  });
}

function checkoutRoot(input) {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Error("An absolute checkout root is required");
  const root = realpathSync(input);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root) throw new Error("Use the exact checkout root");
  return root;
}

function assertClean(root, stage) {
  if (git(root, ["ls-files", "-v", "-z"]).split("\0").some((entry) => /^[a-zS] /.test(entry))) throw new Error("Hidden index flags are unsupported");
  const paths = stage ? ["--", ".", `:(exclude,top,literal)${basename(stage)}`] : [];
  if (git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...paths])) throw new Error("Stack checkout must be clean and exclusively owned");
  for (const name of TARGETS) {
    git(root, ["ls-files", "--error-unmatch", "--", name]);
    let target = root;
    const parts = name.split("/");
    for (let index = 0; index < parts.length; index++) {
      target = join(target, parts[index]);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unsafe adoption destination");
    }
  }
}

function versionParts(version) {
  if (typeof version !== "string" || version.length > 128 || /[\r\n]/.test(version) || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error("A plain published Pi version is required");
  return version.split(".").map(BigInt);
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

async function boundedJson(response) {
  if (!response.body) throw new Error("Missing registry metadata body");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_JSON) throw new Error("Registry metadata exceeds its limit");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function downloadTarball(fetch, url, destination, integrity) {
  if (typeof integrity !== "string" || integrity.length !== 95 || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Invalid registry integrity");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000), headers: { "accept-encoding": "identity" } });
  if (response.status !== 200 || !response.body) throw new Error("Pi tarball download failed");
  const descriptor = openSync(destination, "wx");
  const digest256 = createHash("sha256"), digest512 = createHash("sha512");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_TARBALL) throw new Error("Pi tarball exceeds its size limit");
      digest256.update(buffer); digest512.update(buffer);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
  } finally { closeSync(descriptor); }
  if (bytes === 0) throw new Error("Empty Pi tarball");
  const sha256 = digest256.digest("hex"), sha512 = digest512.digest("hex");
  assert.equal(`sha512-${Buffer.from(sha512, "hex").toString("base64")}`, integrity, "Registry SRI mismatch");
  return { bytes, sha256, sha512 };
}

function tar(file, args) {
  return execFileSync("tar", [...args, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * MAX_JSON, timeout: 30_000, windowsHide: true });
}

function archiveEntries(file) {
  const entries = tar(file, ["-tzf"]).trimEnd().split(/\r?\n/);
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (!name.startsWith("package/") && name !== "package") throw new Error("Archive member outside package");
    if (/[\x00-\x1f\\:<>"|?*]/.test(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[. ]$/.test(part))) throw new Error("Unsafe archive member");
    if (seen.has(name.toLowerCase())) throw new Error("Duplicate or case-colliding archive member");
    seen.add(name.toLowerCase());
  }
  return entries;
}

function tarJson(file, member) {
  const text = execFileSync("tar", ["-xOf", file, `package/${member}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_JSON, timeout: 30_000, windowsHide: true });
  return JSON.parse(text);
}

function comparable(member, input) {
  const value = structuredClone(input);
  if (member === "package.json") delete value.version;
  if (member === "contract/jorgex-pi.v1.json") { delete value.package.version; delete value.package.source; }
  if (member === PARITY) {
    delete value.source.commit;
    const strip = (item) => {
      if (item === null || typeof item !== "object") return;
      for (const key of Object.keys(item)) {
        if (["sha256", "sourceSha256", "outputSha256"].includes(key)) delete item[key];
        else strip(item[key]);
      }
    };
    for (const key of ["agents", "skills", "policy", "engramProtocol", "commands"]) strip(value[key]);
  }
  return value;
}

function applyJsonFiles(root, stage, values) {
  const states = TARGETS.map((name, index) => ({ target: join(root, name), backup: join(stage, `${index}.old`), next: join(stage, `${index}.new`), backedUp: false, published: false }));
  for (let index = 0; index < states.length; index++) writeFileSync(states[index].next, `${JSON.stringify(values[index], null, 2)}\n`, { flag: "wx", mode: lstatSync(states[index].target).mode & 0o777 });
  try {
    for (const state of states) {
      renameSync(state.target, state.backup); state.backedUp = true;
      renameSync(state.next, state.target); state.published = true;
    }
  } catch (error) {
    const failures = [];
    for (const state of states.reverse()) {
      try {
        if (state.published) unlinkSync(state.target);
        if (state.backedUp) renameSync(state.backup, state.target);
      } catch (failure) { failures.push(failure); }
    }
    if (failures.length) {
      const failure = new AggregateError(failures, "Adoption rollback incomplete", { cause: error });
      failure.recoveryPath = stage;
      throw failure;
    }
    throw error;
  }
}

export async function preparePiAdoption({ root: rootInput, piDir: piInput, version, apply = false }, { fetch = globalThis.fetch, now = Date.now, sleep = sleepDefault } = {}) {
  versionParts(version);
  if (typeof apply !== "boolean") throw new Error("apply must be boolean");
  const root = checkoutRoot(rootInput);
  if (readJson(root, "package.json").name !== "jorgex-stack") throw new Error("Expected a JorgeX Stack checkout");
  if (["main", "master"].includes(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim())) throw new Error("Use a work branch or detached checkout, not production");
  assertClean(root);
  const baseCommit = git(root, ["rev-parse", "HEAD"]).trim();
  const current = readJson(root, PIN), artifacts = readJson(root, ARTIFACTS);
  assertPinData(current); assertPinData(artifacts.previous);
  assert.deepEqual(artifacts.current, current, "Fixture and runtime pin differ");
  assert.deepEqual(Object.keys(artifacts).sort(), ["archive", "current", "previous"], "Unsupported fixture metadata");
  if (!Number.isSafeInteger(artifacts.archive?.entries) || artifacts.archive.entries <= 0 || !fullSha(artifacts.archive?.parity?.source?.commit)) throw new Error("Invalid archive expectations");
  assert.deepEqual(Object.keys(artifacts.archive).sort(), ["entries", "parity"]);
  assert.deepEqual(Object.keys(artifacts.archive.parity), ["source"]);
  assert.deepEqual(Object.keys(artifacts.archive.parity.source), ["commit"]);
  if (compareVersions(version, current.package.version) <= 0) return { status: "unchanged", version, changedPaths: [] };
  const piDir = checkoutRoot(piInput);
  if (piDir === root) throw new Error("Expected a separate Pi checkout");
  const producer = git(piDir, ["rev-parse", "--verify", `refs/tags/v${version}^{commit}`]).trim();
  if (!fullSha(producer)) throw new Error("Invalid Pi producer tag");
  git(piDir, ["merge-base", "--is-ancestor", producer, "origin/main"]);
  git(piDir, ["merge-base", "--is-ancestor", current.provenance.commit, producer]);
  const oldContracts = {}, newContracts = {};
  for (const member of CONTRACTS) {
    oldContracts[member] = JSON.parse(git(piDir, ["show", `${current.provenance.commit}:${member}`]));
    newContracts[member] = JSON.parse(git(piDir, ["show", `${producer}:${member}`]));
    assert.deepEqual(comparable(member, newContracts[member]), comparable(member, oldContracts[member]), `${member} compatibility requires manual review`);
  }
  assert.equal(newContracts["package.json"].name, "jorgex-pi");
  assert.equal(newContracts["package.json"].version, version);
  assert.deepEqual(newContracts["contract/jorgex-pi.v1.json"].package, { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` });
  const sourceCommit = newContracts[PARITY].source.commit;
  if (!fullSha(sourceCommit) || newContracts[PARITY].source.repository !== "https://github.com/jorgehn98/jorgex-stack") throw new Error("Invalid Stack parity source");
  assert.equal(oldContracts[PARITY].source.commit, artifacts.archive.parity.source.commit, "Accepted parity baseline differs");
  git(root, ["merge-base", "--is-ancestor", sourceCommit, "origin/main"]);
  git(root, ["merge-base", "--is-ancestor", artifacts.archive.parity.source.commit, sourceCommit]);

  const stage = mkdtempSync(join(root, ".pi-adoption-"));
  let failure;
  try {
    let metadata;
    const result = await waitForNpmAvailability({
      packageName: "jorgex-pi", version, now, sleep, deadlineAt: now() + 300_000, retryDelayMs: 2_000,
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (response.status !== 200) { await response.body?.cancel(); return { status: response.status }; }
        return { status: 200, json: async () => { metadata = await boundedJson(response); return metadata; } };
      },
    });
    if (result.status !== "public" || !metadata) throw new Error("Pi release is not publicly available");
    const url = `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
    assert.equal(metadata.dist.tarball, url, "Unexpected registry artifact origin");
    const tarballFile = join(stage, "package.tgz");
    const tarball = await downloadTarball(fetch, url, tarballFile, metadata.dist.integrity);
    const entries = archiveEntries(tarballFile);
    assert.equal(entries.length, artifacts.archive.entries, "Archive inventory changes require manual review");
    for (const member of CONTRACTS) {
      const packed = tarJson(tarballFile, member), expected = structuredClone(newContracts[member]);
      if (member === "package.json") {
        if (Object.hasOwn(packed, "packageManager")) assert.equal(packed.packageManager, expected.packageManager);
        delete packed.packageManager; delete expected.packageManager;
      }
      assert.deepEqual(packed, expected, `${member} does not match the producer Git object`);
    }
    const pin = { package: { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` }, provenance: { commit: producer }, tarball };
    readPiPin(pin);
    const nextArtifacts = { current: pin, previous: current, archive: { entries: artifacts.archive.entries, parity: { source: { commit: sourceCommit } } } };
    if (git(root, ["rev-parse", "HEAD"]).trim() !== baseCommit) throw new Error("Stack HEAD changed during preparation");
    assertClean(root, stage);
    if (apply) applyJsonFiles(root, stage, [pin, nextArtifacts]);
    return { status: "prepared", version, changedPaths: [...TARGETS] };
  } catch (error) { failure = error; throw error; }
  finally {
    if (failure?.recoveryPath !== stage) {
      if (dirname(stage) !== root || !basename(stage).startsWith(".pi-adoption-")) throw new Error("Unsafe adoption cleanup path");
      try { rmSync(stage, { recursive: true }); }
      catch (error) { if (failure) failure.recoveryPath = stage; else { error.recoveryPath = stage; throw error; } }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (![4, 5].includes(args.length) || args[0] !== "--pi-dir" || args[2] !== "--version" || (args.length === 5 && args[4] !== "--apply")) throw new Error("Invalid arguments");
    const result = await preparePiAdoption({ root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."), piDir: args[1], version: args[3], apply: args.length === 5 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error.recoveryPath ? `Adoption failed; recovery retained at ${error.recoveryPath}` : "Adoption failed. Check refs, compatibility and checkout cleanliness. Usage: --pi-dir ABS --version X.Y.Z [--apply]");
    process.exitCode = 1;
  }
}
