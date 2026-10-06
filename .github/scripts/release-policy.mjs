import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const NAME = "jorgex-stack";
const TAG_PREFIX = "v";

export function validateVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Release version must be plain x.y.z; staged placeholders are not releases.");
  }
  return version;
}

export function normalizeSha(value) {
  if (!/^[a-f0-9]{40}$/i.test(value ?? "")) throw new Error("release_sha must be a complete 40-character SHA.");
  return value.toLowerCase();
}

export async function registryVersion(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${validateVersion(version)}`, {
    signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry read failed: HTTP ${response.status}.`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity ?? "")) {
    throw new Error("Registry metadata does not identify the requested version and SHA-512 integrity.");
  }
  return { integrity: metadata.dist.integrity };
}

export function releasePlan({ registry, tagSha, sha, mainSha, recovery }) {
  if (registry && !recovery) {
    if (!tagSha) throw new Error("Published version has no tag. Dispatch with the exact published release_sha to recover.");
    return { publish: false, needed: false };
  }
  if (tagSha && tagSha !== sha) throw new Error("Immutable release tag points to a different SHA.");
  if (!registry && sha !== mainSha) throw new Error("A new historical publication is blocked; select current main, without downgrading latest.");
  return { publish: registry === null, needed: true };
}

export function verifyIntegrity(registry, integrity) {
  if (!registry) throw new Error("Published version is unavailable; do not republish to compensate for readback.");
  if (registry.integrity !== integrity) throw new Error("Registry integrity differs from the validated tarball; no tag may be created.");
}

// npm exposes a new version minutes after `npm publish` returns. Only that 404 is waited for:
// network, auth, malformed metadata and byte mismatch throw on the attempt that sees them.
const READBACK_INTERVAL_MS = 15_000;
const READBACK_LIMIT_MS = 300_000;

export async function confirmPublished(name, version, integrity, { fetcher = fetch, sleep: pause = sleep } = {}) {
  for (let waited = 0; waited < READBACK_LIMIT_MS; waited += READBACK_INTERVAL_MS) {
    const registry = await registryVersion(name, version, fetcher);
    if (registry) return verifyIntegrity(registry, integrity);
    await pause(READBACK_INTERVAL_MS);
  }
  verifyIntegrity(await registryVersion(name, version, fetcher), integrity);
}

export function publicationNeeded(registry, integrity, planned, rerun = false) {
  if (registry || !planned) {
    verifyIntegrity(registry, integrity);
    return false;
  }
  if (rerun) throw new Error("Registry still reports absence on rerun; publication outcome is uncertain. Wait for metadata, never republish for readback.");
  return true;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function manifest() {
  const value = JSON.parse(readFileSync("package.json", "utf8"));
  if (value.name !== NAME) throw new Error("Legacy or unexpected package cannot be published here.");
  validateVersion(value.version);
  return value;
}

function tagSha(tag) {
  // Only a locally absent ref means absent; fetch/auth failures have already failed.
  const ref = run("git", ["for-each-ref", "--format=%(refname)", `refs/tags/${tag}`]);
  return ref ? normalizeSha(run("git", ["rev-parse", `${tag}^{commit}`])) : null;
}

function artifact(path, version) {
  const packed = JSON.parse(run("tar", ["-xOf", path, "package/package.json"]));
  if (packed.name !== NAME || packed.version !== validateVersion(version)) throw new Error("Tarball package/version differs from the candidate.");
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

async function main(command, path) {
  if (command === "target") {
    if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Release workflow must run on main.");
    run("git", ["fetch", "origin", "main", "--tags"]);
    const mainSha = normalizeSha(run("git", ["rev-parse", "origin/main"]));
    const sha = normalizeSha(process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? process.env.RELEASE_SHA : process.env.GITHUB_SHA);
    run("git", ["merge-base", "--is-ancestor", sha, mainSha]);
    output({ sha });
  } else if (command === "plan") {
    const { version } = manifest();
    const sha = normalizeSha(run("git", ["rev-parse", "HEAD"]));
    if (sha !== normalizeSha(process.env.TARGET_SHA)) throw new Error("Checkout differs from the selected candidate SHA.");
    const mainSha = normalizeSha(run("git", ["rev-parse", "origin/main"]));
    run("git", ["merge-base", "--is-ancestor", sha, mainSha]);
    const tag = `${TAG_PREFIX}${version}`;
    const existingTag = tagSha(tag);
    if (existingTag) {
      run("git", ["merge-base", "--is-ancestor", existingTag, sha]);
      const tagged = JSON.parse(run("git", ["show", `${existingTag}:package.json`]));
      if (tagged.name !== NAME || tagged.version !== version) throw new Error("Tag does not identify this package version.");
    }
    const plan = releasePlan({ registry: await registryVersion(NAME, version), tagSha: existingTag, sha, mainSha, recovery: process.env.GITHUB_EVENT_NAME === "workflow_dispatch" });
    output({ ...plan, version, sha, tag });
  } else if (command === "artifact") {
    const { version } = manifest();
    const integrity = artifact(path, version);
    if (process.env.PUBLISH !== "true") verifyIntegrity(await registryVersion(NAME, version), integrity);
    output({ integrity });
  } else if (command === "prepare" || command === "verify") {
    const version = validateVersion(process.env.VERSION);
    const integrity = artifact(path, version);
    if (integrity !== process.env.INTEGRITY) throw new Error("Artifact changed after validation.");
    if (command === "prepare") {
      const registry = await registryVersion(NAME, version);
      const publish = publicationNeeded(registry, integrity, process.env.PUBLISH === "true", Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) > 1);
      if (publish) {
        const repo = process.env.GITHUB_REPOSITORY;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("Invalid repository.");
        const currentMain = run("git", ["ls-remote", `https://github.com/${repo}.git`, "refs/heads/main"]).split(/\s/)[0];
        if (normalizeSha(currentMain) !== normalizeSha(process.env.SHA)) throw new Error("New publication is stale; main advanced. Dispatch the accepted current candidate.");
      }
      output({ publish });
      return;
    }
    await confirmPublished(NAME, version, integrity);
  } else {
    throw new Error("Usage: release-policy.mjs target|plan|artifact|prepare|verify [tarball]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2], process.argv[3]);
}
