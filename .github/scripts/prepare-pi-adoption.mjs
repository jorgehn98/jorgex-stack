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
const SYSTEM_PROMPT_MODULES = [
  { name: "context7", file: "context7.md" },
  { name: "playwright", file: "browser-playwright.md" },
  { name: "chrome-devtools", file: "browser-chrome-devtools.md" },
];
const CONTEXT7_CAPABILITY = "context7-http-v1";
const CONTEXT7_MODULE = "extensions/context7-config.mjs";
const CONTEXT7_RUNNER = {
  transport: "http",
  registration: "isolated in-memory bridge at Pi bootstrap",
  diagnostic: "available means configuration permits registration; no HTTP handshake is implied",
  conflicts: "preserve existing MCP files; block managed Context7 activation",
  cleanup: "no managed MCP configuration or credentials are written",
};
const CONTEXT7_PRESERVED_STATE = {
  owner: "user",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "mcp.json",
};
const PERMISSIONS_CAPABILITY = "permissions-policy-v1";
const PERMISSIONS_SOURCE_PATH = "stack/config/defaults.json";
const PERMISSIONS_TARGET_PATH = "assets/permissions/defaults.json";
const PERMISSIONS_RESOURCE = "assets/permissions";
const PERMISSIONS_MODULE = "extensions/permissions-lifecycle.mjs";
const PERMISSIONS_RUNNER = {
  config: "PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json",
  receipt: "PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json",
  defaults: "assets/permissions/defaults.json",
  semantics: "sync seeds only an absent config through exclusive publication; existing, invalid, and concurrent user state is preserved; cleanup keeps an exact owned copy in a retained backup",
  diagnostic: "permission state reports invalid or unreadable files without exposing their contents",
};
const PERMISSIONS_PRESERVED_STATE = {
  owner: "@gotgenes/pi-permission-system",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "extensions/pi-permission-system/config.json",
};
const PERMISSIONS_MANAGED_WRITES = [
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "extensions/pi-permission-system/config.json",
    semantics: "seed the generated permission policy only when absent; publish exclusively, preserve preexisting or invalid user state, and remove only an exact owned copy during cleanup",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/permissions-lifecycle.v1.json",
    semantics: "record initialization and exact permission-config ownership without storing user configuration or credentials",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/permissions-backups",
    semantics: "retain cleanup backups of exact owned permission policy bytes",
  },
];
const PERMISSIONS_ACTIONS = [
  "created:permissions.config",
  "initialized:permissions",
  "preserved:permissions.config",
  "released:permissions.config",
  "backup:permissions.config",
  "removed:permissions.config",
];
const UPGRADE_CAPABILITY = "permissions-upgrade-v1";
const UPGRADE_RUNNER_COMMAND = "upgrade";
const UPGRADE_LIFECYCLE_ACTION = "upgraded:permissions.config";
const UPGRADE_POLICY_SHA256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
const UPGRADE_ONEOF_ENTRIES = [
  {
    properties: { command: { const: "upgrade" }, ok: { const: true }, result: { $ref: "#/$defs/lifecycleResult" } },
    not: { required: ["error"] },
  },
  {
    properties: { command: { const: "upgrade" }, ok: { const: false }, result: { $ref: "#/$defs/lifecycleResult" } },
    required: ["error"],
  },
];
const UPGRADE_PERMISSIONS_SEMANTICS = "sync seeds only an absent config through exclusive publication; an explicit upgrade rewrites an absent or owned-stale config with a prior byte-exact backup, exclusive publication, and a versioned receipt; existing, invalid, and concurrent user state is preserved; cleanup keeps an exact owned copy in a retained backup";
const EXPERIENCE_CAPABILITY = "experience-defaults-v1";
const EXPERIENCE_BIN = "bin/jorgex-pi.mjs";
const EXPERIENCE_RUNNER = {
  settings: "PI_CODING_AGENT_DIR/settings.json",
  receipt: "PI_CODING_AGENT_DIR/jorgex-pi/experience-lifecycle.v1.json",
  defaults: {
    theme: "JorgeX",
    quietStartup: true,
    hideThinkingBlock: true,
  },
  initialization: "first sync only",
  ownership: "missing fields only; cleanup removes exact package-owned values and preserves replacements",
};
const EXPERIENCE_RECEIPT_WRITE = {
  owner: "jorgex-pi",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "jorgex-pi/experience-lifecycle.v1.json",
  semantics: "record first initialization and exact ownership of missing theme, quietStartup, and hideThinkingBlock fields; preserve replacements and do not reseed after initialization",
};
const EXPERIENCE_SETTINGS_SEMANTICS = "merge a missing or matching partial defaultProvider=openai-codex and defaultModel=gpt-5.6-sol pair plus first-visit theme=JorgeX, quietStartup=true, and hideThinkingBlock=true defaults; preserve foreign halves and existing experience values; cleanup removes only receipt-owned exact values";
const EXPERIENCE_ACTIONS = [
  "created:theme",
  "created:quietStartup",
  "created:hideThinkingBlock",
  "released:theme",
  "released:quietStartup",
  "released:hideThinkingBlock",
  "removed:theme",
  "removed:quietStartup",
  "removed:hideThinkingBlock",
];
const INITIALIZATION_CAPABILITY = "initialization-diagnostics-v1";
const INITIALIZATION_EXPERIENCE_DIAGNOSTIC = "status reports pending, initialized, invalid, or unreadable from the receipt only; pending means the receipt is absent and requires a registered package; invalid preserves INVALID_PATH, INVALID_RECEIPT, or RECEIPT_TOO_LARGE and unreadable preserves READ_FAILED; status and doctor are read-only and never lock, write, or delete state";
const INITIALIZATION_PERMISSIONS_DIAGNOSTIC = "permission state reports invalid or unreadable files without exposing their contents; a registered package also reports pending when the receipt is not initialized";
const INITIALIZATION_EXPERIENCE_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized"], properties: { state: { const: "pending" }, receiptPath: { type: "string" }, initialized: { const: false } } },
    { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized"], properties: { state: { const: "initialized" }, receiptPath: { type: "string" }, initialized: { const: true } } },
    { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized", "code", "reason"], properties: { state: { const: "invalid" }, receiptPath: { type: "string" }, initialized: { const: false }, code: { enum: ["INVALID_PATH", "INVALID_RECEIPT", "RECEIPT_TOO_LARGE"] }, reason: { type: "string", minLength: 1 } } },
    { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized", "code", "reason"], properties: { state: { const: "unreadable" }, receiptPath: { type: "string" }, initialized: { const: false }, code: { const: "READ_FAILED" }, reason: { type: "string", minLength: 1 } } },
  ],
};
const ENGRAM_CHILD_MEMBER = "extensions/engram-child.ts";
const ENGRAM_CHILD_ROUTE = "../extensions/engram-child.ts";
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

function permissionParityMetadata(root, piDir, sourceCommit, producer, input) {
  assert(input && typeof input === "object" && !Array.isArray(input), "Invalid permissions parity metadata");
  assert.deepEqual(Object.keys(input).sort(), ["outputSha256", "sourcePath", "sourceSha256", "targetPath"], "Invalid permissions parity metadata");
  assert.equal(input.sourcePath, PERMISSIONS_SOURCE_PATH, "Unexpected permissions parity source path");
  assert.equal(input.targetPath, PERMISSIONS_TARGET_PATH, "Unexpected permissions parity target path");
  const source = git(root, ["show", `${sourceCommit}:${PERMISSIONS_SOURCE_PATH}`]);
  const output = git(piDir, ["show", `${producer}:${PERMISSIONS_TARGET_PATH}`]);
  const expected = {
    sourcePath: PERMISSIONS_SOURCE_PATH,
    targetPath: PERMISSIONS_TARGET_PATH,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    outputSha256: createHash("sha256").update(output).digest("hex"),
  };
  assert.deepEqual(input, expected, "Permissions parity hashes do not match the canonical Git blobs");
  return expected;
}

function git(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
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

function tarText(file, member) {
  return execFileSync("tar", ["-xOf", file, `package/${member}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_JSON, timeout: 30_000, windowsHide: true });
}

function tarJson(file, member) {
  return JSON.parse(tarText(file, member));
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
    for (const key of ["agents", "skills", "policy", "engramProtocol", "systemPromptModules", "commands"]) strip(value[key]);
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

export async function preparePiAdoption({ root: rootInput, piDir: piInput, version, apply = false, acceptDevtoolsHandoff = false, acceptPlaywrightHandoff = false, acceptPlaywrightSkillRemoval = false, acceptModularSystemPrompts = false, acceptContext7Http = false, acceptPermissionsPolicy = false, acceptExperienceDefaults = false, acceptInitializationDiagnostics = false, acceptPermissionsUpgrade = false, acceptEngramChildOnly = false, acceptPiVersion }, { fetch = globalThis.fetch, now = Date.now, sleep = sleepDefault } = {}) {
  versionParts(version);
  if (acceptPiVersion !== undefined) versionParts(acceptPiVersion);
  if (typeof apply !== "boolean" || typeof acceptDevtoolsHandoff !== "boolean" || typeof acceptPlaywrightHandoff !== "boolean" || typeof acceptPlaywrightSkillRemoval !== "boolean" || typeof acceptModularSystemPrompts !== "boolean" || typeof acceptContext7Http !== "boolean" || typeof acceptPermissionsPolicy !== "boolean" || typeof acceptExperienceDefaults !== "boolean" || typeof acceptInitializationDiagnostics !== "boolean" || typeof acceptPermissionsUpgrade !== "boolean" || typeof acceptEngramChildOnly !== "boolean") throw new Error("Adoption options must be boolean");
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
  }
  const sourceCommit = newContracts[PARITY].source.commit;
  if (!fullSha(sourceCommit) || newContracts[PARITY].source.repository !== "https://github.com/jorgehn98/jorgex-stack") throw new Error("Invalid Stack parity source");
  const expectedContracts = structuredClone(oldContracts);
  const rootContract = "contract/jorgex-pi.v1.json";
  const modularCapability = "modular-system-prompts-v1";
  const hasModularPrompts = newContracts[rootContract].capabilities.includes(modularCapability);
  const modularTransition = acceptModularSystemPrompts
    && !oldContracts[rootContract].capabilities.includes(modularCapability) && hasModularPrompts;
  const promptModules = hasModularPrompts ? SYSTEM_PROMPT_MODULES.map(({ name, file }) => {
    const sourcePath = `stack/system-prompt/${file}`;
    const targetPath = `assets/system-prompt/${file}`;
    const content = git(root, ["show", `${sourceCommit}:${sourcePath}`]);
    const digest = createHash("sha256").update(content).digest("hex");
    assert.equal(git(piDir, ["show", `${producer}:${targetPath}`]), content,
      "Modular system prompt does not match the canonical source");
    return { metadata: { name, sourcePath, targetPath, sourceSha256: digest, outputSha256: digest }, content };
  }) : [];
  if (hasModularPrompts) {
    assert.deepEqual(newContracts[PARITY].systemPromptModules, promptModules.map(({ metadata }) => metadata),
      `${PARITY} compatibility requires manual review (modular system prompt metadata)`);
  }
  if (modularTransition) {
    const capabilities = expectedContracts[rootContract].capabilities;
    const snapshotIndex = capabilities.indexOf("stack-snapshot-v2");
    assert(snapshotIndex >= 0, "Modular prompts require the existing Stack snapshot");
    capabilities.splice(snapshotIndex + 1, 0, modularCapability);
    expectedContracts[PARITY].systemPromptModules = promptModules.map(({ metadata }) => metadata);
    const exclusions = expectedContracts[PARITY].exclusions;
    assert.equal(exclusions.filter((item) => item.kind === "capability-integration" && item.id === "context7-mcp").length, 1,
      "Modular prompts must retain the Context7 MCP exclusion");
    for (const { file } of SYSTEM_PROMPT_MODULES.filter(({ name }) => name !== "context7")) {
      const sourcePath = `stack/system-prompt/${file}`;
      const matches = exclusions.filter((item) => item.kind === "runtime-specific-overlay" && item.sourcePath === sourcePath);
      assert.equal(matches.length, 1, "Modular browser prompt requires exactly one former exclusion");
      assert.deepEqual(matches[0], { kind: "runtime-specific-overlay", sourcePath });
      exclusions.splice(exclusions.indexOf(matches[0]), 1);
    }
  }
  const context7Transition = acceptContext7Http
    && !oldContracts[rootContract].capabilities.includes(CONTEXT7_CAPABILITY)
    && newContracts[rootContract].capabilities.includes(CONTEXT7_CAPABILITY);
  if (context7Transition) {
    const capabilities = expectedContracts[rootContract].capabilities;
    assert(!capabilities.includes(CONTEXT7_CAPABILITY), "Context7 HTTP capability must be new in this transition");
    const engramIndex = capabilities.indexOf("engram-runtime-tools-v1");
    assert(engramIndex >= 0, "Context7 HTTP requires the existing Engram runtime capability");
    capabilities.splice(engramIndex + 1, 0, CONTEXT7_CAPABILITY);

    const exclusions = expectedContracts[PARITY].exclusions;
    const matches = exclusions.filter((item) => item.kind === "capability-integration" && item.id === "context7-mcp");
    assert.equal(matches.length, 1, "Context7 HTTP requires exactly one former MCP exclusion");
    exclusions.splice(exclusions.indexOf(matches[0]), 1);

    const runner = expectedContracts["contract/runner.v1.json"];
    assert.equal(runner.context7, undefined, "Context7 HTTP runner metadata must be new in this transition");
    runner.context7 = structuredClone(CONTEXT7_RUNNER);

    const assets = expectedContracts["contract/assets.v1.json"];
    assert(!assets.preservedExternalState.some((item) => item.owner === CONTEXT7_PRESERVED_STATE.owner
      && item.root === CONTEXT7_PRESERVED_STATE.root && item.relativePath === CONTEXT7_PRESERVED_STATE.relativePath),
    "Context7 HTTP preserved state must be new in this transition");
    assets.preservedExternalState.push(structuredClone(CONTEXT7_PRESERVED_STATE));

    const schema = expectedContracts["contract/schemas/runner-response.v1.schema.json"];
    assert.equal(schema.$defs.context7, undefined, "Context7 HTTP schema definition must be new in this transition");
    schema.$defs.context7 = {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: {
        state: { enum: ["available", "conflict", "invalid"] },
        source: { type: "string" },
        code: { type: "string" },
      },
    };
    const statusResult = schema.$defs.statusResult;
    assert.deepEqual(statusResult.required, ["installation", "engram"]);
    statusResult.required.push("context7");
    statusResult.properties.context7 = { $ref: "#/$defs/context7" };
    const doctorChecks = schema.$defs.doctorResult.properties.checks;
    assert.equal(doctorChecks.minItems, 2);
    assert.equal(doctorChecks.maxItems, 2);
    doctorChecks.minItems = 3;
    doctorChecks.maxItems = 3;
    assert.deepEqual(doctorChecks.items.properties.id.enum, ["package", "engram"]);
    doctorChecks.items.properties.id.enum.push("context7");
  }
  const permissionsEnabled = newContracts[rootContract].capabilities.includes(PERMISSIONS_CAPABILITY);
  const permissionsMetadata = permissionsEnabled
    ? permissionParityMetadata(root, piDir, sourceCommit, producer, newContracts[PARITY].permissions)
    : undefined;
  const permissionsTransition = acceptPermissionsPolicy
    && !oldContracts[rootContract].capabilities.includes(PERMISSIONS_CAPABILITY)
    && permissionsEnabled;
  if (permissionsTransition) {
    const capabilities = expectedContracts[rootContract].capabilities;
    assert(!capabilities.includes(PERMISSIONS_CAPABILITY), "Permissions policy capability must be new in this transition");
    const context7Index = capabilities.indexOf(CONTEXT7_CAPABILITY);
    assert(context7Index >= 0, "Permissions policy requires the existing Context7 HTTP capability");
    capabilities.splice(context7Index + 1, 0, PERMISSIONS_CAPABILITY);

    const assets = expectedContracts["contract/assets.v1.json"];
    const resourceIndex = assets.resources.indexOf("assets/system-prompt");
    assert(resourceIndex >= 0, "Permissions policy requires the existing system prompt assets");
    assert(!assets.resources.includes(PERMISSIONS_RESOURCE), "Permissions policy resource must be new in this transition");
    assets.resources.splice(resourceIndex, 0, PERMISSIONS_RESOURCE);
    assert.equal(assets.managedExternalWrites.length, 3, "Permissions policy requires the original managed writes");
    assert(!assets.managedExternalWrites.some((item) => PERMISSIONS_MANAGED_WRITES.some(({ relativePath }) => item.relativePath === relativePath)),
      "Permissions policy managed writes must be new in this transition");
    assets.managedExternalWrites.push(...structuredClone(PERMISSIONS_MANAGED_WRITES));
    const preserved = assets.preservedExternalState;
    const preservedMatches = preserved.filter((item) => item.owner === PERMISSIONS_PRESERVED_STATE.owner
      && item.root === PERMISSIONS_PRESERVED_STATE.root && item.relativePath === PERMISSIONS_PRESERVED_STATE.relativePath);
    assert.equal(preservedMatches.length, 1, "Permissions policy requires exactly one former preserved config");
    assert.deepEqual(preservedMatches[0], PERMISSIONS_PRESERVED_STATE);
    preserved.splice(preserved.indexOf(preservedMatches[0]), 1);

    const runner = expectedContracts["contract/runner.v1.json"];
    assert.equal(runner.permissions, undefined, "Permissions policy runner metadata must be new in this transition");
    runner.permissions = structuredClone(PERMISSIONS_RUNNER);
    expectedContracts[PARITY].permissions = structuredClone(permissionsMetadata);

    const schema = expectedContracts["contract/schemas/runner-response.v1.schema.json"];
    assert.equal(schema.$defs.permissions, undefined, "Permissions policy schema definition must be new in this transition");
    schema.$defs.permissions = {
      type: "object",
      additionalProperties: false,
      required: ["state", "path", "receiptPath", "initialized", "owned"],
      properties: {
        state: { enum: ["absent", "missing-owned", "managed", "preexisting", "invalid", "unreadable"] },
        path: { type: "string" },
        receiptPath: { type: "string" },
        initialized: { type: "boolean" },
        owned: { type: "boolean" },
        reason: { type: "string" },
      },
    };
    const statusResult = schema.$defs.statusResult;
    assert.deepEqual(statusResult.required, ["installation", "engram", "context7"]);
    statusResult.required.push("permissions");
    assert.equal(statusResult.properties.permissions, undefined);
    statusResult.properties.permissions = { $ref: "#/$defs/permissions" };
    const doctorChecks = schema.$defs.doctorResult.properties.checks;
    assert.equal(doctorChecks.minItems, 3);
    assert.equal(doctorChecks.maxItems, 3);
    doctorChecks.minItems = 4;
    doctorChecks.maxItems = 4;
    assert.deepEqual(doctorChecks.items.properties.id.enum, ["package", "engram", "context7"]);
    doctorChecks.items.properties.id.enum.push("permissions");
    const lifecycleResult = schema.$defs.lifecycleResult;
    assert.equal(lifecycleResult.properties.actions.maxItems, 9);
    lifecycleResult.properties.actions.maxItems = 32;
    const lifecycleAction = schema.$defs.lifecycleAction;
    assert(!PERMISSIONS_ACTIONS.some((action) => lifecycleAction.enum.includes(action)), "Permissions policy lifecycle actions must be new in this transition");
    lifecycleAction.enum.push(...PERMISSIONS_ACTIONS);
  }
  const oldHasPermissions = oldContracts[rootContract].capabilities.includes(PERMISSIONS_CAPABILITY);
  if (oldHasPermissions && permissionsEnabled && !permissionsTransition) {
    const oldPermissions = oldContracts[PARITY].permissions;
    assert(oldPermissions && typeof oldPermissions === "object", "Permissions parity metadata must exist when the capability is already present");
    assert(permissionsMetadata && typeof permissionsMetadata === "object", "Permissions parity metadata must exist in the producer");
    if (JSON.stringify(oldPermissions) !== JSON.stringify(permissionsMetadata)) {
      assert.equal(acceptPermissionsPolicy, true, `${PARITY} compatibility requires manual review (permissions content drift)`);
      expectedContracts[PARITY].permissions = structuredClone(permissionsMetadata);
    }
  }
  const upgradeEnabled = newContracts[rootContract].capabilities.includes(UPGRADE_CAPABILITY);
  const upgradeTransition = acceptPermissionsUpgrade
    && !oldContracts[rootContract].capabilities.includes(UPGRADE_CAPABILITY)
    && upgradeEnabled;
  if (upgradeTransition) {
    assert(oldContracts[rootContract].capabilities.includes(PERMISSIONS_CAPABILITY) && permissionsEnabled,
      "Permissions upgrade requires the permissions policy capability");
    const capabilities = expectedContracts[rootContract].capabilities;
    assert(!capabilities.includes(UPGRADE_CAPABILITY), "Permissions upgrade capability must be new in this transition");
    const permissionsIndex = capabilities.indexOf(PERMISSIONS_CAPABILITY);
    assert(permissionsIndex >= 0, "Permissions upgrade requires the existing permissions policy capability");
    capabilities.splice(permissionsIndex + 1, 0, UPGRADE_CAPABILITY);

    const runner = expectedContracts["contract/runner.v1.json"];
    const newRunner = newContracts["contract/runner.v1.json"];
    assert(!runner.commands.includes(UPGRADE_RUNNER_COMMAND), "Permissions upgrade command must be new in this transition");
    assert(newRunner.commands.includes(UPGRADE_RUNNER_COMMAND), "Permissions upgrade command differs from producer");
    assert.deepEqual([...newRunner.commands].sort(), [...runner.commands, UPGRADE_RUNNER_COMMAND].sort(),
      "Permissions upgrade runner commands require exactly the reviewed upgrade addition");
    runner.commands = structuredClone(newRunner.commands);

    assert.equal(runner.permissions?.semantics, PERMISSIONS_RUNNER.semantics,
      "Permissions upgrade requires the previous permissions semantics");
    assert.equal(newRunner.permissions?.semantics, UPGRADE_PERMISSIONS_SEMANTICS,
      "Permissions upgrade runner semantics differs from producer");
    runner.permissions.semantics = UPGRADE_PERMISSIONS_SEMANTICS;

    const schema = expectedContracts["contract/schemas/runner-response.v1.schema.json"];
    const newSchema = newContracts["contract/schemas/runner-response.v1.schema.json"];
    const oldCommands = schema.properties?.command?.enum;
    const newCommands = newSchema.properties?.command?.enum;
    if (Array.isArray(oldCommands) && Array.isArray(newCommands) && !oldCommands.includes(UPGRADE_RUNNER_COMMAND)) {
      assert(newCommands.includes(UPGRADE_RUNNER_COMMAND), "Permissions upgrade runner schema differs from producer");
      assert.deepEqual([...newCommands].sort(), [...oldCommands, UPGRADE_RUNNER_COMMAND].sort(),
        "Permissions upgrade runner schema requires exactly the reviewed upgrade addition");
      schema.properties.command.enum = structuredClone(newCommands);
    }
    const oldOneOf = schema.oneOf;
    const newOneOf = newSchema.oneOf;
    if (Array.isArray(oldOneOf) && Array.isArray(newOneOf) && !oldOneOf.some((entry) => entry?.properties?.command?.const === UPGRADE_RUNNER_COMMAND)) {
      const upgradeEntries = newOneOf.filter((entry) => entry?.properties?.command?.const === UPGRADE_RUNNER_COMMAND);
      assert.deepEqual(upgradeEntries, UPGRADE_ONEOF_ENTRIES,
        "Permissions upgrade runner schema oneOf differs from producer");
      assert.deepEqual(newOneOf.filter((entry) => entry?.properties?.command?.const !== UPGRADE_RUNNER_COMMAND), oldOneOf,
        "Permissions upgrade runner schema oneOf requires exactly the reviewed upgrade addition");
      schema.oneOf = structuredClone(newOneOf);
    }
    const lifecycleResult = schema.$defs?.lifecycleResult;
    const newLifecycleResult = newSchema.$defs?.lifecycleResult;
    if (lifecycleResult && newLifecycleResult && !("policySha256" in (lifecycleResult.properties ?? {}))) {
      assert.deepEqual(newLifecycleResult.properties?.policySha256, UPGRADE_POLICY_SHA256,
        "Permissions upgrade policy hash schema differs from producer");
      const restNew = structuredClone(newLifecycleResult);
      delete restNew.properties.policySha256;
      assert.deepEqual(restNew, lifecycleResult,
        "Permissions upgrade lifecycle result requires exactly the reviewed policy hash addition");
      lifecycleResult.properties.policySha256 = structuredClone(UPGRADE_POLICY_SHA256);
    }
    const lifecycleAction = schema.$defs?.lifecycleAction;
    const newLifecycleAction = newSchema.$defs?.lifecycleAction;
    if (lifecycleAction && newLifecycleAction && !lifecycleAction.enum?.includes(UPGRADE_LIFECYCLE_ACTION)) {
      assert(newLifecycleAction.enum?.includes(UPGRADE_LIFECYCLE_ACTION),
        "Permissions upgrade lifecycle action differs from producer");
      assert.deepEqual([...newLifecycleAction.enum].sort(), [...lifecycleAction.enum, UPGRADE_LIFECYCLE_ACTION].sort(),
        "Permissions upgrade lifecycle actions require exactly the reviewed upgrade addition");
      lifecycleAction.enum = structuredClone(newLifecycleAction.enum);
    }
  }
  const experienceEnabled = newContracts[rootContract].capabilities.includes(EXPERIENCE_CAPABILITY);
  const experienceTransition = acceptExperienceDefaults
    && !oldContracts[rootContract].capabilities.includes(EXPERIENCE_CAPABILITY)
    && experienceEnabled;
  if (experienceTransition) {
    assert(oldContracts[rootContract].capabilities.includes(PERMISSIONS_CAPABILITY) && permissionsEnabled,
      "Experience defaults require the permissions policy capability");
    const capabilities = expectedContracts[rootContract].capabilities;
    assert(!capabilities.includes(EXPERIENCE_CAPABILITY), "Experience defaults capability must be new in this transition");
    const permissionsIndex = capabilities.indexOf(PERMISSIONS_CAPABILITY);
    assert(permissionsIndex >= 0, "Experience defaults require the existing permissions policy capability");
    capabilities.splice(permissionsIndex + 1, 0, EXPERIENCE_CAPABILITY);

    const runner = expectedContracts["contract/runner.v1.json"];
    assert.equal(runner.experience, undefined, "Experience defaults runner metadata must be new in this transition");
    runner.experience = structuredClone(EXPERIENCE_RUNNER);

    const assets = expectedContracts["contract/assets.v1.json"];
    const settingsWrite = assets.managedExternalWrites.find((item) => item.relativePath === "settings.json");
    assert(settingsWrite, "Experience defaults require the existing settings write");
    settingsWrite.semantics = EXPERIENCE_SETTINGS_SEMANTICS;
    assert(!assets.managedExternalWrites.some((item) => item.relativePath === EXPERIENCE_RECEIPT_WRITE.relativePath),
      "Experience defaults receipt write must be new in this transition");
    assets.managedExternalWrites.push(structuredClone(EXPERIENCE_RECEIPT_WRITE));

    const schema = expectedContracts["contract/schemas/runner-response.v1.schema.json"];
    const lifecycleResult = schema.$defs.lifecycleResult;
    assert.equal(lifecycleResult.properties.actions.maxItems, 32, "Experience defaults require the permissions lifecycle schema");
    const lifecycleAction = schema.$defs.lifecycleAction;
    assert(!EXPERIENCE_ACTIONS.some((action) => lifecycleAction.enum.includes(action)), "Experience defaults lifecycle actions must be new in this transition");
    lifecycleAction.enum.push(...EXPERIENCE_ACTIONS);
  }
  const initializationEnabled = newContracts[rootContract].capabilities.includes(INITIALIZATION_CAPABILITY);
  const initializationTransition = acceptInitializationDiagnostics
    && !oldContracts[rootContract].capabilities.includes(INITIALIZATION_CAPABILITY)
    && initializationEnabled;
  if (initializationTransition) {
    const capabilities = expectedContracts[rootContract].capabilities;
    assert(!capabilities.includes(INITIALIZATION_CAPABILITY), "Initialization diagnostics capability must be new in this transition");
    capabilities.push(INITIALIZATION_CAPABILITY);

    const runner = expectedContracts["contract/runner.v1.json"];
    const newRunner = newContracts["contract/runner.v1.json"];
    assert.equal(runner.experience?.diagnostic, undefined, "Initialization experience diagnostic must be new in this transition");
    assert.equal(newRunner.experience?.diagnostic, INITIALIZATION_EXPERIENCE_DIAGNOSTIC, "Initialization experience diagnostic differs from producer");
    runner.experience.diagnostic = INITIALIZATION_EXPERIENCE_DIAGNOSTIC;
    assert.equal(runner.permissions?.diagnostic, "permission state reports invalid or unreadable files without exposing their contents", "Initialization requires the previous permissions diagnostic");
    assert.equal(newRunner.permissions?.diagnostic, INITIALIZATION_PERMISSIONS_DIAGNOSTIC, "Initialization permissions diagnostic differs from producer");
    runner.permissions.diagnostic = INITIALIZATION_PERMISSIONS_DIAGNOSTIC;

    const schema = expectedContracts["contract/schemas/runner-response.v1.schema.json"];
    const newSchema = newContracts["contract/schemas/runner-response.v1.schema.json"];
    assert.equal(schema.$defs.experience, undefined, "Initialization experience schema must be new in this transition");
    assert.deepEqual(newSchema.$defs.experience, INITIALIZATION_EXPERIENCE_SCHEMA, "Initialization experience schema differs from producer");
    schema.$defs.experience = structuredClone(INITIALIZATION_EXPERIENCE_SCHEMA);
    const statusResult = schema.$defs.statusResult;
    assert.deepEqual(statusResult.required, ["installation", "engram", "context7", "permissions"]);
    statusResult.required.push("experience");
    assert.equal(statusResult.properties.experience, undefined);
    statusResult.properties.experience = { $ref: "#/$defs/experience" };
    const doctorChecks = schema.$defs.doctorResult.properties.checks;
    assert.equal(doctorChecks.minItems, 4);
    assert.equal(doctorChecks.maxItems, 4);
    assert.deepEqual(doctorChecks.items.properties.id.enum, ["package", "engram", "context7", "permissions"]);
    doctorChecks.prefixItems = ["package", "engram", "context7", "permissions", "experience"].map((id) => ({
      type: "object",
      additionalProperties: false,
      required: ["id", "status"],
      properties: { id: { const: id }, status: { enum: ["ok", "error"] } },
    }));
    doctorChecks.minItems = 5;
    doctorChecks.maxItems = 5;
    doctorChecks.items = false;
  }
  let engramChildOnlyTransition = false;
  if (acceptEngramChildOnly) {
    const oldAgents = oldContracts["contract/runtime-agents.v1.json"];
    const newAgents = newContracts["contract/runtime-agents.v1.json"];
    const matches = (left, right) => {
      try {
        assert.deepEqual(left, right);
        return true;
      } catch {
        return false;
      }
    };
    const oldList = oldAgents?.agents;
    const newList = newAgents?.agents;
    const oldIndex = Array.isArray(oldList) ? oldList.findIndex((agent) => agent?.name === "engram") : -1;
    const newIndex = Array.isArray(newList) ? newList.findIndex((agent) => agent?.name === "engram") : -1;
    const oldEngram = oldIndex !== -1 ? oldList[oldIndex] : undefined;
    const newEngram = newIndex !== -1 ? newList[newIndex] : undefined;
    const { subagentOnlyExtensions: _dropped, ...newRest } = newEngram ?? {};
    const otherAgentsEqual = Array.isArray(oldList) && Array.isArray(newList)
      && oldList.length === newList.length
      && oldList.every((agent, index) => index === oldIndex || matches(newList[index], agent));
    const otherKeysEqual = Boolean(oldAgents) && Boolean(newAgents)
      && matches(Object.keys(newAgents).sort(), Object.keys(oldAgents).sort())
      && Object.keys(oldAgents).every((key) => key === "agents" || key === "schemaVersion" || matches(newAgents[key], oldAgents[key]));
    if (oldAgents?.schemaVersion === 1
      && newAgents?.schemaVersion === 1
      && oldIndex !== -1
      && newIndex === oldIndex
      && oldEngram?.subagentOnlyExtensions === undefined
      && matches(newEngram?.subagentOnlyExtensions, [ENGRAM_CHILD_ROUTE])
      && matches(newRest, oldEngram)
      && otherAgentsEqual
      && otherKeysEqual) {
      expectedContracts["contract/runtime-agents.v1.json"] = structuredClone(newAgents);
      engramChildOnlyTransition = true;
    }
  }
  if (acceptPiVersion !== undefined) {
    const pi = expectedContracts[rootContract].pi;
    pi.testedVersions = [...new Set([...pi.testedVersions, acceptPiVersion])].sort(compareVersions);
    pi.minimumVersion = pi.testedVersions[0];
    pi.maximumVersion = pi.testedVersions.at(-1);
  }
  const capability = "chrome-devtools-handoff-v1";
  if (acceptDevtoolsHandoff
    && !oldContracts[rootContract].capabilities.includes(capability)
    && newContracts[rootContract].capabilities.includes(capability)) {
    const capabilities = expectedContracts[rootContract].capabilities;
    const runnerIndex = capabilities.indexOf("runner-json-v1");
    assert(runnerIndex >= 0, "DevTools handoff requires the existing JSON runner");
    capabilities.splice(runnerIndex, 0, capability);
    const exclusions = expectedContracts[PARITY].exclusions;
    const matches = exclusions.filter((item) => item.kind === "capability-integration" && item.id === "chrome-devtools-capability-handoff");
    assert.equal(matches.length, 1, "DevTools handoff requires exactly one former exclusion");
    assert.deepEqual(matches[0], { kind: "capability-integration", id: "chrome-devtools-capability-handoff" });
    exclusions.splice(exclusions.indexOf(matches[0]), 1);
  }
  const playwrightCapability = "playwright-handoff-v1";
  const playwrightTransition = acceptPlaywrightHandoff
    && !oldContracts[rootContract].capabilities.includes(playwrightCapability)
    && newContracts[rootContract].capabilities.includes(playwrightCapability);
  if (playwrightTransition) {
    const capabilities = expectedContracts[rootContract].capabilities;
    const runnerIndex = capabilities.indexOf("runner-json-v1");
    assert(runnerIndex >= 0, "Playwright handoff requires the existing JSON runner");
    capabilities.splice(runnerIndex, 0, playwrightCapability);
  }
  const skillName = "playwright-cli";
  const skillSource = "stack/skills/playwright-cli";
  const skillTarget = "skills/playwright-cli";
  const skills = expectedContracts[PARITY].skills;
  const skillIndex = skills.findIndex((skill) => skill.name === skillName);
  const playwrightSkillRemoval = acceptPlaywrightSkillRemoval && skillIndex !== -1
    && !newContracts[PARITY].skills.some((skill) => skill.name === skillName);
  if (playwrightSkillRemoval) {
    assert.equal(skills.filter((skill) => skill.name === skillName).length, 1, "Playwright skill must have one canonical entry");
    assert.equal(skills[skillIndex].sourcePath, skillSource, "Unexpected Playwright skill source");
    assert.equal(skills[skillIndex].targetPath, skillTarget, "Unexpected Playwright skill target");
    assert.equal(git(piDir, ["ls-tree", "--name-only", producer, "--", skillTarget]).trim(), "", "Playwright skill must be absent from producer");
    assert.equal(git(root, ["ls-tree", "--name-only", sourceCommit, "--", skillSource]).trim(), "", "Playwright skill must be absent from Stack source");
    skills.splice(skillIndex, 1);
  }
  for (const member of CONTRACTS) {
    assert.deepEqual(comparable(member, newContracts[member]), comparable(member, expectedContracts[member]), `${member} compatibility requires manual review`);
  }
  assert.equal(newContracts["package.json"].name, "jorgex-pi");
  assert.equal(newContracts["package.json"].version, version);
  assert.deepEqual(newContracts["contract/jorgex-pi.v1.json"].package, { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` });
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
    if (playwrightTransition || playwrightSkillRemoval || modularTransition || context7Transition || permissionsTransition || experienceTransition || initializationTransition || upgradeTransition || engramChildOnlyTransition) {
      const previousFile = join(stage, "previous.tgz");
      const previousTarball = await downloadTarball(fetch,
        `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${current.package.version}.tgz`, previousFile,
        `sha512-${Buffer.from(current.tarball.sha512, "hex").toString("base64")}`);
      assert.deepEqual(previousTarball, current.tarball, "Previous pinned tarball differs");
      const previousEntries = archiveEntries(previousFile);
      assert.equal(previousEntries.length, artifacts.archive.entries, "Previous archive inventory differs");
      let expectedEntries = [...previousEntries];
      if (playwrightSkillRemoval) {
        const prefix = `package/${skillTarget}`;
        assert(previousEntries.includes(`${prefix}/SKILL.md`), "Playwright skill must exist in the previous archive");
        expectedEntries = expectedEntries.filter((entry) => entry !== prefix && !entry.startsWith(`${prefix}/`));
      }
      if (playwrightTransition) {
        const module = "extensions/playwright.ts";
        assert.equal(git(piDir, ["ls-tree", "--name-only", current.provenance.commit, "--", module]).trim(), "", "Playwright module must be new in this transition");
        assert(!previousEntries.includes(`package/${module}`), "Playwright module must be absent from the previous archive");
        expectedEntries.push(`package/${module}`);
      }
      if (modularTransition) {
        for (const { metadata: { targetPath } } of promptModules) {
          assert.equal(git(piDir, ["ls-tree", "--name-only", current.provenance.commit, "--", targetPath]).trim(), "",
            "Modular system prompt asset must be new in this transition");
          assert(!previousEntries.includes(`package/${targetPath}`), "Modular system prompt asset must be absent from the previous archive");
          expectedEntries.push(`package/${targetPath}`);
        }
      }
      if (context7Transition) {
        assert.equal(git(piDir, ["ls-tree", "--name-only", current.provenance.commit, "--", CONTEXT7_MODULE]).trim(), "", "Context7 module must be new in this transition");
        assert(!previousEntries.includes(`package/${CONTEXT7_MODULE}`), "Context7 module must be absent from the previous archive");
        expectedEntries.push(`package/${CONTEXT7_MODULE}`);
      }
      if (permissionsTransition) {
        for (const member of [PERMISSIONS_TARGET_PATH, PERMISSIONS_MODULE]) {
          assert.equal(git(piDir, ["ls-tree", "--name-only", current.provenance.commit, "--", member]).trim(), "", `Permissions asset must be new in this transition: ${member}`);
          assert(!previousEntries.includes(`package/${member}`), `Permissions asset must be absent from the previous archive: ${member}`);
          expectedEntries.push(`package/${member}`);
        }
      }
      if (engramChildOnlyTransition) {
        assert.equal(git(piDir, ["ls-tree", "--name-only", current.provenance.commit, "--", ENGRAM_CHILD_MEMBER]).trim(), "", "Engram child module must be new in this transition");
        assert(!previousEntries.includes(`package/${ENGRAM_CHILD_MEMBER}`), "Engram child module must be absent from the previous archive");
        expectedEntries.push(`package/${ENGRAM_CHILD_MEMBER}`);
      }
      const changes = [playwrightTransition && "module addition", playwrightSkillRemoval && "skill removal", modularTransition && "modular system prompt additions", context7Transition && "Context7 module addition", permissionsTransition && "permissions assets additions", experienceTransition && "experience defaults contract", initializationTransition && "initialization diagnostics contract", upgradeTransition && "permissions upgrade contract", engramChildOnlyTransition && "Engram child-only addition"].filter(Boolean).join(" and ");
      assert.deepEqual([...entries].sort(), expectedEntries.sort(),
        `${engramChildOnlyTransition ? "Engram child-only" : modularTransition ? "Modular system prompt" : (playwrightTransition || playwrightSkillRemoval) ? "Playwright" : context7Transition ? "Context7" : permissionsTransition ? "Permissions policy" : experienceTransition ? "Experience defaults" : upgradeTransition ? "Permissions upgrade" : "Initialization diagnostics"} archive inventory requires exactly the reviewed ${changes}`);
      if (playwrightTransition) {
        const module = "extensions/playwright.ts";
        assert.equal(tarText(tarballFile, module), git(piDir, ["show", `${producer}:${module}`]), "Playwright module does not match producer");
      }
      if (context7Transition) assert.equal(tarText(tarballFile, CONTEXT7_MODULE), git(piDir, ["show", `${producer}:${CONTEXT7_MODULE}`]), "Context7 module does not match producer");
      if (engramChildOnlyTransition) assert.equal(tarText(tarballFile, ENGRAM_CHILD_MEMBER), git(piDir, ["show", `${producer}:${ENGRAM_CHILD_MEMBER}`]), "Engram child module does not match producer");
      if (experienceTransition) assert.equal(entries.length, previousEntries.length, "Experience defaults must preserve the previous archive inventory");
      if (initializationTransition) assert.equal(entries.length, previousEntries.length, "Initialization diagnostics must preserve the previous archive inventory");
      if (upgradeTransition) assert.equal(entries.length, previousEntries.length, "Permissions upgrade must preserve the previous archive inventory");
    } else {
      assert.equal(entries.length, artifacts.archive.entries, "Archive inventory changes require manual review");
    }
    if (permissionsEnabled) {
      const permissionsDefaults = tarText(tarballFile, PERMISSIONS_TARGET_PATH);
      assert.equal(permissionsDefaults, git(piDir, ["show", `${producer}:${PERMISSIONS_TARGET_PATH}`]), "Permissions defaults do not match producer");
      assert.equal(createHash("sha256").update(permissionsDefaults).digest("hex"), permissionsMetadata.outputSha256, "Permissions defaults hash does not match parity");
      assert.equal(tarText(tarballFile, PERMISSIONS_MODULE), git(piDir, ["show", `${producer}:${PERMISSIONS_MODULE}`]), "Permissions lifecycle module does not match producer");
    }
    if (experienceEnabled) assert.equal(tarText(tarballFile, EXPERIENCE_BIN), git(piDir, ["show", `${producer}:${EXPERIENCE_BIN}`]), "Experience runner does not match producer");
    for (const { metadata: { targetPath }, content } of promptModules) {
      assert.equal(tarText(tarballFile, targetPath), content, "Modular system prompt archive bytes differ from the reviewed source");
    }
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
    const nextArtifacts = { current: pin, previous: current, archive: { entries: entries.length, parity: { source: { commit: sourceCommit } } } };
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
    const flags = args.slice(4);
    const versionFlag = flags.indexOf("--accept-pi-version");
    let acceptPiVersion;
    if (versionFlag !== -1) {
      acceptPiVersion = flags[versionFlag + 1];
      versionParts(acceptPiVersion);
      flags.splice(versionFlag, 2);
    }
    if (args.length < 4 || args.length > 16 || args[0] !== "--pi-dir" || args[2] !== "--version"
      || new Set(flags).size !== flags.length || flags.some((flag) => !["--apply", "--accept-devtools-handoff", "--accept-playwright-handoff", "--accept-playwright-skill-removal", "--accept-modular-system-prompts", "--accept-context7-http", "--accept-permissions-policy", "--accept-experience-defaults", "--accept-initialization-diagnostics", "--accept-permissions-upgrade", "--accept-engram-child-only"].includes(flag))) throw new Error("Invalid arguments");
    const result = await preparePiAdoption({ root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."), piDir: args[1], version: args[3],
      acceptPiVersion, apply: flags.includes("--apply"), acceptDevtoolsHandoff: flags.includes("--accept-devtools-handoff"), acceptPlaywrightHandoff: flags.includes("--accept-playwright-handoff"),
      acceptPlaywrightSkillRemoval: flags.includes("--accept-playwright-skill-removal"), acceptModularSystemPrompts: flags.includes("--accept-modular-system-prompts"), acceptContext7Http: flags.includes("--accept-context7-http"), acceptPermissionsPolicy: flags.includes("--accept-permissions-policy"), acceptExperienceDefaults: flags.includes("--accept-experience-defaults"), acceptInitializationDiagnostics: flags.includes("--accept-initialization-diagnostics"), acceptPermissionsUpgrade: flags.includes("--accept-permissions-upgrade"), acceptEngramChildOnly: flags.includes("--accept-engram-child-only") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error.recoveryPath ? `Adoption failed; recovery retained at ${error.recoveryPath}` : "Adoption failed. Check refs, compatibility and checkout cleanliness. Usage: --pi-dir ABS --version X.Y.Z [--apply] [--accept-devtools-handoff] [--accept-playwright-handoff] [--accept-pi-version X.Y.Z] [--accept-playwright-skill-removal] [--accept-modular-system-prompts] [--accept-context7-http] [--accept-permissions-policy] [--accept-experience-defaults] [--accept-initialization-diagnostics] [--accept-permissions-upgrade] [--accept-engram-child-only]");
    process.exitCode = 1;
  }
}
