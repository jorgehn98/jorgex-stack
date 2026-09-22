import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type PreparePiAdoption = (
  input: {
    root: string;
    piDir: string;
    version: string;
    apply?: boolean;
    acceptDevtoolsHandoff?: boolean;
    acceptPlaywrightHandoff?: boolean;
    acceptPlaywrightSkillRemoval?: boolean;
    acceptModularSystemPrompts?: boolean;
    acceptContext7Http?: boolean;
    acceptPermissionsPolicy?: boolean;
    acceptExperienceDefaults?: boolean;
    acceptInitializationDiagnostics?: boolean;
    acceptPermissionsUpgrade?: boolean;
    acceptEngramChildOnly?: boolean;
    acceptOfficialEngram?: boolean;
    acceptEngramProtocolRemoval?: boolean;
    acceptPiVersion?: string;
  },
  dependencies?: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
) => Promise<{
  status: "unchanged" | "prepared";
  version: string;
  changedPaths: string[];
}>;

const adoptionModuleUrl = new URL("../.github/scripts/prepare-pi-adoption.mjs", import.meta.url).href;
const PIN_PATH = "src/lib/pi-runtime-pin.json";
const ARTIFACTS_PATH = "tests/fixtures/pi-runtime-artifacts.json";
const tarballUrl = (version: string) => `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
const temporaryRoots: string[] = [];
const PLAYWRIGHT_SKILL_FILES = ["SKILL.md", "references/guide.md"] as const;
const MODULAR_SYSTEM_PROMPT_MODULES = [
  {
    name: "context7",
    sourcePath: "stack/system-prompt/context7.md",
    targetPath: "assets/system-prompt/context7.md",
  },
  {
    name: "playwright",
    sourcePath: "stack/system-prompt/browser-playwright.md",
    targetPath: "assets/system-prompt/browser-playwright.md",
  },
  {
    name: "chrome-devtools",
    sourcePath: "stack/system-prompt/browser-chrome-devtools.md",
    targetPath: "assets/system-prompt/browser-chrome-devtools.md",
  },
] as const;
const MODULAR_CAPABILITY = "modular-system-prompts-v1";
const CONTEXT7_CAPABILITY = "context7-http-v1";
const CONTEXT7_RUNNER_CONTRACT = {
  transport: "http",
  registration: "isolated in-memory bridge at Pi bootstrap",
  diagnostic: "available means configuration permits registration; no HTTP handshake is implied",
  conflicts: "preserve existing MCP files; block managed Context7 activation",
  cleanup: "no managed MCP configuration or credentials are written",
} as const;
const CONTEXT7_PRESERVED_MCP = {
  owner: "user",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "mcp.json",
} as const;
const CONTEXT7_EXTENSION_CONTENT = "export const context7Http = true;\n";
const CONTEXT7_TRANSITION_FIXTURE = {
  previousModularSystemPrompts: true,
  modularSystemPrompts: true,
  previousDevtoolsHandoff: true,
  devtoolsHandoff: true,
  previousPlaywrightHandoff: true,
  playwrightHandoff: true,
  context7Http: true,
} as const;
const PERMISSIONS_TRANSITION_FIXTURE = {
  previousModularSystemPrompts: true,
  modularSystemPrompts: true,
  previousContext7Http: true,
  context7Http: true,
  previousDevtoolsHandoff: true,
  devtoolsHandoff: true,
  previousPlaywrightHandoff: true,
  playwrightHandoff: true,
  permissionsPolicy: true,
} as const;
const PERMISSIONS_CAPABILITY = "permissions-policy-v1";
const PERMISSIONS_SOURCE_PATH = "stack/config/defaults.json";
const PERMISSIONS_TARGET_PATH = "assets/permissions/defaults.json";
const PERMISSIONS_RESOURCE = "assets/permissions";
const PERMISSIONS_MODULE = "extensions/permissions-lifecycle.mjs";
const PERMISSIONS_DEFAULTS_OUTPUT = "{\n  \"permission\": {\n    \"*\": \"ask\"\n  }\n}\n";
const PERMISSIONS_RUNNER_CONTRACT = {
  config: "PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json",
  receipt: "PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json",
  defaults: "assets/permissions/defaults.json",
  semantics: "sync seeds only an absent config through exclusive publication; existing, invalid, and concurrent user state is preserved; cleanup keeps an exact owned copy in a retained backup",
  diagnostic: "permission state reports invalid or unreadable files without exposing their contents",
} as const;
const UPGRADE_PERMISSIONS_SEMANTICS =
  "sync seeds only an absent config through exclusive publication; an explicit upgrade rewrites an absent or owned-stale config with a prior byte-exact backup, exclusive publication, and a versioned receipt; existing, invalid, and concurrent user state is preserved; cleanup keeps an exact owned copy in a retained backup";
const UPGRADE_LIFECYCLE_ACTION = "upgraded:permissions.config";
const UPGRADE_POLICY_SHA256 = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const UPGRADE_ONEOF_ENTRIES = [
  {
    properties: { command: { const: "upgrade" }, ok: { const: true }, result: { $ref: "#/$defs/lifecycleResult" } },
    not: { required: ["error"] },
  },
  {
    properties: { command: { const: "upgrade" }, ok: { const: false }, result: { $ref: "#/$defs/lifecycleResult" } },
    required: ["error"],
  },
] as const;
const PERMISSIONS_PRESERVED_STATE = {
  owner: "@gotgenes/pi-permission-system",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "extensions/pi-permission-system/config.json",
} as const;
const BASE_MANAGED_EXTERNAL_WRITES = [
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "settings.json",
    semantics: "merge a missing or matching partial defaultProvider=openai-codex and defaultModel=gpt-5.6-sol pair; preserve foreign halves; cleanup removes only receipt-owned exact values",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "models.json",
    semantics: "merge missing providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow=872000; cleanup removes only receipt-owned exact values",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/sol-lifecycle.v1.json",
    semantics: "record field, container, and file ownership; remove the receipt when empty",
  },
] as const;
const PERMISSIONS_MANAGED_EXTERNAL_WRITES = [
  ...BASE_MANAGED_EXTERNAL_WRITES,
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
] as const;
const PERMISSIONS_ACTIONS = [
  "created:permissions.config",
  "initialized:permissions",
  "preserved:permissions.config",
  "released:permissions.config",
  "backup:permissions.config",
  "removed:permissions.config",
] as const;
const EXPERIENCE_CAPABILITY = "experience-defaults-v1";
const EXPERIENCE_BIN_CONTENT = "export const experienceDefaults = true;\n";
const EXPERIENCE_RUNNER_CONTRACT = {
  settings: "PI_CODING_AGENT_DIR/settings.json",
  receipt: "PI_CODING_AGENT_DIR/jorgex-pi/experience-lifecycle.v1.json",
  defaults: {
    theme: "JorgeX",
    quietStartup: true,
    hideThinkingBlock: true,
  },
  initialization: "first sync only",
  ownership: "missing fields only; cleanup removes exact package-owned values and preserves replacements",
} as const;
const EXPERIENCE_RECEIPT_WRITE = {
  owner: "jorgex-pi",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "jorgex-pi/experience-lifecycle.v1.json",
  semantics: "record first initialization and exact ownership of missing theme, quietStartup, and hideThinkingBlock fields; preserve replacements and do not reseed after initialization",
} as const;
const EXPERIENCE_SETTINGS_SEMANTICS = "merge a missing or matching partial defaultProvider=openai-codex and defaultModel=gpt-5.6-sol pair plus first-visit theme=JorgeX, quietStartup=true, and hideThinkingBlock=true defaults; preserve foreign halves and existing experience values; cleanup removes only receipt-owned exact values";
const EXPERIENCE_MANAGED_EXTERNAL_WRITES = [
  { ...PERMISSIONS_MANAGED_EXTERNAL_WRITES[0], semantics: EXPERIENCE_SETTINGS_SEMANTICS },
  ...PERMISSIONS_MANAGED_EXTERNAL_WRITES.slice(1),
  EXPERIENCE_RECEIPT_WRITE,
] as const;
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
] as const;
const EXPERIENCE_TRANSITION_FIXTURE = {
  previousModularSystemPrompts: true,
  modularSystemPrompts: true,
  previousContext7Http: true,
  context7Http: true,
  previousPermissionsPolicy: true,
  permissionsPolicy: true,
  experienceDefaults: true,
} as const;
const BASE_LIFECYCLE_ACTIONS = [
  "created:settings.defaultProvider",
  "created:settings.defaultModel",
  "created:models.providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow",
  "released:settings.defaultProvider",
  "released:settings.defaultModel",
  "released:models.providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow",
  "removed:settings.defaultProvider",
  "removed:settings.defaultModel",
  "removed:models.providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow",
  "created:models.providers",
  "created:models.providers.openai-codex",
  "created:models.providers.openai-codex.modelOverrides",
  "created:models.providers.openai-codex.modelOverrides.gpt-5.6-sol",
  "pruned:models.providers",
  "pruned:models.providers.openai-codex",
  "pruned:models.providers.openai-codex.modelOverrides",
  "pruned:models.providers.openai-codex.modelOverrides.gpt-5.6-sol",
  "created:settings.json",
  "created:models.json",
  "removed:settings.json",
  "removed:models.json",
] as const;
const MODULAR_BASELINE_EXCLUSIONS = [
  { kind: "capability-integration", id: "context7-mcp" },
  { kind: "capability-integration", id: "post-pr-shell-hook-translation" },
  { kind: "capability-integration", id: "programmatic-mode-negotiation" },
  { kind: "runtime-specific-overlay", sourcePath: "stack/commands/claude-code/xreview.md" },
  { kind: "runtime-specific-overlay", sourcePath: "stack/commands/opencode/xreview.md" },
] as const;
const LEGACY_BROWSER_EXCLUSIONS = [
  { kind: "runtime-specific-overlay", sourcePath: "stack/system-prompt/browser-chrome-devtools.md" },
  { kind: "runtime-specific-overlay", sourcePath: "stack/system-prompt/browser-playwright.md" },
] as const;
const ENGRAM_CHILD_MEMBER = "extensions/engram-child.ts";
const ENGRAM_CHILD_ROUTE = "../extensions/engram-child.ts";
const ENGRAM_CHILD_CONTENT = "export const engramChild = true;\n";
const ENGRAM_BASELINE_TOOLS = ["mem_context", "mem_search", "mem_get_observation"] as const;
const ENGRAM_BASELINE_CAPABILITY = "engram-runtime-tools-v1";
const ENGRAM_BASELINE_MAX_DEPTH = 1;
const OFFICIAL_ENGRAM_CAPABILITY = "engram-official-bridge-v1";
const REMOVED_MCP_ADAPTER_CAPABILITY = "mcp-adapter-v1";
const ENGRAM_MCP_WRAPPER_MEMBER = "extensions/engram-mcp-wrapper.mjs";
const ENGRAM_MCP_WRAPPER_CONTENT = "export const engramMcpWrapper = true;\n";
const OFFICIAL_CLOSURE_SENTINEL = "fixture.txt";
// Exactos `package/node_modules/<root>` retirados entre los tarballs publicados
// 0.8.27 y 0.8.28 (derivado read-only: cubren las 1109 entradas node_modules
// eliminadas, 0 añadidas; cada raíz queda totalmente ausente en 0.8.28).
const OFFICIAL_REMOVED_NODE_ROOTS = [
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/core",
  "@modelcontextprotocol/ext-apps",
  "@napi-rs/keyring",
  "@napi-rs/keyring-darwin-arm64",
  "@napi-rs/keyring-darwin-x64",
  "@napi-rs/keyring-linux-arm-gnueabihf",
  "@napi-rs/keyring-linux-arm64-gnu",
  "@napi-rs/keyring-linux-arm64-musl",
  "@napi-rs/keyring-linux-riscv64-gnu",
  "@napi-rs/keyring-linux-x64-gnu",
  "@napi-rs/keyring-linux-x64-musl",
  "@napi-rs/keyring-win32-arm64-msvc",
  "@napi-rs/keyring-win32-ia32-msvc",
  "@napi-rs/keyring-win32-x64-msvc",
  "@pkgr/core",
  "@standard-schema/spec",
  "ajv",
  "ajv-formats",
  "bundle-name",
  "cross-spawn",
  "default-browser",
  "default-browser-id",
  "define-lazy-prop",
  "eventsource",
  "eventsource-parser",
  "fast-deep-equal",
  "fast-uri",
  "is-docker",
  "is-inside-container",
  "is-wsl",
  "isexe",
  "jose",
  "json-schema-traverse",
  "open",
  "path-key",
  "pi-mcp-adapter",
  "pkce-challenge",
  "recheck",
  "recheck-jar",
  "recheck-linux-x64",
  "recheck-macos-arm64",
  "recheck-macos-x64",
  "recheck-windows-x64",
  "require-from-string",
  "run-applescript",
  "shebang-command",
  "shebang-regex",
  "smol-toml",
  "synckit",
  "tslib",
  "which",
  "wsl-utils",
] as const;
const OFFICIAL_REMOVED_EXTENSION_MEMBERS = [ENGRAM_CHILD_MEMBER, ENGRAM_MCP_WRAPPER_MEMBER] as const;
const REMOVED_ADAPTER_DEPENDENCY = "pi-mcp-adapter";
const REMOVED_ADAPTER_VERSION = "2.27.0";
const ADDED_JSONC_DEPENDENCY = "strip-json-comments";
const ADDED_JSONC_VERSION = "5.0.3";
const OFFICIAL_BUNDLE_BASE = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
] as const;
const REMOVED_ADAPTER_COMPONENT = {
  name: "pi-mcp-adapter",
  status: "active",
  version: "2.27.0",
  license: "MIT",
  integrity: "sha512-IM9dfGhou5Q5AJqwkm1kW1+WXyMsvL53GEO4JVYukzvTxNPHn2b+Zi49+JAnOhlaOpEq5vEodUSJXmpghik+lw==",
  purpose: "Pi-native MCP transport and tool exposure.",
} as const;
const PRESERVED_ADAPTER_CACHE = {
  owner: "pi-mcp-adapter",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "mcp-cache.json",
} as const;
const PRESERVED_OFFICIAL_CACHE = {
  owner: "official-engram-setup",
  root: "PI_CODING_AGENT_DIR",
  relativePath: "mcp-cache.json",
} as const;
const OFFICIAL_PRESERVED_ADDITIONS = [
  {
    owner: "official-engram-setup",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "npm/node_modules/gentle-engram",
  },
  {
    owner: "official-engram-setup",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "npm/node_modules/pi-mcp-adapter",
  },
  {
    owner: "engram",
    root: "HOME",
    relativePath: ".local/bin/engram",
  },
  {
    owner: "engram",
    root: "HOME",
    relativePath: ".engram",
  },
] as const;

const ENGRAM_PROTOCOL_SOURCE_PATH = "stack/system-prompt/engram-protocol.md";
const ENGRAM_PROTOCOL_TARGET_PATH = "assets/system-prompt/engram-protocol.md";
const ENGRAM_PROTOCOL_CONTENT = "fixture engram protocol\n";

function modularSystemPromptContent(sourcePath: string): string {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", sourcePath), "utf8");
}

function playwrightSkillContent(relativePath: string): string {
  return `legacy Playwright skill ${relativePath}\n`;
}

function permissionsSourceContent(): string {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", PERMISSIONS_SOURCE_PATH), "utf8");
}

function runnerResponseSchema(
  context7Http: boolean,
  context7SchemaMutation = false,
  permissionsPolicy = false,
  permissionsSchemaMutation = false,
  experienceDefaults = false,
): Record<string, unknown> {
  const oneOf = [
    { command: "status", ok: true, result: "#/$defs/statusResult", error: false },
    { command: "status", ok: false, result: "#/$defs/statusResult", error: true },
    { command: "doctor", ok: true, result: "#/$defs/doctorResult", error: false },
    { command: "doctor", ok: false, result: "#/$defs/doctorResult", error: true },
    { command: "models", ok: true, result: "#/$defs/modelsResult", error: false },
    { command: "sync", ok: true, result: "#/$defs/lifecycleResult", error: false },
    { command: "sync", ok: false, result: "#/$defs/lifecycleResult", error: true },
    { command: "cleanup", ok: true, result: "#/$defs/lifecycleResult", error: false },
    { command: "cleanup", ok: false, result: "#/$defs/lifecycleResult", error: true },
    { command: "unknown", ok: false, result: "#/$defs/emptyResult", error: true },
  ].map(({ command, ok, result, error }) => ({
    properties: { command: { const: command }, ok: { const: ok }, result: { $ref: result } },
    ...(error ? { required: ["error"] } : { not: { required: ["error"] } }),
  }));
  const context7 = {
    type: "object",
    additionalProperties: false,
    required: ["state"],
    properties: {
      state: { enum: ["available", "conflict", "invalid"] },
      source: { type: "string" },
      code: { type: "string" },
    },
  };
  if (context7Http && context7SchemaMutation) (context7 as Record<string, unknown>).unexpected = true;
  const permissions = {
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
  if (permissionsPolicy && permissionsSchemaMutation) (permissions as Record<string, unknown>).unexpected = true;
  const requiredStatus = ["installation", "engram"];
  const statusProperties: Record<string, unknown> = {
    installation: { $ref: "#/$defs/installation" },
    engram: { $ref: "#/$defs/engram" },
  };
  if (context7Http) {
    requiredStatus.push("context7");
    statusProperties.context7 = { $ref: "#/$defs/context7" };
  }
  if (permissionsPolicy) {
    requiredStatus.push("permissions");
    statusProperties.permissions = { $ref: "#/$defs/permissions" };
  }
  const statusResult = {
    type: "object",
    additionalProperties: false,
    required: requiredStatus,
    properties: statusProperties,
  };
  const checkIds = ["package", "engram"];
  if (context7Http) checkIds.push("context7");
  if (permissionsPolicy) checkIds.push("permissions");
  const doctorResult = {
    type: "object",
    additionalProperties: false,
    required: ["healthy", "checks"],
    properties: {
      healthy: { type: "boolean" },
      checks: {
        type: "array",
        minItems: checkIds.length,
        maxItems: checkIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "status"],
          properties: {
            id: { enum: checkIds },
            status: { enum: ["ok", "error"] },
          },
        },
      },
    },
  };
  const lifecycleResult = {
    type: "object",
    additionalProperties: false,
    required: ["changed", "actions"],
    properties: {
      changed: { type: "boolean" },
      actions: {
        type: "array",
        maxItems: permissionsPolicy ? 32 : 9,
        items: { $ref: "#/$defs/lifecycleAction" },
      },
    },
  };
  const lifecycleAction = {
    enum: [
      ...BASE_LIFECYCLE_ACTIONS,
      ...(permissionsPolicy ? PERMISSIONS_ACTIONS : []),
      ...(experienceDefaults ? EXPERIENCE_ACTIONS : []),
    ],
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://jorgex.dev/schemas/pi/runner-response.v1.schema.json",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "command", "ok", "package", "result"],
    properties: {
      schemaVersion: { const: 1 },
      command: { enum: ["status", "doctor", "models", "sync", "cleanup", "unknown"] },
      ok: { type: "boolean" },
      package: { $ref: "#/$defs/package" },
      result: { type: "object" },
      error: { $ref: "#/$defs/error" },
    },
    $defs: {
      ...(context7Http ? { context7 } : {}),
      ...(permissionsPolicy ? { permissions } : {}),
      statusResult,
      doctorResult,
      lifecycleResult,
      lifecycleAction,
    },
    oneOf,
  };
}

type Pin = {
  package: { name: "jorgex-pi"; version: string; source: string };
  provenance: { commit: string };
  tarball: { bytes: number; sha256: string; sha512: string };
};

type Artifacts = {
  current: Pin;
  previous: Pin;
  archive: { entries: number; parity: { source: { commit: string } } };
};

type PiVersionContract = {
  readonly minimumVersion: string;
  readonly maximumVersion: string;
  readonly testedVersions: readonly string[];
};

const DEFAULT_PI_VERSION_CONTRACT: PiVersionContract = {
  minimumVersion: "0.84.2",
  maximumVersion: "0.84.2",
  testedVersions: ["0.84.2"],
};

type AdoptionFixture = {
  root: string;
  piDir: string;
  version: string;
  current: Pin;
  next: Pin;
  sourceCommit: string;
  nextArchive: Artifacts["archive"];
  previousTarball: Buffer;
  tarball: Buffer;
};

function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    GIT_CONFIG_GLOBAL: path.join(root, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(root: string, args: string[], trimOutput = true): string {
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: isolatedGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  return trimOutput ? output.trim() : output;
}

function gitArchive(root: string, commit: string, withoutDirectoryEntries = false): Buffer {
  const archive = execFileSync("git", ["archive", "--format=tar.gz", "--prefix=package/", commit], {
    cwd: root,
    env: isolatedGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  return withoutDirectoryEntries ? normalizeArchiveWithoutDirectories(root, archive) : archive;
}

function normalizeArchiveWithoutDirectories(root: string, tarball: Buffer): Buffer {
  const workspace = fs.mkdtempSync(path.join(path.dirname(root), "tarball-normalize-"));
  const archive = path.join(workspace, "source.tgz");
  const extraction = path.join(workspace, "extract");
  const members = path.join(workspace, "members.txt");
  const normalized = path.join(workspace, "normalized.tgz");
  fs.writeFileSync(archive, tarball);
  fs.mkdirSync(extraction);
  try {
    execFileSync("tar", ["-xzf", archive, "-C", extraction], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    });
    const entries = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    }).trimEnd().split(/\r?\n/).filter((entry) => entry && !entry.endsWith("/"));
    fs.writeFileSync(members, `${entries.join("\n")}\n`, "utf8");
    execFileSync("tar", ["-czf", normalized, "--files-from", members], {
      cwd: extraction,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    });
    return fs.readFileSync(normalized);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function commit(root: string, message: string): string {
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function initializeGit(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "JorgeX adoption fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha512(value: Buffer): string {
  return createHash("sha512").update(value).digest("hex");
}

function pin(version: string, producer: string, tarball: Buffer): Pin {
  return {
    package: { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` },
    provenance: { commit: producer },
    tarball: { bytes: tarball.byteLength, sha256: sha256(tarball), sha512: sha512(tarball) },
  };
}

function writePiRelease(
  root: string,
  version: string,
  sourceCommit: string,
  options: {
    runnerCommands?: readonly string[];
    devtoolsHandoff?: boolean;
    devtoolsCapability?: boolean;
    devtoolsExclusion?: boolean;
    modularSystemPrompts?: boolean;
    context7Http?: boolean;
    context7RunnerMutation?: boolean;
    context7SchemaMutation?: boolean;
    context7AssetsMutation?: boolean;
    context7ParityMutation?: boolean;
    permissionsPolicy?: boolean;
    permissionsCapability?: boolean;
    permissionsRunnerMutation?: boolean;
    permissionsSchemaMutation?: boolean;
    permissionsAssetsMutation?: boolean;
    permissionsAssetsSubsetMutation?: boolean;
    permissionsAssetsDuplicateMutation?: boolean;
    permissionsParityMutation?: boolean;
    permissionsSourceParityMutation?: boolean;
    experienceDefaults?: boolean;
    experienceRunnerMutation?: boolean;
    engramBaseline?: boolean;
    engramChild?: boolean;
    engramChildRoute?: string;
    engramChildExtra?: boolean;
    engramToolsMutation?: boolean;
    engramOtherAgentMutation?: boolean;
    engramMcpWrapper?: boolean;
    bundledAdapterClosure?: boolean;
    bundledAdapterPackage?: boolean;
    bundledAdapterComponent?: boolean;
    bundledAdapterPreserved?: boolean;
    legacyBrowserExclusions?: boolean;
    extraSystemPromptModule?: {
      name: string;
      sourcePath: string;
      targetPath: string;
      content: string;
    };
    playwrightHandoff?: boolean;
    playwrightSkill?: boolean;
    playwrightSkillTree?: boolean;
    persistentControlSkill?: boolean;
    engramProtocol?: boolean;
    extraArchiveFile?: { path: string; content: string };
    removeArchiveFile?: string;
    rootContractMutation?: boolean;
    extraCapabilities?: readonly string[];
    piVersionContract?: PiVersionContract;
  } = {},
): void {
  const devtoolsCapability = options.devtoolsCapability ?? options.devtoolsHandoff ?? false;
  const devtoolsExclusion = options.devtoolsExclusion ?? !devtoolsCapability;
  const modularSystemPrompts = options.modularSystemPrompts ?? false;
  const context7Http = options.context7Http ?? false;
  const permissionsPolicy = options.permissionsPolicy ?? false;
  const permissionsCapability = options.permissionsCapability ?? permissionsPolicy;
  const experienceDefaults = options.experienceDefaults ?? false;
  const piVersionContract = options.piVersionContract ?? DEFAULT_PI_VERSION_CONTRACT;
  const playwrightSkillEnabled = options.playwrightSkill ?? false;
  const playwrightSkillTree = options.playwrightSkillTree ?? playwrightSkillEnabled;
  const capabilities = [
    "foundation-contract-v1",
    "stack-snapshot-v2",
    ...(modularSystemPrompts ? [MODULAR_CAPABILITY] : []),
    "runtime-agents-v1",
    "permission-gated-tools-v1",
    "structured-questions-v1",
    "web-access-v1",
    "goal-continuation-v1",
    "mcp-adapter-v1",
    "engram-runtime-tools-v1",
    ...(context7Http ? [CONTEXT7_CAPABILITY] : []),
    ...(permissionsCapability ? [PERMISSIONS_CAPABILITY] : []),
    ...(experienceDefaults ? [EXPERIENCE_CAPABILITY] : []),
    ...(devtoolsCapability ? ["chrome-devtools-handoff-v1"] : []),
    ...(options.playwrightHandoff ? ["playwright-handoff-v1"] : []),
    "runner-json-v1",
    "tui-branding-v1",
    "managed-primary-model-v1",
    "quality-receipt-contract-v1",
    "quality-capabilities-contract-v1",
    ...(options.extraCapabilities ?? []),
  ];
  const packageIdentity = { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` };
  writeJson(root, "package.json", {
    name: packageIdentity.name,
    version,
    type: "module",
    bin: { "jorgex-pi": "./bin/jorgex-pi.mjs" },
    files: ["agents", "assets", "bin", "contract", "extensions", "snapshot/agents"],
    dependencies: options.bundledAdapterPackage
      ? { "pi-web-access": "0.24.1", [REMOVED_ADAPTER_DEPENDENCY]: REMOVED_ADAPTER_VERSION }
      : { "pi-web-access": "0.24.1" },
    ...(options.bundledAdapterPackage
      ? { bundledDependencies: [...OFFICIAL_BUNDLE_BASE, REMOVED_ADAPTER_DEPENDENCY] }
      : {}),
  });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "jorgex-pi.mjs"), experienceDefaults ? EXPERIENCE_BIN_CONTENT : "export {};\n", "utf8");
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "tester.md"), "fixture agent\n", "utf8");
  fs.mkdirSync(path.join(root, "assets", "system-prompt"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "system-prompt", "AGENTS.md"), "fixture policy\n", "utf8");
  if (modularSystemPrompts) {
    for (const module of MODULAR_SYSTEM_PROMPT_MODULES) {
      fs.writeFileSync(path.join(root, module.targetPath), modularSystemPromptContent(module.sourcePath), "utf8");
    }
  }
  if (options.extraSystemPromptModule) {
    fs.writeFileSync(path.join(root, options.extraSystemPromptModule.targetPath), options.extraSystemPromptModule.content, "utf8");
  }
  fs.mkdirSync(path.join(root, "snapshot", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "snapshot", "agents", "tester.md"), "fixture agent\n", "utf8");
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(root, "extensions", "bootstrap.ts"), "export const bootstrap = true;\n", "utf8");
  const context7Extension = path.join(root, "extensions", "context7-config.mjs");
  if (context7Http) fs.writeFileSync(context7Extension, CONTEXT7_EXTENSION_CONTENT, "utf8");
  else if (fs.existsSync(context7Extension)) fs.unlinkSync(context7Extension);
  const permissionsModule = path.join(root, PERMISSIONS_MODULE);
  if (permissionsPolicy) fs.writeFileSync(permissionsModule, "export const permissionsLifecycle = true;\n", "utf8");
  else if (fs.existsSync(permissionsModule)) fs.unlinkSync(permissionsModule);
  const permissionsDefaults = path.join(root, PERMISSIONS_TARGET_PATH);
  if (permissionsPolicy) {
    fs.mkdirSync(path.dirname(permissionsDefaults), { recursive: true });
    fs.writeFileSync(permissionsDefaults, PERMISSIONS_DEFAULTS_OUTPUT, "utf8");
  } else if (fs.existsSync(permissionsDefaults)) fs.unlinkSync(permissionsDefaults);
  const playwrightExtension = path.join(root, "extensions", "playwright.ts");
  if (options.playwrightHandoff) fs.writeFileSync(playwrightExtension, "export const playwright = true;\n", "utf8");
  else if (fs.existsSync(playwrightExtension)) fs.unlinkSync(playwrightExtension);
  const engramProtocolAsset = path.join(root, ENGRAM_PROTOCOL_TARGET_PATH);
  if (options.engramProtocol) {
    fs.mkdirSync(path.dirname(engramProtocolAsset), { recursive: true });
    fs.writeFileSync(engramProtocolAsset, ENGRAM_PROTOCOL_CONTENT, "utf8");
  } else if (fs.existsSync(engramProtocolAsset)) fs.unlinkSync(engramProtocolAsset);
  const needsEngramBaseline = Boolean(
    options.engramBaseline
      || options.engramChild
      || options.engramChildRoute !== undefined
      || options.engramChildExtra
      || options.engramToolsMutation
      || options.engramOtherAgentMutation,
  );
  const hasEngramChild = Boolean(
    options.engramChild
      || options.engramChildRoute !== undefined
      || options.engramChildExtra
      || options.engramToolsMutation
      || options.engramOtherAgentMutation,
  );
  if (hasEngramChild) {
    const member = options.engramChildRoute !== undefined
      ? options.engramChildRoute.replace(/^\.\.\//, "")
      : ENGRAM_CHILD_MEMBER;
    const file = path.join(root, member);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ENGRAM_CHILD_CONTENT, "utf8");
  } else {
    fs.rmSync(path.join(root, ENGRAM_CHILD_MEMBER), { force: true });
    if (options.engramChildRoute !== undefined) {
      fs.rmSync(path.join(root, options.engramChildRoute.replace(/^\.\.\//, "")), { force: true });
    }
  }
  const mcpWrapperFile = path.join(root, ENGRAM_MCP_WRAPPER_MEMBER);
  if (options.engramMcpWrapper) {
    fs.mkdirSync(path.dirname(mcpWrapperFile), { recursive: true });
    fs.writeFileSync(mcpWrapperFile, ENGRAM_MCP_WRAPPER_CONTENT, "utf8");
  } else {
    fs.rmSync(mcpWrapperFile, { force: true });
  }
  const closureRoot = path.join(root, "node_modules");
  if (options.bundledAdapterClosure) {
    for (const member of OFFICIAL_REMOVED_NODE_ROOTS) {
      const sentinel = path.join(closureRoot, member, OFFICIAL_CLOSURE_SENTINEL);
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, `retired bundled closure ${member}\n`, "utf8");
    }
  } else {
    for (const member of OFFICIAL_REMOVED_NODE_ROOTS) {
      fs.rmSync(path.join(closureRoot, member), { recursive: true, force: true });
    }
  }
  const playwrightSkillRoot = path.join(root, "skills", "playwright-cli");
  if (playwrightSkillTree) {
    for (const relativePath of PLAYWRIGHT_SKILL_FILES) {
      const file = path.join(playwrightSkillRoot, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, playwrightSkillContent(relativePath), "utf8");
    }
  } else {
    fs.rmSync(playwrightSkillRoot, { recursive: true, force: true });
  }
  const controlSkillRoot = path.join(root, "skills", "control-skill");
  if (options.persistentControlSkill) {
    const controlSkillFile = path.join(controlSkillRoot, "SKILL.md");
    fs.mkdirSync(path.dirname(controlSkillFile), { recursive: true });
    fs.writeFileSync(controlSkillFile, "persistent control skill\n", "utf8");
  } else {
    fs.rmSync(controlSkillRoot, { recursive: true, force: true });
  }
  if (options.extraArchiveFile) {
    const extraFile = path.join(root, options.extraArchiveFile.path);
    fs.mkdirSync(path.dirname(extraFile), { recursive: true });
    fs.writeFileSync(extraFile, options.extraArchiveFile.content, "utf8");
  }
  if (options.removeArchiveFile) fs.rmSync(path.join(root, options.removeArchiveFile), { force: true });

  writeJson(root, "contract/jorgex-pi.v1.json", {
    schemaVersion: 1,
    package: packageIdentity,
    pi: options.rootContractMutation
      ? { ...piVersionContract, minimumVersion: "0.84.3" }
      : piVersionContract,
    capabilities,
    snapshot: { contractPath: "contract/parity.v2.json", schemaVersion: 2 },
    assets: { manifestVersion: 1, manifestPath: "contract/assets.v1.json" },
    components: { inventoryPath: "contract/components.v1.json" },
    runtimeAgents: { contractPath: "contract/runtime-agents.v1.json" },
    runner: { contractPath: "contract/runner.v1.json" },
    schemas: {
      runnerResponse: "contract/schemas/runner-response.v1.schema.json",
      qualityReceipt: "contract/schemas/quality-receipt.v1.schema.json",
      qualityCapabilities: "contract/schemas/quality-capabilities.v1.schema.json",
    },
  });
  writeJson(root, "contract/runner.v1.json", {
    schemaVersion: 1,
    protocolVersion: 1,
    bin: "jorgex-pi",
    entrypoint: "bin/jorgex-pi.mjs",
    commands: options.runnerCommands ?? ["doctor", "sync"],
    exitCodes: { success: 0, unhealthy: 1, usage: 2, internal: 3 },
    stdout: { format: "json", records: 1, trailingNewline: true, maxBytes: 65_536 },
    responseSchema: "contract/schemas/runner-response.v1.schema.json",
    ...(context7Http ? {
      context7: options.context7RunnerMutation
        ? { ...CONTEXT7_RUNNER_CONTRACT, transport: "sse" }
        : CONTEXT7_RUNNER_CONTRACT,
    } : {}),
    ...(permissionsPolicy ? {
      permissions: options.permissionsRunnerMutation
        ? { ...PERMISSIONS_RUNNER_CONTRACT, diagnostic: "mutated permission diagnostic" }
        : PERMISSIONS_RUNNER_CONTRACT,
    } : {}),
    ...(experienceDefaults ? {
      experience: options.experienceRunnerMutation
        ? { ...EXPERIENCE_RUNNER_CONTRACT, initialization: "every sync" }
        : EXPERIENCE_RUNNER_CONTRACT,
    } : {}),
  });
  const managedExternalWrites: Array<{ owner: string; root: string; relativePath: string; semantics: string }> = permissionsPolicy
    ? experienceDefaults ? [...EXPERIENCE_MANAGED_EXTERNAL_WRITES] : [...PERMISSIONS_MANAGED_EXTERNAL_WRITES]
    : [...BASE_MANAGED_EXTERNAL_WRITES];
  if (permissionsPolicy && options.permissionsAssetsMutation) {
    managedExternalWrites.push({
      ...BASE_MANAGED_EXTERNAL_WRITES[0],
      relativePath: "unexpected-permissions-write.json",
    });
  }
  if (permissionsPolicy && options.permissionsAssetsSubsetMutation) managedExternalWrites.pop();
  if (permissionsPolicy && options.permissionsAssetsDuplicateMutation) {
    managedExternalWrites.push({ ...PERMISSIONS_MANAGED_EXTERNAL_WRITES[3] });
  }
  const preservedExternalState = [];
  if (!permissionsPolicy) preservedExternalState.push(PERMISSIONS_PRESERVED_STATE);
  if (context7Http) preservedExternalState.push(options.context7AssetsMutation
    ? { ...CONTEXT7_PRESERVED_MCP, unexpected: true }
    : CONTEXT7_PRESERVED_MCP);
  if (options.bundledAdapterPreserved) preservedExternalState.push({ ...PRESERVED_ADAPTER_CACHE });
  writeJson(root, "contract/assets.v1.json", {
    schemaVersion: 1,
    manifestVersion: 1,
    ownership: "package",
    resources: [
      "agents",
      ...(permissionsPolicy ? ["assets/permissions"] : []),
      "assets/system-prompt",
      "contract/parity.v2.json",
      "snapshot/agents",
    ],
    managedExternalWrites,
    preservedExternalState,
  });
  writeJson(root, "contract/components.v1.json", {
    schemaVersion: 1,
    components: options.bundledAdapterComponent
      ? ["agents", "assets", { ...REMOVED_ADAPTER_COMPONENT }]
      : ["agents", "assets"],
  });
  if (needsEngramBaseline) {
    const route = options.engramChildRoute ?? ENGRAM_CHILD_ROUTE;
    const subagentOnlyExtensions = options.engramChildExtra
      ? [ENGRAM_CHILD_ROUTE, "../extensions/extra.ts"]
      : hasEngramChild
        ? [route]
        : undefined;
    const engramAgent: Record<string, unknown> = {
      name: "engram",
      tools: options.engramToolsMutation
        ? [...ENGRAM_BASELINE_TOOLS, "extra_tool"]
        : [...ENGRAM_BASELINE_TOOLS],
      requiredCapability: ENGRAM_BASELINE_CAPABILITY,
      maxDepth: ENGRAM_BASELINE_MAX_DEPTH,
      ...(subagentOnlyExtensions === undefined ? {} : { subagentOnlyExtensions }),
    };
    const testerAgent: Record<string, unknown> = options.engramOtherAgentMutation
      ? { name: "tester", extra: true }
      : { name: "tester" };
    writeJson(root, "contract/runtime-agents.v1.json", { schemaVersion: 1, agents: [engramAgent, testerAgent] });
  } else {
    writeJson(root, "contract/runtime-agents.v1.json", { schemaVersion: 1, agents: ["tester"] });
  }
  for (const schema of ["runner-response", "quality-receipt", "quality-capabilities"]) {
    writeJson(root, `contract/schemas/${schema}.v1.schema.json`, schema === "runner-response"
      ? runnerResponseSchema(context7Http, options.context7SchemaMutation, permissionsPolicy, options.permissionsSchemaMutation, experienceDefaults)
      : { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" });
  }
  const paritySkills = options.persistentControlSkill
    ? [{
      name: "control-skill",
      sourcePath: "stack/skills/control-skill",
      targetPath: "skills/control-skill",
      files: [{ path: "SKILL.md", sha256: sha256(Buffer.from("persistent control skill\n", "utf8")) }],
    }]
    : [];
  if (playwrightSkillEnabled) {
    paritySkills.push({
      name: "playwright-cli",
      sourcePath: "stack/skills/playwright-cli",
      targetPath: "skills/playwright-cli",
      files: PLAYWRIGHT_SKILL_FILES.map((relativePath) => ({
        path: relativePath,
        sha256: sha256(Buffer.from(playwrightSkillContent(relativePath), "utf8")),
      })),
    });
  }
  const systemPromptModules = modularSystemPrompts
    ? [...MODULAR_SYSTEM_PROMPT_MODULES, ...(options.extraSystemPromptModule ? [options.extraSystemPromptModule] : [])].map((module) => {
      const moduleContent = options.extraSystemPromptModule?.targetPath === module.targetPath
        ? options.extraSystemPromptModule.content
        : modularSystemPromptContent(module.sourcePath);
      const digest = sha256(Buffer.from(moduleContent, "utf8"));
      return { ...module, sourceSha256: digest, outputSha256: digest };
    })
    : undefined;
  const permissionsMetadata = permissionsPolicy
    ? {
      sourcePath: PERMISSIONS_SOURCE_PATH,
      targetPath: PERMISSIONS_TARGET_PATH,
      sourceSha256: sha256(Buffer.from(options.permissionsSourceParityMutation
        ? `${permissionsSourceContent()}mutated`
        : permissionsSourceContent(), "utf8")),
      outputSha256: sha256(Buffer.from(options.permissionsParityMutation
        ? `${PERMISSIONS_DEFAULTS_OUTPUT}mutated`
        : PERMISSIONS_DEFAULTS_OUTPUT, "utf8")),
    }
    : undefined;
  const exclusions = options.legacyBrowserExclusions
    ? [...MODULAR_BASELINE_EXCLUSIONS, ...LEGACY_BROWSER_EXCLUSIONS]
    : modularSystemPrompts
      ? [...MODULAR_BASELINE_EXCLUSIONS]
      : devtoolsExclusion
        ? [{ kind: "capability-integration", id: "chrome-devtools-capability-handoff" }]
        : [];
  if (context7Http) {
    const context7Index = exclusions.findIndex((item) => item.kind === "capability-integration" && "id" in item && item.id === "context7-mcp");
    if (context7Index >= 0) exclusions.splice(context7Index, 1);
    if (options.context7ParityMutation) exclusions.push({ kind: "capability-integration", id: "context7-mcp" });
  }
  const engramProtocolDigest = sha256(Buffer.from(ENGRAM_PROTOCOL_CONTENT, "utf8"));
  const engramProtocolMetadata = options.engramProtocol
    ? {
      sourcePath: ENGRAM_PROTOCOL_SOURCE_PATH,
      targetPath: ENGRAM_PROTOCOL_TARGET_PATH,
      sourceSha256: engramProtocolDigest,
      outputSha256: engramProtocolDigest,
    }
    : undefined;
  writeJson(root, "contract/parity.v2.json", {
    schemaVersion: 2,
    source: { repository: "https://github.com/jorgehn98/jorgex-stack", commit: sourceCommit },
    agents: [{ name: "tester", sourcePath: "stack/agents/tester.md", targetPath: "snapshot/agents/tester.md" }],
    skills: paritySkills,
    ...(systemPromptModules === undefined ? {} : { systemPromptModules }),
    ...(permissionsMetadata === undefined ? {} : { permissions: permissionsMetadata }),
    ...(engramProtocolMetadata === undefined ? {} : { engramProtocol: engramProtocolMetadata }),
    exclusions,
  });
}

function archiveEntryNames(root: string, tarball: Buffer): string[] {
  const archive = path.join(root, "candidate.tgz");
  fs.writeFileSync(archive, tarball);
  const output = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    env: isolatedGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  return output.trimEnd().split(/\r?\n/).filter(Boolean);
}

function archiveEntries(root: string, tarball: Buffer): number {
  return archiveEntryNames(root, tarball).length;
}

function replaceArchiveMember(root: string, tarball: Buffer, member: string, content: string, outputMember = member): Buffer {
  const workspace = fs.mkdtempSync(path.join(path.dirname(root), "tarball-edit-"));
  const archive = path.join(workspace, "source.tgz");
  const extraction = path.join(workspace, "extract");
  fs.writeFileSync(archive, tarball);
  fs.mkdirSync(extraction);
  execFileSync("tar", ["-xzf", archive, "-C", extraction], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (outputMember !== member) fs.renameSync(path.join(extraction, member), path.join(extraction, outputMember));
  fs.writeFileSync(path.join(extraction, outputMember), content, "utf8");
  return execFileSync("tar", ["-czf", "-", "-C", extraction, "package"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
}

function replaceArchiveMemberWithoutDirectories(
  root: string,
  tarball: Buffer,
  member: string,
  content: string,
  outputMember = member,
): Buffer {
  return normalizeArchiveWithoutDirectories(root, replaceArchiveMember(root, tarball, member, content, outputMember));
}

function createAdoptionFixture(options: {
  runnerCommands?: readonly string[];
  previousModularSystemPrompts?: boolean;
  previousDevtoolsHandoff?: boolean;
  devtoolsHandoff?: boolean;
  devtoolsCapability?: boolean;
  devtoolsExclusion?: boolean;
  modularSystemPrompts?: boolean;
  context7Http?: boolean;
  previousContext7Http?: boolean;
  context7RunnerMutation?: boolean;
  context7SchemaMutation?: boolean;
  context7AssetsMutation?: boolean;
  context7ParityMutation?: boolean;
  previousPermissionsPolicy?: boolean;
  permissionsPolicy?: boolean;
  permissionsCapability?: boolean;
  permissionsRunnerMutation?: boolean;
  permissionsSchemaMutation?: boolean;
  permissionsAssetsMutation?: boolean;
  permissionsAssetsSubsetMutation?: boolean;
  permissionsAssetsDuplicateMutation?: boolean;
  permissionsParityMutation?: boolean;
  permissionsSourceParityMutation?: boolean;
  previousExperienceDefaults?: boolean;
  experienceDefaults?: boolean;
  experienceRunnerMutation?: boolean;
  extraSystemPromptModule?: {
    name: string;
    sourcePath: string;
    targetPath: string;
    content: string;
  };
  previousPlaywrightHandoff?: boolean;
  playwrightHandoff?: boolean;
  previousPlaywrightSkill?: boolean;
  playwrightSkill?: boolean;
  producerPlaywrightSkillTree?: boolean;
  sourcePlaywrightSkill?: boolean;
  engramBaseline?: boolean;
  engramChild?: boolean;
  previousEngramChild?: boolean;
  engramMcpWrapper?: boolean;
  previousEngramMcpWrapper?: boolean;
  bundledAdapterClosure?: boolean;
  previousBundledAdapterClosure?: boolean;
  bundledAdapterPackage?: boolean;
  previousBundledAdapterPackage?: boolean;
  bundledAdapterComponent?: boolean;
  previousBundledAdapterComponent?: boolean;
  bundledAdapterPreserved?: boolean;
  previousBundledAdapterPreserved?: boolean;
  engramChildRoute?: string;
  engramChildExtra?: boolean;
  engramToolsMutation?: boolean;
  engramOtherAgentMutation?: boolean;
  previousEngramProtocol?: boolean;
  engramProtocol?: boolean;
  previousExtraArchiveFile?: { path: string; content: string };
  removeExtraArchiveFile?: string;
  extraArchiveFile?: { path: string; content: string };
  rootContractMutation?: boolean;
  extraCapabilities?: readonly string[];
  piVersionContract?: PiVersionContract;
} = {}): AdoptionFixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "stack");
  const piDir = path.join(parent, "pi");
  fs.mkdirSync(root, { recursive: true });
  initializeGit(root);
  writeJson(root, "package.json", { name: "jorgex-stack", private: true, type: "module" });
  fs.mkdirSync(path.join(root, "stack", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "stack", "agents", "tester.md"), "old source\n", "utf8");
  const previousSourceCommit = commit(root, "stack: previous source");
  fs.writeFileSync(path.join(root, "stack", "agents", "tester.md"), "new source\n", "utf8");
  if (options.sourcePlaywrightSkill) {
    for (const relativePath of PLAYWRIGHT_SKILL_FILES) {
      const file = path.join(root, "stack", "skills", "playwright-cli", relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `source Playwright skill ${relativePath}\n`, "utf8");
    }
  }
  if (options.modularSystemPrompts) {
    for (const module of MODULAR_SYSTEM_PROMPT_MODULES) {
      const file = path.join(root, module.sourcePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, modularSystemPromptContent(module.sourcePath), "utf8");
    }
  }
  if (options.extraSystemPromptModule) {
    const file = path.join(root, options.extraSystemPromptModule.sourcePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, options.extraSystemPromptModule.content, "utf8");
  }
  if (options.previousPermissionsPolicy || options.permissionsPolicy) {
    const file = path.join(root, PERMISSIONS_SOURCE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, permissionsSourceContent(), "utf8");
  }
  const sourceCommit = commit(root, "stack: source candidate");
  const retainControlSkill = options.previousPlaywrightSkill === true && options.playwrightSkill === false;

  fs.mkdirSync(piDir, { recursive: true });
  initializeGit(piDir);
  const npmArchive = options.previousPermissionsPolicy === true || options.permissionsPolicy === true;
  const needsOldEngramBaseline = Boolean(
    options.engramBaseline
      || options.engramChild
      || options.previousEngramChild
      || options.engramChildRoute !== undefined
      || options.engramChildExtra
      || options.engramToolsMutation
      || options.engramOtherAgentMutation,
  );
  writePiRelease(piDir, "0.8.7", previousSourceCommit, {
    modularSystemPrompts: options.previousModularSystemPrompts,
    context7Http: options.previousContext7Http,
    permissionsPolicy: options.previousPermissionsPolicy,
    experienceDefaults: options.previousExperienceDefaults,
    devtoolsHandoff: options.previousDevtoolsHandoff,
    playwrightHandoff: options.previousPlaywrightHandoff,
    playwrightSkill: options.previousPlaywrightSkill,
    engramBaseline: needsOldEngramBaseline,
    engramChild: options.previousEngramChild,
    engramMcpWrapper: options.previousEngramMcpWrapper,
    bundledAdapterClosure: options.previousBundledAdapterClosure,
    bundledAdapterPackage: options.previousBundledAdapterPackage,
    bundledAdapterComponent: options.previousBundledAdapterComponent,
    bundledAdapterPreserved: options.previousBundledAdapterPreserved,
    legacyBrowserExclusions: options.previousModularSystemPrompts === true ? false : options.modularSystemPrompts,
    persistentControlSkill: retainControlSkill,
    engramProtocol: options.previousEngramProtocol,
    extraArchiveFile: options.previousExtraArchiveFile,
  });
  const oldProducer = commit(piDir, "pi: 0.8.7");
  git(piDir, ["tag", "v0.8.7", oldProducer]);
  const oldTarball = gitArchive(piDir, oldProducer, npmArchive);
  const current = pin("0.8.7", oldProducer, oldTarball);

  const artifacts: Artifacts = {
    current,
    previous: {
      package: { name: "jorgex-pi", version: "0.8.6", source: "npm:jorgex-pi@0.8.6" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    },
    archive: { entries: archiveEntries(parent, oldTarball), parity: { source: { commit: previousSourceCommit } } },
  };
  writeJson(root, PIN_PATH, current);
  writeJson(root, ARTIFACTS_PATH, artifacts);
  commit(root, "stack: pin 0.8.7");
  git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "HEAD"])]);
  git(root, ["switch", "-c", "adoption-test"]);

  writePiRelease(piDir, "0.8.8", sourceCommit, {
    runnerCommands: options.runnerCommands,
    devtoolsHandoff: options.devtoolsHandoff,
    devtoolsCapability: options.devtoolsCapability,
    devtoolsExclusion: options.devtoolsExclusion,
    modularSystemPrompts: options.modularSystemPrompts,
    context7Http: options.context7Http,
    context7RunnerMutation: options.context7RunnerMutation,
    context7SchemaMutation: options.context7SchemaMutation,
    context7AssetsMutation: options.context7AssetsMutation,
    context7ParityMutation: options.context7ParityMutation,
    permissionsPolicy: options.permissionsPolicy,
    permissionsCapability: options.permissionsCapability,
    permissionsRunnerMutation: options.permissionsRunnerMutation,
    permissionsSchemaMutation: options.permissionsSchemaMutation,
    permissionsAssetsMutation: options.permissionsAssetsMutation,
    permissionsAssetsSubsetMutation: options.permissionsAssetsSubsetMutation,
    permissionsAssetsDuplicateMutation: options.permissionsAssetsDuplicateMutation,
    permissionsParityMutation: options.permissionsParityMutation,
    permissionsSourceParityMutation: options.permissionsSourceParityMutation,
    experienceDefaults: options.experienceDefaults,
    experienceRunnerMutation: options.experienceRunnerMutation,
    extraSystemPromptModule: options.extraSystemPromptModule,
    playwrightHandoff: options.playwrightHandoff,
    playwrightSkill: options.playwrightSkill,
    playwrightSkillTree: options.producerPlaywrightSkillTree,
    engramBaseline: options.engramBaseline,
    engramChild: options.engramChild,
    engramMcpWrapper: options.engramMcpWrapper,
    bundledAdapterClosure: options.bundledAdapterClosure,
    bundledAdapterPackage: options.bundledAdapterPackage,
    bundledAdapterComponent: options.bundledAdapterComponent,
    bundledAdapterPreserved: options.bundledAdapterPreserved,
    engramChildRoute: options.engramChildRoute,
    engramChildExtra: options.engramChildExtra,
    engramToolsMutation: options.engramToolsMutation,
    engramOtherAgentMutation: options.engramOtherAgentMutation,
    persistentControlSkill: retainControlSkill,
    engramProtocol: options.engramProtocol,
    extraArchiveFile: options.extraArchiveFile,
    removeArchiveFile: options.removeExtraArchiveFile,
    rootContractMutation: options.rootContractMutation,
    extraCapabilities: options.extraCapabilities,
    piVersionContract: options.piVersionContract,
  });
  const nextProducer = commit(piDir, "pi: 0.8.8");
  git(piDir, ["tag", "v0.8.8", nextProducer]);
  git(piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
  const tarball = gitArchive(piDir, nextProducer, npmArchive);
  const next = pin("0.8.8", nextProducer, tarball);

  return {
    root,
    piDir,
    version: "0.8.8",
    current,
    next,
    sourceCommit,
    nextArchive: { entries: archiveEntries(parent, tarball), parity: { source: { commit: sourceCommit } } },
    previousTarball: oldTarball,
    tarball,
  };
}

function registryFetch(
  fixture: AdoptionFixture,
  options: {
    integrity?: string;
    previousIntegrity?: string;
    tarball?: string;
    nextTarballBytes?: Buffer;
    previousTarballBytes?: Buffer;
  } = {},
) {
  const nextTarball = options.nextTarballBytes ?? fixture.tarball;
  const previousTarball = options.previousTarballBytes ?? fixture.previousTarball;
  const sri = (value: Buffer) => `sha512-${Buffer.from(sha512(value), "hex").toString("base64")}`;
  const metadataResponse = (version: string, artifact: Buffer, artifactUrl: string, integrity?: string) => new Response(JSON.stringify({
    name: "jorgex-pi",
    version,
    dist: { tarball: artifactUrl, integrity: integrity ?? sri(artifact) },
  }), { status: 200, headers: { "content-type": "application/json" } });

  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url) === `https://registry.npmjs.org/jorgex-pi/${fixture.version}`) {
      return metadataResponse(fixture.version, nextTarball, options.tarball ?? tarballUrl(fixture.version), options.integrity);
    }
    if (String(url) === `https://registry.npmjs.org/jorgex-pi/${fixture.current.package.version}`) {
      return metadataResponse(fixture.current.package.version, previousTarball, tarballUrl(fixture.current.package.version), options.previousIntegrity);
    }
    if (String(url) === tarballUrl(fixture.version)) return new Response(new Uint8Array(nextTarball), { status: 200 });
    if (String(url) === tarballUrl(fixture.current.package.version)) return new Response(new Uint8Array(previousTarball), { status: 200 });
    throw new Error(`Unexpected fixture fetch: ${String(url)}`);
  });
}

function rootState(fixture: AdoptionFixture): { pin: Pin; artifacts: Artifacts; status: string } {
  return {
    pin: readJson<Pin>(fixture.root, PIN_PATH),
    artifacts: readJson<Artifacts>(fixture.root, ARTIFACTS_PATH),
    status: git(fixture.root, ["status", "--porcelain"]),
  };
}

function commitBaselineMutation(
  fixture: AdoptionFixture,
  mutate: (current: Record<string, unknown>, artifacts: Record<string, unknown>) => void,
): void {
  const current = readJson<Record<string, unknown>>(fixture.root, PIN_PATH);
  const artifacts = readJson<Record<string, unknown>>(fixture.root, ARTIFACTS_PATH);
  mutate(current, artifacts);
  writeJson(fixture.root, PIN_PATH, current);
  writeJson(fixture.root, ARTIFACTS_PATH, artifacts);
  commit(fixture.root, "stack: malformed metadata baseline");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("preparePiAdoption", () => {
  it("acepta sólo la incorporación explícita de Pi 0.85.1 y ajusta sus límites", async () => {
    const fixture = createAdoptionFixture({
      piVersionContract: {
        minimumVersion: "0.84.2",
        maximumVersion: "0.85.1",
        testedVersions: ["0.84.2", "0.85.1"],
      },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPiVersion: "0.85.1",
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 15_000);

  it.each([
    ["retira la versión anterior", {
      minimumVersion: "0.85.1",
      maximumVersion: "0.85.1",
      testedVersions: ["0.85.1"],
    }],
    ["añade otra versión además de la aceptada", {
      minimumVersion: "0.84.2",
      maximumVersion: "0.85.1",
      testedVersions: ["0.84.2", "0.84.3", "0.85.1"],
    }],
    ["añade una versión intermedia en lugar de la aceptada", {
      minimumVersion: "0.84.2",
      maximumVersion: "0.84.3",
      testedVersions: ["0.84.2", "0.84.3"],
    }],
  ] as const)("rechaza una transición que %s aunque se confirme Pi 0.85.1", async (_case, piVersionContract) => {
    const fixture = createAdoptionFixture({ piVersionContract });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPiVersion: "0.85.1",
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("acepta la transición completa de DevTools sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({ devtoolsHandoff: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptDevtoolsHandoff: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta la transición exacta de Playwright con bootstrap compartido sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta la retirada exacta de la skill Playwright sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/parity\.v2\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta conjuntamente la retirada de la skill y el handoff Playwright explícito", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightSkill: true,
      playwrightHandoff: true,
      playwrightSkill: false,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
      acceptPlaywrightSkillRemoval: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta la transición modular exacta sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({
      modularSystemPrompts: true,
      previousDevtoolsHandoff: true,
      devtoolsHandoff: true,
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptModularSystemPrompts: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `https://registry.npmjs.org/jorgex-pi/${fixture.version}`,
      tarballUrl(fixture.version),
      tarballUrl(fixture.current.package.version),
    ]);

    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(MODULAR_CAPABILITY);
    expect(contract.capabilities).not.toContain("context7-mcp-v1");
    const parity = readJson<{
      systemPromptModules: { name: string; sourcePath: string; targetPath: string }[];
      exclusions: unknown[];
    }>(fixture.piDir, "contract/parity.v2.json");
    expect(parity.systemPromptModules.map(({ name, sourcePath, targetPath }) => ({ name, sourcePath, targetPath }))).toEqual(
      MODULAR_SYSTEM_PROMPT_MODULES,
    );
    expect(parity.exclusions).toContainEqual({ kind: "capability-integration", id: "context7-mcp" });
    expect(parity.exclusions).not.toContainEqual(LEGACY_BROWSER_EXCLUSIONS[0]);
    expect(parity.exclusions).not.toContainEqual(LEGACY_BROWSER_EXCLUSIONS[1]);
  }, 15_000);

  it("acepta la transición exacta de Context7 HTTP sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture(CONTEXT7_TRANSITION_FIXTURE);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptContext7Http: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });

    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(CONTEXT7_CAPABILITY);
    const parity = readJson<{ exclusions: unknown[] }>(fixture.piDir, "contract/parity.v2.json");
    expect(parity.exclusions).not.toContainEqual({ kind: "capability-integration", id: "context7-mcp" });

    const runner = readJson<{ context7: typeof CONTEXT7_RUNNER_CONTRACT }>(fixture.piDir, "contract/runner.v1.json");
    expect(runner.context7).toEqual(CONTEXT7_RUNNER_CONTRACT);
    const assets = readJson<{ preservedExternalState: unknown[] }>(fixture.piDir, "contract/assets.v1.json");
    expect(assets.preservedExternalState).toContainEqual(CONTEXT7_PRESERVED_MCP);

    const schema = readJson<{
      $defs: {
        context7: Record<string, unknown>;
        statusResult: { required: string[] };
        doctorResult: { properties: { checks: { minItems: number; maxItems: number; items: { properties: { id: { enum: string[] } } } } } };
      };
    }>(fixture.piDir, "contract/schemas/runner-response.v1.schema.json");
    expect(schema.$defs.context7).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: {
        state: { enum: ["available", "conflict", "invalid"] },
        source: { type: "string" },
        code: { type: "string" },
      },
    });
    expect(schema.$defs.statusResult.required).toEqual(["installation", "engram", "context7"]);
    expect(schema.$defs.doctorResult.properties.checks).toMatchObject({
      minItems: 3,
      maxItems: 3,
      items: { properties: { id: { enum: ["package", "engram", "context7"] } } },
    });
    expect(fixture.nextArchive.entries).toBe(archiveEntries(path.dirname(fixture.root), fixture.previousTarball) + 1);
  }, 15_000);

  it("rechaza un archivo ajeno añadido al delta Context7 confirmado", async () => {
    const fixture = createAdoptionFixture({
      ...CONTEXT7_TRANSITION_FIXTURE,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptContext7Http: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*reviewed.*module addition/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado con el mismo número esperado de entradas durante el delta Context7", async () => {
    const fixture = createAdoptionFixture(CONTEXT7_TRANSITION_FIXTURE);
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/context7-config.mjs",
      CONTEXT7_EXTENSION_CONTENT,
      "package/extensions/context7-renamed.mjs",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptContext7Http: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*reviewed.*module addition/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza bytes de context7-config.mjs que no coinciden con el productor Git", async () => {
    const fixture = createAdoptionFixture(CONTEXT7_TRANSITION_FIXTURE);
    const tamperedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/context7-config.mjs",
      "tampered Context7 module bytes\n",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptContext7Http: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Context7 module does not match producer/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["unrelated capability", { extraCapabilities: ["unexpected-capability-v1"] }],
    ["runner command", { runnerCommands: ["doctor", "sync", "cleanup"] }],
    ["root contract", { rootContractMutation: true }],
    ["Context7 runner metadata", { context7RunnerMutation: true }],
    ["Context7 response schema", { context7SchemaMutation: true }],
    ["Context7 preserved-state metadata", { context7AssetsMutation: true }],
    ["Context7 parity exclusion", { context7ParityMutation: true }],
  ] as const)("rechaza el cambio ajeno %s aunque se confirme Context7", async (_label, options) => {
    const fixture = createAdoptionFixture({ ...CONTEXT7_TRANSITION_FIXTURE, ...options });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptContext7Http: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("mantiene la adopción ordinaria compatible aunque se confirme Context7", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptContext7Http: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  });

  it("acepta la transición exacta de la política de permisos sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture(PERMISSIONS_TRANSITION_FIXTURE);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `https://registry.npmjs.org/jorgex-pi/${fixture.version}`,
      tarballUrl(fixture.version),
      tarballUrl(fixture.current.package.version),
    ]);

    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(PERMISSIONS_CAPABILITY);

    const runner = readJson<{ permissions: typeof PERMISSIONS_RUNNER_CONTRACT }>(fixture.piDir, "contract/runner.v1.json");
    expect(runner.permissions).toEqual(PERMISSIONS_RUNNER_CONTRACT);

    const assets = readJson<{
      resources: string[];
      managedExternalWrites: typeof PERMISSIONS_MANAGED_EXTERNAL_WRITES;
      preservedExternalState: unknown[];
    }>(fixture.piDir, "contract/assets.v1.json");
    expect(assets.resources).toContain(PERMISSIONS_RESOURCE);
    expect(assets.managedExternalWrites).toEqual(PERMISSIONS_MANAGED_EXTERNAL_WRITES);
    expect(assets.preservedExternalState).toEqual([CONTEXT7_PRESERVED_MCP]);

    const parity = readJson<{
      permissions: {
        sourcePath: string;
        targetPath: string;
        sourceSha256: string;
        outputSha256: string;
      };
    }>(fixture.piDir, "contract/parity.v2.json");
    expect(parity.permissions).toEqual({
      sourcePath: PERMISSIONS_SOURCE_PATH,
      targetPath: PERMISSIONS_TARGET_PATH,
      sourceSha256: sha256(Buffer.from(git(fixture.root, ["show", `${fixture.sourceCommit}:${PERMISSIONS_SOURCE_PATH}`], false), "utf8")),
      outputSha256: sha256(Buffer.from(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:${PERMISSIONS_TARGET_PATH}`], false), "utf8")),
    });

    const schema = readJson<{
      $defs: {
        permissions: Record<string, unknown>;
        statusResult: { required: string[] };
        doctorResult: { properties: { checks: { minItems: number; maxItems: number; items: { properties: { id: { enum: string[] } } } } } };
        lifecycleResult: { properties: { actions: { maxItems: number } } };
        lifecycleAction: { enum: string[] };
      };
    }>(fixture.piDir, "contract/schemas/runner-response.v1.schema.json");
    expect(schema.$defs.permissions).toEqual({
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
    });
    expect(schema.$defs.statusResult.required).toEqual(["installation", "engram", "context7", "permissions"]);
    expect(schema.$defs.doctorResult.properties.checks).toMatchObject({
      minItems: 4,
      maxItems: 4,
      items: { properties: { id: { enum: ["package", "engram", "context7", "permissions"] } } },
    });
    expect(schema.$defs.lifecycleResult.properties.actions.maxItems).toBe(32);
    expect(schema.$defs.lifecycleAction.enum).toEqual([...BASE_LIFECYCLE_ACTIONS, ...PERMISSIONS_ACTIONS]);

    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(nextEntries.filter((entry) => !previousEntries.includes(entry)).sort()).toEqual([
      `package/${PERMISSIONS_MODULE}`,
      `package/${PERMISSIONS_TARGET_PATH}`,
    ].sort());
    expect(fixture.nextArchive.entries).toBe(previousEntries.length + 2);
  }, 15_000);

  it("acepta la transición exacta de defaults de experiencia sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture(EXPERIENCE_TRANSITION_FIXTURE);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptExperienceDefaults: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `https://registry.npmjs.org/jorgex-pi/${fixture.version}`,
      tarballUrl(fixture.version),
      tarballUrl(fixture.current.package.version),
    ]);

    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(EXPERIENCE_CAPABILITY);
    const runner = readJson<{ experience: typeof EXPERIENCE_RUNNER_CONTRACT }>(fixture.piDir, "contract/runner.v1.json");
    expect(runner.experience).toEqual(EXPERIENCE_RUNNER_CONTRACT);

    const assets = readJson<{
      managedExternalWrites: typeof EXPERIENCE_MANAGED_EXTERNAL_WRITES;
      preservedExternalState: unknown[];
    }>(fixture.piDir, "contract/assets.v1.json");
    expect(assets.managedExternalWrites).toEqual(EXPERIENCE_MANAGED_EXTERNAL_WRITES);
    expect(assets.preservedExternalState).toEqual([CONTEXT7_PRESERVED_MCP]);

    const parity = readJson<Record<string, unknown>>(fixture.piDir, "contract/parity.v2.json");
    expect(Object.hasOwn(parity, "experience")).toBe(false);

    const schema = readJson<{
      $defs: {
        lifecycleResult: { properties: { actions: { maxItems: number } } };
        lifecycleAction: { enum: string[] };
      };
    }>(fixture.piDir, "contract/schemas/runner-response.v1.schema.json");
    expect(schema.$defs.lifecycleResult.properties.actions.maxItems).toBe(32);
    expect(schema.$defs.lifecycleAction.enum).toEqual([
      ...BASE_LIFECYCLE_ACTIONS,
      ...PERMISSIONS_ACTIONS,
      ...EXPERIENCE_ACTIONS,
    ]);

    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(nextEntries).toEqual(previousEntries);
    expect(fixture.nextArchive.entries).toBe(previousEntries.length);
    expect(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:bin/jorgex-pi.mjs`], false)).toBe(EXPERIENCE_BIN_CONTENT);
  }, 15_000);

  it("rechaza una mutación ajena del contrato de experiencia aunque se confirme la transición", async () => {
    const fixture = createAdoptionFixture({ ...EXPERIENCE_TRANSITION_FIXTURE, experienceRunnerMutation: true });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptExperienceDefaults: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review|contract\/runner/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un archivo ajeno aunque se confirme la transición de experiencia", async () => {
    const fixture = createAdoptionFixture({
      ...EXPERIENCE_TRANSITION_FIXTURE,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptExperienceDefaults: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza bytes de bin/jorgex-pi.mjs que no coinciden con el productor", async () => {
    const fixture = createAdoptionFixture(EXPERIENCE_TRANSITION_FIXTURE);
    const tamperedTarball = replaceArchiveMemberWithoutDirectories(
      fixture.root,
      fixture.tarball,
      "package/bin/jorgex-pi.mjs",
      "export const runner = false;\n",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptExperienceDefaults: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/runner|producer|bin/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un valor no booleano de acceptExperienceDefaults antes de consultar npm", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptExperienceDefaults: "yes" as unknown as boolean,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Adoption options must be boolean/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza las seis escrituras gestionadas de permisos si falta la capability", async () => {
    const fixture = createAdoptionFixture({ ...PERMISSIONS_TRANSITION_FIXTURE, permissionsCapability: false });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("permite una adopción posterior con la política ya presente sin nueva confirmación", async () => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      previousPermissionsPolicy: true,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  }, 15_000);

  it.each([
    ["source", { permissionsSourceParityMutation: true }],
    ["output", { permissionsParityMutation: true }],
  ] as const)("valida siempre el hash %s de permissions en una adopción posterior", async (_label, options) => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      previousPermissionsPolicy: true,
      ...options,
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/hash|permissions|parity/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("acepta el delta exacto de permissions-upgrade-v1 sólo con confirmación explícita y conserva el inventario", async () => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      previousPermissionsPolicy: true,
    });
    const UPGRADE_CAPABILITY = "permissions-upgrade-v1";

    const contractPath = path.join(fixture.piDir, "contract", "jorgex-pi.v1.json");
    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(PERMISSIONS_CAPABILITY);
    expect(contract.capabilities).not.toContain(UPGRADE_CAPABILITY);
    const permissionsIndex = contract.capabilities.indexOf(PERMISSIONS_CAPABILITY);
    contract.capabilities.splice(permissionsIndex + 1, 0, UPGRADE_CAPABILITY);
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

    const runnerPath = path.join(fixture.piDir, "contract", "runner.v1.json");
    const runner = readJson<{ commands: string[]; permissions: { semantics: string } }>(fixture.piDir, "contract/runner.v1.json");
    expect(runner.commands).not.toContain("upgrade");
    runner.commands.push("upgrade");
    expect(runner.permissions.semantics).toBe(PERMISSIONS_RUNNER_CONTRACT.semantics);
    runner.permissions.semantics = UPGRADE_PERMISSIONS_SEMANTICS;
    fs.writeFileSync(runnerPath, `${JSON.stringify(runner, null, 2)}\n`, "utf8");

    const schemaPath = path.join(fixture.piDir, "contract", "schemas", "runner-response.v1.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
      properties: { command: { enum: string[] } };
      oneOf: Array<{ properties?: { command?: { const?: string } } }>;
      $defs: {
        lifecycleResult: { properties: Record<string, unknown> };
        lifecycleAction: { enum: string[] };
      };
    };
    expect(schema.properties.command.enum).not.toContain("upgrade");
    schema.properties.command.enum.push("upgrade");
    expect(schema.oneOf.some((entry) => entry.properties?.command?.const === "upgrade")).toBe(false);
    schema.oneOf.splice(schema.oneOf.length - 1, 0, ...structuredClone(UPGRADE_ONEOF_ENTRIES));
    expect(schema.$defs.lifecycleResult.properties.policySha256).toBeUndefined();
    schema.$defs.lifecycleResult.properties.policySha256 = structuredClone(UPGRADE_POLICY_SHA256);
    expect(schema.$defs.lifecycleAction.enum).not.toContain(UPGRADE_LIFECYCLE_ACTION);
    schema.$defs.lifecycleAction.enum.splice(
      schema.$defs.lifecycleAction.enum.indexOf("released:permissions.config") + 1,
      0,
      UPGRADE_LIFECYCLE_ACTION,
    );
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const nextProducer = commit(fixture.piDir, "pi: 0.8.8 permissions-upgrade-v1");
    git(fixture.piDir, ["tag", "-f", `v${fixture.version}`, nextProducer]);
    git(fixture.piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
    const tarball = gitArchive(fixture.piDir, nextProducer, true);
    const next = pin(fixture.version, nextProducer, tarball);
    (fixture as { next: Pin }).next = next;
    (fixture as { tarball: Buffer }).tarball = tarball;
    (fixture as { nextArchive: Artifacts["archive"] }).nextArchive = {
      entries: archiveEntries(path.dirname(fixture.root), tarball),
      parity: { source: { commit: fixture.sourceCommit } },
    };

    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);

    const fetch = registryFetch(fixture);
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsUpgrade: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json").capabilities).toContain(UPGRADE_CAPABILITY);
    expect(readJson<{ commands: string[] }>(fixture.piDir, "contract/runner.v1.json").commands).toContain("upgrade");
    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(nextEntries).toEqual(previousEntries);
    expect(fixture.nextArchive.entries).toBe(previousEntries.length);
  }, 15_000);

  it("rechaza una semántica de upgrade no revisada aunque se confirme permissions-upgrade-v1", async () => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      previousPermissionsPolicy: true,
    });
    const UPGRADE_CAPABILITY = "permissions-upgrade-v1";

    const contractPath = path.join(fixture.piDir, "contract", "jorgex-pi.v1.json");
    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    const permissionsIndex = contract.capabilities.indexOf(PERMISSIONS_CAPABILITY);
    contract.capabilities.splice(permissionsIndex + 1, 0, UPGRADE_CAPABILITY);
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

    const runnerPath = path.join(fixture.piDir, "contract", "runner.v1.json");
    const runner = readJson<{ commands: string[]; permissions: { semantics: string } }>(fixture.piDir, "contract/runner.v1.json");
    runner.commands.push("upgrade");
    runner.permissions.semantics = `${UPGRADE_PERMISSIONS_SEMANTICS} (unreviewed suffix)`;
    fs.writeFileSync(runnerPath, `${JSON.stringify(runner, null, 2)}\n`, "utf8");

    const schemaPath = path.join(fixture.piDir, "contract", "schemas", "runner-response.v1.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as { properties: { command: { enum: string[] } } };
    schema.properties.command.enum.push("upgrade");
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const nextProducer = commit(fixture.piDir, "pi: 0.8.8 permissions-upgrade-v1 unreviewed semantics");
    git(fixture.piDir, ["tag", "-f", `v${fixture.version}`, nextProducer]);
    git(fixture.piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
    const tarball = gitArchive(fixture.piDir, nextProducer, true);
    (fixture as { next: Pin }).next = pin(fixture.version, nextProducer, tarball);
    (fixture as { tarball: Buffer }).tarball = tarball;

    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    const fetch = registryFetch(fixture);
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsUpgrade: true,
    }, dependencies)).rejects.toThrow(/runner semantics differs from producer|compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["una entrada oneOf de upgrade con resultado ajeno", (schema: {
      oneOf: Array<{ properties?: { command?: { const?: string }; result?: unknown } }>;
      $defs: { lifecycleResult: { properties: Record<string, unknown> }; lifecycleAction: { enum: string[] } };
    }) => {
      schema.oneOf.push({
        properties: { command: { const: "upgrade" }, result: { $ref: "#/$defs/emptyResult" } },
      });
    }],
    ["un patrón policySha256 no revisado", (schema: {
      oneOf: Array<{ properties?: { command?: { const?: string } } }>;
      $defs: { lifecycleResult: { properties: Record<string, unknown> }; lifecycleAction: { enum: string[] } };
    }) => {
      schema.$defs.lifecycleResult.properties.policySha256 = { type: "string", pattern: "^[a-f0-9]{32}$" };
    }],
    ["una acción de lifecycle no revisada junto a la revisada", (schema: {
      oneOf: Array<{ properties?: { command?: { const?: string } } }>;
      $defs: { lifecycleResult: { properties: Record<string, unknown> }; lifecycleAction: { enum: string[] } };
    }) => {
      schema.$defs.lifecycleAction.enum.push("upgraded:permissions.config.v2");
    }],
  ] as const)("rechaza %s aunque se confirme permissions-upgrade-v1", async (_case, mutate) => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      previousPermissionsPolicy: true,
    });
    const UPGRADE_CAPABILITY = "permissions-upgrade-v1";

    const contractPath = path.join(fixture.piDir, "contract", "jorgex-pi.v1.json");
    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    const permissionsIndex = contract.capabilities.indexOf(PERMISSIONS_CAPABILITY);
    contract.capabilities.splice(permissionsIndex + 1, 0, UPGRADE_CAPABILITY);
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

    const runnerPath = path.join(fixture.piDir, "contract", "runner.v1.json");
    const runner = readJson<{ commands: string[]; permissions: { semantics: string } }>(fixture.piDir, "contract/runner.v1.json");
    runner.commands.push("upgrade");
    runner.permissions.semantics = UPGRADE_PERMISSIONS_SEMANTICS;
    fs.writeFileSync(runnerPath, `${JSON.stringify(runner, null, 2)}\n`, "utf8");

    const schemaPath = path.join(fixture.piDir, "contract", "schemas", "runner-response.v1.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
      properties: { command: { enum: string[] } };
      oneOf: Array<{ properties?: { command?: { const?: string }; result?: unknown } }>;
      $defs: {
        lifecycleResult: { properties: Record<string, unknown> };
        lifecycleAction: { enum: string[] };
      };
    };
    schema.properties.command.enum.push("upgrade");
    schema.oneOf.splice(schema.oneOf.length - 1, 0, ...structuredClone(UPGRADE_ONEOF_ENTRIES));
    schema.$defs.lifecycleResult.properties.policySha256 = structuredClone(UPGRADE_POLICY_SHA256);
    schema.$defs.lifecycleAction.enum.splice(
      schema.$defs.lifecycleAction.enum.indexOf("released:permissions.config") + 1,
      0,
      UPGRADE_LIFECYCLE_ACTION,
    );
    mutate(schema);
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const nextProducer = commit(fixture.piDir, `pi: 0.8.8 permissions-upgrade-v1 unreviewed ${_case}`);
    git(fixture.piDir, ["tag", "-f", `v${fixture.version}`, nextProducer]);
    git(fixture.piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
    const tarball = gitArchive(fixture.piDir, nextProducer, true);
    (fixture as { next: Pin }).next = pin(fixture.version, nextProducer, tarball);
    (fixture as { tarball: Buffer }).tarball = tarball;

    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    const fetch = registryFetch(fixture);
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsUpgrade: true,
    }, dependencies)).rejects.toThrow(/Permissions upgrade.*(differs from producer|requires? exactly)|compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("acepta la deriva de contenido de permissions con capability presente sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      previousPermissionsPolicy: true,
    });
    const driftedOutput = "{\n  \"permission\": {\n    \"*\": \"allow\"\n  }\n}\n";
    expect(driftedOutput).not.toBe(PERMISSIONS_DEFAULTS_OUTPUT);
    fs.writeFileSync(path.join(fixture.piDir, PERMISSIONS_TARGET_PATH), driftedOutput, "utf8");
    const parity = readJson<{ permissions: { outputSha256: string } }>(fixture.piDir, "contract/parity.v2.json");
    parity.permissions.outputSha256 = sha256(Buffer.from(driftedOutput, "utf8"));
    writeJson(fixture.piDir, "contract/parity.v2.json", parity);

    const nextProducer = commit(fixture.piDir, "pi: 0.8.8 permissions drift");
    git(fixture.piDir, ["tag", "-f", `v${fixture.version}`, nextProducer]);
    git(fixture.piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
    const tarball = gitArchive(fixture.piDir, nextProducer, true);
    const next = pin(fixture.version, nextProducer, tarball);
    (fixture as { next: Pin }).next = next;
    (fixture as { tarball: Buffer }).tarball = tarball;
    (fixture as { nextArchive: Artifacts["archive"] }).nextArchive = {
      entries: archiveEntries(path.dirname(fixture.root), tarball),
      parity: { source: { commit: fixture.sourceCommit } },
    };

    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/permissions content drift/);
    expect(rootState(fixture)).toEqual(before);

    const fetch = registryFetch(fixture);
    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("rechaza un archivo ajeno añadido al delta de permisos confirmado", async () => {
    const fixture = createAdoptionFixture({
      ...PERMISSIONS_TRANSITION_FIXTURE,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado con el mismo número esperado de entradas durante el delta de permisos", async () => {
    const fixture = createAdoptionFixture(PERMISSIONS_TRANSITION_FIXTURE);
    const renamedTarball = replaceArchiveMemberWithoutDirectories(
      fixture.root,
      fixture.tarball,
      `package/${PERMISSIONS_MODULE}`,
      "export const permissionsLifecycle = true;\n",
      "package/extensions/permissions-renamed.mjs",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["permissions-lifecycle.mjs", PERMISSIONS_MODULE, "tampered permissions lifecycle bytes\n"],
    ["permission defaults", PERMISSIONS_TARGET_PATH, "{\"permission\":{\"*\":\"allow\"}}\n"],
  ] as const)("rechaza bytes modificados de %s frente al productor Git", async (_label, member, content) => {
    const fixture = createAdoptionFixture(PERMISSIONS_TRANSITION_FIXTURE);
    const tamperedTarball = replaceArchiveMemberWithoutDirectories(fixture.root, fixture.tarball, `package/${member}`, content);
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/producer|hash/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["unrelated capability", { extraCapabilities: ["unexpected-capability-v1"] }],
    ["runner command", { runnerCommands: ["doctor", "sync", "cleanup"] }],
    ["root contract", { rootContractMutation: true }],
    ["permissions runner metadata", { permissionsRunnerMutation: true }],
    ["permissions response schema", { permissionsSchemaMutation: true }],
    ["permissions managed write", { permissionsAssetsMutation: true }],
    ["permissions managed write subset", { permissionsAssetsSubsetMutation: true }],
    ["permissions managed write duplicate", { permissionsAssetsDuplicateMutation: true }],
    ["permissions parity hash", { permissionsParityMutation: true }],
  ] as const)("rechaza el cambio ajeno %s aunque se confirme la política de permisos", async (_label, options) => {
    const fixture = createAdoptionFixture({ ...PERMISSIONS_TRANSITION_FIXTURE, ...options });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review|hash|permissions/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("mantiene la adopción ordinaria compatible aunque se confirme la política de permisos", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPermissionsPolicy: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  });

  it.each(["--accept-permissions-policy", "--accept-experience-defaults"])("expone %s en el contrato CLI del preparador", (flag) => {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-cli-"));
    temporaryRoots.push(cliRoot);
    const scriptRoot = path.join(cliRoot, ".github", "scripts");
    fs.mkdirSync(scriptRoot, { recursive: true });
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts"), scriptRoot, { recursive: true });
    initializeGit(cliRoot);
    writeJson(cliRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current: Pin = {
      package: { name: "jorgex-pi", version: "0.0.0", source: "npm:jorgex-pi@0.0.0" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    };
    writeJson(cliRoot, PIN_PATH, current);
    writeJson(cliRoot, ARTIFACTS_PATH, {
      current,
      previous: current,
      archive: { entries: 1, parity: { source: { commit: "0".repeat(40) } } },
    });
    commit(cliRoot, "stack: cli parser fixture");
    git(cliRoot, ["switch", "-c", "adoption-test"]);

    const result = spawnSync(process.execPath, [
      path.join(scriptRoot, "prepare-pi-adoption.mjs"),
      "--pi-dir",
      cliRoot,
      "--version",
      "0.0.0",
      flag,
    ], { cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("rechaza un archivo ajeno añadido a la transición modular confirmada", async () => {
    const fixture = createAdoptionFixture({
      modularSystemPrompts: true,
      previousDevtoolsHandoff: true,
      devtoolsHandoff: true,
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptModularSystemPrompts: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un módulo de system prompt adicional aunque se confirme la transición modular", async () => {
    const fixture = createAdoptionFixture({
      modularSystemPrompts: true,
      previousDevtoolsHandoff: true,
      devtoolsHandoff: true,
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      extraSystemPromptModule: {
        name: "experimental",
        sourcePath: "stack/system-prompt/experimental.md",
        targetPath: "assets/system-prompt/experimental.md",
        content: "unreviewed system prompt module\n",
      },
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptModularSystemPrompts: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/parity\.v2\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un registro Context7 junto a la transición modular confirmada", async () => {
    const fixture = createAdoptionFixture({
      modularSystemPrompts: true,
      previousDevtoolsHandoff: true,
      devtoolsHandoff: true,
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      extraCapabilities: ["context7-mcp-v1"],
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptModularSystemPrompts: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza bytes de un módulo modular que no coinciden con el productor Git", async () => {
    const fixture = createAdoptionFixture({
      modularSystemPrompts: true,
      previousDevtoolsHandoff: true,
      devtoolsHandoff: true,
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
    });
    const tamperedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/assets/system-prompt/context7.md",
      "tampered module bytes\n",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptModularSystemPrompts: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/context7|module|producer|hash/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un archivo ajeno añadido junto a la retirada confirmada", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un archivo ajeno retirado junto a la retirada confirmada", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      previousExtraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
      removeExtraArchiveFile: "extensions/unrelated.ts",
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado ajeno con el mismo inventario esperado", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
    });
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = true;\n",
      "package/extensions/renamed.ts",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un tarball previo corrupto y conserva pin y fixture", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
    });
    const previousTarball = replaceArchiveMember(
      fixture.root,
      fixture.previousTarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = false;\n",
    );
    const fetch = registryFetch(fixture, { previousTarballBytes: previousTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Registry SRI mismatch/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("no permite que la confirmación de retirada relaje otro cambio de contrato", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      runnerCommands: ["doctor", "sync", "cleanup"],
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/runner\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la retirada si el productor conserva la carpeta de la skill", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      producerPlaywrightSkillTree: true,
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright skill must be absent from producer/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la retirada si la fuente Stack fusionada conserva la carpeta de la skill", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      sourcePlaywrightSkill: true,
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright skill must be absent from Stack source/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un archivo adicional junto al delta de Playwright confirmado", async () => {
    const fixture = createAdoptionFixture({
      playwrightHandoff: true,
      extraArchiveFile: { path: "extensions/extra.ts", content: "export const extra = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright archive inventory requires exactly the reviewed module addition/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado con el mismo número esperado de entradas", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = true;\n",
      "package/extensions/other.ts",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright archive inventory requires exactly the reviewed module addition/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un tarball previo que no coincide con sus bytes fijados", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const previousTarball = replaceArchiveMember(
      fixture.root,
      fixture.previousTarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = false;\n",
    );
    const fetch = registryFetch(fixture, { previousTarballBytes: previousTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Registry SRI mismatch/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza el contenido de playwright.ts si el tarball no coincide con el blob Git del productor", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const substitutedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/playwright.ts",
      "export const playwright = false;\n",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: substitutedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright module does not match producer/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza una mutación ajena del contrato raíz aunque se confirme Playwright", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true, rootContractMutation: true });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una capability adicional junto a la transición confirmada de Playwright", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true, extraCapabilities: ["unexpected-capability-v1"] });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la retirada de Playwright aunque se confirme la transición", async () => {
    const fixture = createAdoptionFixture({ previousPlaywrightHandoff: true, playwrightHandoff: false });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([
    ["sólo añade la capability", { devtoolsCapability: true, devtoolsExclusion: true }],
    ["sólo retira la exclusión", { devtoolsCapability: false, devtoolsExclusion: false }],
  ])("rechaza una transición parcial con confirmación (%s)", async (_label, options) => {
    const fixture = createAdoptionFixture(options);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la transición inversa aunque se confirme DevTools", async () => {
    const fixture = createAdoptionFixture({ previousDevtoolsHandoff: true, devtoolsHandoff: false });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una capability adicional junto a la transición confirmada", async () => {
    const fixture = createAdoptionFixture({ devtoolsHandoff: true, extraCapabilities: ["unexpected-capability-v1"] });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("mantiene la adopción ordinaria compatible aunque se confirme DevTools", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([false, true])("conserva los datos tras fallar la segunda escritura (rollback incompleto: %s)", async (failRollback) => {
    const fixture = createAdoptionFixture();
    const { preparePiAdoption } = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const pinPath = path.join(fixture.root, PIN_PATH);
    const artifactsPath = path.join(fixture.root, ARTIFACTS_PATH);
    const originalPin = fs.readFileSync(pinPath);
    const originalArtifacts = fs.readFileSync(artifactsPath);
    const before = rootState(fixture);
    const publishFailure = new Error("Injected second publication failure");
    const rollbackFailure = new Error("Injected pin restoration failure");
    const realRename = fs.renameSync;
    let stage: string | undefined;
    let pinAtSecondWrite: unknown;
    let failure: unknown;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const source = String(from);
      const parent = path.dirname(source);
      const isStage = path.dirname(parent) === fixture.root && path.basename(parent).startsWith(".pi-adoption-");
      if (isStage && path.basename(source) === "1.new" && String(to) === artifactsPath) {
        stage = parent;
        pinAtSecondWrite = readJson<Pin>(fixture.root, PIN_PATH);
        throw publishFailure;
      }
      if (failRollback && stage !== undefined && source === path.join(stage, "0.old") && String(to) === pinPath) {
        throw rollbackFailure;
      }
      realRename(from, to);
    });
    try {
      syncBuiltinESMExports();
      await preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, {
        fetch: registryFetch(fixture),
        now: () => 0,
        sleep: async () => undefined,
      });
    } catch (error) {
      failure = error;
    } finally {
      rename.mockRestore();
      syncBuiltinESMExports();
    }

    // The fault must occur after the first real publication, not during validation.
    expect(pinAtSecondWrite).toEqual(fixture.next);
    expect(stage).toBeDefined();
    expect(fs.readFileSync(artifactsPath)).toEqual(originalArtifacts);
    if (failRollback) {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ message: "Adoption rollback incomplete", cause: publishFailure, errors: [rollbackFailure], recoveryPath: stage });
      expect(fs.statSync(stage!).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(stage!, "0.old"))).toEqual(originalPin);
      expect(fs.existsSync(pinPath)).toBe(false);
    } else {
      expect(failure).toBe(publishFailure);
      expect(fs.readFileSync(pinPath)).toEqual(originalPin);
      expect(rootState(fixture)).toEqual(before);
      expect(fs.existsSync(stage!)).toBe(false);
    }
  }, 15_000);

  it("ignora GIT_COMMON_DIR heredado de otro repositorio en un no-op válido", async () => {
    const fixture = createAdoptionFixture();
    const { preparePiAdoption } = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    const previous = process.env.GIT_COMMON_DIR;
    const fetch = vi.fn();
    let result: Awaited<ReturnType<PreparePiAdoption>> | undefined;
    let failure: unknown;
    try {
      process.env.GIT_COMMON_DIR = path.join(fixture.piDir, ".git");
      result = await preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: "0.8.7" }, { fetch });
    } catch (error) {
      failure = error;
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previous;
    }

    expect(rootState(fixture)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
    expect(result).toEqual({ status: "unchanged", version: "0.8.7", changedPaths: [] });
  });

  it("expone el preparador async de adopción con dependencias inyectables", async () => {
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as {
      preparePiAdoption?: unknown;
    };

    expect(module.preparePiAdoption).toBeTypeOf("function");
    void (module.preparePiAdoption as PreparePiAdoption);
  });

  it("valida el tag y tar Git reales en dry-run, rota sólo los dos JSON al aplicar, y queda idempotente", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });

    commit(fixture.root, "stack: adopt 0.8.8");
    const callsBeforeIdempotence = fetch.mock.calls.length;
    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, dependencies)).resolves.toEqual({
      status: "unchanged",
      version: fixture.version,
      changedPaths: [],
    });
    expect(fetch).toHaveBeenCalledTimes(callsBeforeIdempotence);
    expect(rootState(fixture).status).toBe("");
  }, 15_000);

  it.each(["0.8.7", "0.8.6"])("no consulta npm para una versión igual o anterior (%s)", async (version) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({ status: "unchanged", version, changedPaths: [] });

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("agota la lectura retryable con reloj inyectado y conserva el checkout", async () => {
    const fixture = createAdoptionFixture();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    let now = 0;
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      sleep,
    })).rejects.toThrow(/not publicly available/i);

    expect(fetch).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
    expect(now).toBeGreaterThan(0);
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([
    {
      label: "campo ajeno en el pin actual",
      expected: /Unsupported pin fields/,
      mutate: (current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        current.unexpected = true;
        (artifacts.current as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en el pin previous",
      expected: /Unsupported pin fields/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        (artifacts.previous as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en artifacts",
      expected: /Unsupported fixture metadata/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        artifacts.unexpected = true;
      },
    },
    {
      label: "campo ajeno en archive",
      expected: /strictly deep-equal/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        (artifacts.archive as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en parity",
      expected: /strictly deep-equal/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        ((artifacts.archive as Record<string, unknown>).parity as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en source",
      expected: /strictly deep-equal/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        const parity = (artifacts.archive as Record<string, unknown>).parity as Record<string, unknown>;
        (parity.source as Record<string, unknown>).unexpected = true;
      },
    },
  ])("rechaza %s sin borrar metadata", async ({ expected, mutate }) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    commitBaselineMutation(fixture, mutate);
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: "0.8.7", apply: true }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(expected);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un SRI SHA512 distinto y preserva ambos JSON", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture, { integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Registry SRI mismatch/);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un tarball npm que no sea la URL exacta publicada", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture, { tarball: "https://registry.npmjs.org/jorgex-pi/-/other-package.tgz" });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Unexpected registry artifact origin/);

    expect(fetch).toHaveBeenCalledOnce();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una versión cuyo tag Pi exacto no existe antes de consultar npm", async () => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: "0.8.9" }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza cambios de contrato antes de consultar npm", async () => {
    const fixture = createAdoptionFixture({ runnerCommands: ["doctor", "sync", "cleanup"] });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/runner\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un checkout Stack dirty antes de consultar npm", async () => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    fs.writeFileSync(path.join(fixture.root, "uncommitted.txt"), "user work\n", "utf8");
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Stack checkout must be clean and exclusively owned/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it.each(["--assume-unchanged", "--skip-worktree"])("rechaza %s que oculta una edición local", async (flag) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const target = path.join(fixture.root, PIN_PATH);
    git(fixture.root, ["update-index", flag, "--", PIN_PATH]);
    fs.appendFileSync(target, " ", "utf8");
    const before = rootState(fixture);

    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Hidden index flags are unsupported/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un destino JSON simbólico antes de consultar npm", async (ctx) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const destination = path.join(fixture.root, ARTIFACTS_PATH);
    const outside = path.join(path.dirname(fixture.root), "outside-artifacts.json");
    fs.renameSync(destination, outside);
    try {
      fs.symlinkSync(outside, destination);
    } catch {
      fs.renameSync(outside, destination);
      ctx.skip("El entorno no permite crear symlinks de archivo.");
      return;
    }
    commit(fixture.root, "stack: symbolic adoption destination");
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Unsafe adoption destination/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("acepta el delta exacto de initialization-diagnostics-v1 de Pi 0.8.23 sólo con confirmación explícita y conserva el inventario", async () => {
    const base = {
      previousModularSystemPrompts: true,
      modularSystemPrompts: true,
      previousContext7Http: true,
      context7Http: true,
      previousPermissionsPolicy: true,
      permissionsPolicy: true,
      previousExperienceDefaults: true,
      experienceDefaults: true,
      previousDevtoolsHandoff: true,
      devtoolsHandoff: true,
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
    } as const;
    const fixture = createAdoptionFixture(base);
    const INITIALIZATION_CAPABILITY = "initialization-diagnostics-v1";
    const EXPERIENCE_DIAGNOSTIC =
      "status reports pending, initialized, invalid, or unreadable from the receipt only; pending means the receipt is absent and requires a registered package; invalid preserves INVALID_PATH, INVALID_RECEIPT, or RECEIPT_TOO_LARGE and unreadable preserves READ_FAILED; status and doctor are read-only and never lock, write, or delete state";
    const PERMISSIONS_DIAGNOSTIC =
      "permission state reports invalid or unreadable files without exposing their contents; a registered package also reports pending when the receipt is not initialized";

    const applyInitializationDelta = () => {
      const contractPath = path.join(fixture.piDir, "contract", "jorgex-pi.v1.json");
      const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as { capabilities: string[] };
      expect(contract.capabilities).not.toContain(INITIALIZATION_CAPABILITY);
      contract.capabilities.push(INITIALIZATION_CAPABILITY);
      fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

      const runnerPath = path.join(fixture.piDir, "contract", "runner.v1.json");
      const runner = JSON.parse(fs.readFileSync(runnerPath, "utf8")) as {
        experience: Record<string, unknown>;
        permissions: { diagnostic: string };
      };
      expect(runner.experience).not.toHaveProperty("diagnostic");
      (runner.experience as Record<string, unknown>).diagnostic = EXPERIENCE_DIAGNOSTIC;
      runner.permissions.diagnostic = PERMISSIONS_DIAGNOSTIC;
      fs.writeFileSync(runnerPath, `${JSON.stringify(runner, null, 2)}\n`, "utf8");

      const schemaPath = path.join(fixture.piDir, "contract", "schemas", "runner-response.v1.schema.json");
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
        $defs: {
          statusResult: { required: string[]; properties: Record<string, unknown> };
          doctorResult: { properties: { checks: { minItems: number; maxItems: number; items: unknown; prefixItems?: unknown } } };
          experience?: unknown;
        };
      };
      expect(schema.$defs.statusResult.required).toEqual(["installation", "engram", "context7", "permissions"]);
      expect(schema.$defs.experience).toBeUndefined();
      schema.$defs.experience = {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized"], properties: { state: { const: "pending" }, receiptPath: { type: "string" }, initialized: { const: false } } },
          { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized"], properties: { state: { const: "initialized" }, receiptPath: { type: "string" }, initialized: { const: true } } },
          { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized", "code", "reason"], properties: { state: { const: "invalid" }, receiptPath: { type: "string" }, initialized: { const: false }, code: { enum: ["INVALID_PATH", "INVALID_RECEIPT", "RECEIPT_TOO_LARGE"] }, reason: { type: "string", minLength: 1 } } },
          { type: "object", additionalProperties: false, required: ["state", "receiptPath", "initialized", "code", "reason"], properties: { state: { const: "unreadable" }, receiptPath: { type: "string" }, initialized: { const: false }, code: { const: "READ_FAILED" }, reason: { type: "string", minLength: 1 } } },
        ],
      };
      schema.$defs.statusResult.required.push("experience");
      schema.$defs.statusResult.properties.experience = { $ref: "#/$defs/experience" };
      const checks = schema.$defs.doctorResult.properties.checks as {
        minItems: number; maxItems: number; items: { properties: { id: { enum: string[] } } }; prefixItems?: unknown;
      };
      expect(checks.minItems).toBe(4);
      expect(checks.maxItems).toBe(4);
      expect(checks.items.properties.id.enum).toEqual(["package", "engram", "context7", "permissions"]);
      const prefixItems = (["package", "engram", "context7", "permissions", "experience"] as const).map((id) => ({
        type: "object",
        additionalProperties: false,
        required: ["id", "status"],
        properties: { id: { const: id }, status: { enum: ["ok", "error"] } },
      }));
      (schema.$defs.doctorResult.properties.checks as unknown as Record<string, unknown>).prefixItems = prefixItems;
      (schema.$defs.doctorResult.properties.checks as unknown as Record<string, unknown>).minItems = 5;
      (schema.$defs.doctorResult.properties.checks as unknown as Record<string, unknown>).maxItems = 5;
      (schema.$defs.doctorResult.properties.checks as unknown as Record<string, unknown>).items = false;
      fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    };

    applyInitializationDelta();
    const nextProducer = commit(fixture.piDir, "pi: 0.8.8 initialization-diagnostics-v1");
    git(fixture.piDir, ["tag", "-f", `v${fixture.version}`, nextProducer]);
    git(fixture.piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
    const tarball = gitArchive(fixture.piDir, nextProducer, true);
    const next = pin(fixture.version, nextProducer, tarball);
    (fixture as { next: Pin }).next = next;
    (fixture as { tarball: Buffer }).tarball = tarball;
    (fixture as { nextArchive: Artifacts["archive"] }).nextArchive = {
      entries: archiveEntries(path.dirname(fixture.root), tarball),
      parity: { source: { commit: fixture.sourceCommit } },
    };

    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);

    const fetch = registryFetch(fixture);
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptInitializationDiagnostics: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(nextEntries).toEqual(previousEntries);
    expect(readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json").capabilities).toContain(INITIALIZATION_CAPABILITY);
  }, 15_000);

  it("rechaza el delta de inicialización sin flag y con deltas ajenos aunque se confirme", async () => {
    const fixture = createAdoptionFixture({
      previousModularSystemPrompts: true,
      modularSystemPrompts: true,
      previousContext7Http: true,
      context7Http: true,
      previousPermissionsPolicy: true,
      permissionsPolicy: true,
      previousExperienceDefaults: true,
      experienceDefaults: true,
      extraCapabilities: ["unexpected-capability-v1"],
    });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptInitializationDiagnostics: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("expone --accept-initialization-diagnostics en el contrato CLI del preparador", () => {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-cli-init-"));
    temporaryRoots.push(cliRoot);
    const scriptRoot = path.join(cliRoot, ".github", "scripts");
    fs.mkdirSync(scriptRoot, { recursive: true });
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts"), scriptRoot, { recursive: true });
    initializeGit(cliRoot);
    writeJson(cliRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current: Pin = {
      package: { name: "jorgex-pi", version: "0.0.0", source: "npm:jorgex-pi@0.0.0" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    };
    writeJson(cliRoot, PIN_PATH, current);
    writeJson(cliRoot, ARTIFACTS_PATH, {
      current,
      previous: current,
      archive: { entries: 1, parity: { source: { commit: "0".repeat(40) } } },
    });
    commit(cliRoot, "stack: cli parser fixture");
    git(cliRoot, ["switch", "-c", "adoption-test"]);

    const result = spawnSync(process.execPath, [
      path.join(scriptRoot, "prepare-pi-adoption.mjs"),
      "--pi-dir",
      cliRoot,
      "--version",
      "0.0.0",
      "--accept-initialization-diagnostics",
    ], { cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("la automatización pasa la aceptación explícita de diagnósticos de inicialización al preparador", async () => {
    const automationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "stack-pi-automation.mjs");
    const automationSource = fs.readFileSync(automationPath, "utf8");
    expect(automationSource).toContain("acceptInitializationDiagnostics");
  });

  it("rechaza el delta Engram child-only sin aceptación explícita", async () => {
    const fixture = createAdoptionFixture({ engramChild: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/runtime-agents\.v1\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: false,
      acceptInitializationDiagnostics: true,
    }, dependencies)).rejects.toThrow(/contract\/runtime-agents\.v1\.json compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("acepta el delta exacto Engram child-only sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({ engramChild: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/runtime-agents\.v1\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });

    const runtimeAgents = readJson<{
      schemaVersion: number;
      agents: Array<{ name: string; tools?: unknown; requiredCapability?: unknown; maxDepth?: unknown; subagentOnlyExtensions?: unknown }>;
    }>(fixture.piDir, "contract/runtime-agents.v1.json");
    expect(runtimeAgents.schemaVersion).toBe(1);
    expect(runtimeAgents.agents).toHaveLength(2);
    const engram = runtimeAgents.agents.find((agent) => agent.name === "engram");
    const tester = runtimeAgents.agents.find((agent) => agent.name === "tester");
    expect(engram).toEqual({
      name: "engram",
      tools: [...ENGRAM_BASELINE_TOOLS],
      requiredCapability: ENGRAM_BASELINE_CAPABILITY,
      maxDepth: ENGRAM_BASELINE_MAX_DEPTH,
      subagentOnlyExtensions: [ENGRAM_CHILD_ROUTE],
    });
    expect(tester).toEqual({ name: "tester" });

    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(previousEntries).not.toContain(`package/${ENGRAM_CHILD_MEMBER}`);
    expect(nextEntries).toContain(`package/${ENGRAM_CHILD_MEMBER}`);
    expect(nextEntries.filter((entry) => !previousEntries.includes(entry)).sort()).toEqual([`package/${ENGRAM_CHILD_MEMBER}`]);
    expect(fixture.nextArchive.entries).toBe(previousEntries.length + 1);
    const producerBytes = git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:${ENGRAM_CHILD_MEMBER}`], false);
    expect(producerBytes).toBe(ENGRAM_CHILD_CONTENT);
  }, 15_000);

  it.each([
    ["ruta distinta", { engramChildRoute: "../extensions/other.ts" }],
    ["array con entrada extra", { engramChildExtra: true }],
    ["tools del agente", { engramToolsMutation: true }],
    ["otro agente", { engramOtherAgentMutation: true }],
  ] as const)("rechaza %s aunque se confirme Engram child-only", async (_label, options) => {
    const fixture = createAdoptionFixture({ ...options });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una capability ajena junto a la transición Engram válida aunque se confirme", async () => {
    const fixture = createAdoptionFixture({ engramChild: true, extraCapabilities: ["unexpected-capability-v1"] });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un archivo ajeno añadido al delta Engram child-only confirmado", async () => {
    const fixture = createAdoptionFixture({
      engramChild: true,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review|archive inventory/i);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza bytes de engram-child.ts que no coinciden con el productor Git", async () => {
    const fixture = createAdoptionFixture({ engramChild: true });
    const tamperedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      `package/${ENGRAM_CHILD_MEMBER}`,
      "tampered Engram child bytes\n",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review|does not match producer|producer/i);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un valor no booleano de acceptEngramChildOnly antes de consultar npm", async () => {
    const fixture = createAdoptionFixture({ engramChild: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptEngramChildOnly: "yes" as unknown as boolean,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Adoption options must be boolean/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("permite una adopción posterior con Engram child-only ya presente aunque el flag persista", async () => {
    const fixture = createAdoptionFixture({ previousEngramChild: true, engramChild: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    const expectedEngram = {
      name: "engram",
      tools: [...ENGRAM_BASELINE_TOOLS],
      requiredCapability: ENGRAM_BASELINE_CAPABILITY,
      maxDepth: ENGRAM_BASELINE_MAX_DEPTH,
      subagentOnlyExtensions: [ENGRAM_CHILD_ROUTE],
    };
    const oldAgents = JSON.parse(git(fixture.piDir, ["show", `${fixture.current.provenance.commit}:contract/runtime-agents.v1.json`], false)) as {
      agents: Array<Record<string, unknown>>;
    };
    const newAgents = JSON.parse(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:contract/runtime-agents.v1.json`], false)) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(oldAgents.agents.find((agent) => agent.name === "engram")).toEqual(expectedEngram);
    expect(newAgents.agents.find((agent) => agent.name === "engram")).toEqual(expectedEngram);
    expect(git(fixture.piDir, ["show", `${fixture.current.provenance.commit}:${ENGRAM_CHILD_MEMBER}`], false)).toBe(ENGRAM_CHILD_CONTENT);
    expect(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:${ENGRAM_CHILD_MEMBER}`], false)).toBe(ENGRAM_CHILD_CONTENT);
    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(previousEntries).toContain(`package/${ENGRAM_CHILD_MEMBER}`);
    expect(nextEntries).toContain(`package/${ENGRAM_CHILD_MEMBER}`);
    expect([...nextEntries].sort()).toEqual([...previousEntries].sort());
    expect(fixture.nextArchive.entries).toBe(previousEntries.length);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("la automatización pasa la aceptación explícita Engram child-only al preparador", async () => {
    const automationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "stack-pi-automation.mjs");
    const automationSource = fs.readFileSync(automationPath, "utf8");
    expect(automationSource).toContain("acceptEngramChildOnly");
  });

  it("expone --accept-engram-child-only en el contrato CLI del preparador", () => {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-cli-engram-"));
    temporaryRoots.push(cliRoot);
    const scriptRoot = path.join(cliRoot, ".github", "scripts");
    fs.mkdirSync(scriptRoot, { recursive: true });
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts"), scriptRoot, { recursive: true });
    initializeGit(cliRoot);
    writeJson(cliRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current: Pin = {
      package: { name: "jorgex-pi", version: "0.0.0", source: "npm:jorgex-pi@0.0.0" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    };
    writeJson(cliRoot, PIN_PATH, current);
    writeJson(cliRoot, ARTIFACTS_PATH, {
      current,
      previous: current,
      archive: { entries: 1, parity: { source: { commit: "0".repeat(40) } } },
    });
    commit(cliRoot, "stack: cli parser fixture");
    git(cliRoot, ["switch", "-c", "adoption-test"]);

    const result = spawnSync(process.execPath, [
      path.join(scriptRoot, "prepare-pi-adoption.mjs"),
      "--pi-dir",
      cliRoot,
      "--version",
      "0.0.0",
      "--accept-engram-child-only",
    ], { cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  // T38 RED: transición oficial Engram Pi 0.8.28 (v0.8.27@97fb35c -> v0.8.28@056fbc7).
  // Delta revisado read-only desde productor y ambos tarballs:
  // - capabilities: mcp-adapter-v1 -> engram-official-bridge-v1 (misma posición tras goal-continuation-v1)
  // - runtime-agents engram: retira tools (6 oficiales) y subagentOnlyExtensions ["../extensions/engram-child.ts"]; conserva name/source/target/tier/status/requiredCapability/maxSubagentDepth
  // - agents/engram.md: retira tools: y subagentOnlyExtensions: (162 -> mismos menos 2 líneas)
  // - assets preserved: pi-mcp-adapter/mcp-cache.json -> official-engram-setup/mcp-cache.json + 4 nuevas (official-engram-setup npm/node_modules/gentle-engram, official-engram-setup npm/node_modules/pi-mcp-adapter, engram HOME .local/bin/engram, engram HOME .engram)
  // - components: retira pi-mcp-adapter@2.27.0 (integrity sha512-IM9dfGhou5Q5AJqwkm1kW1+WXyMsvL53GEO4JVYukzvTxNPHn2b+Zi49+JAnOhlaOpEq5vEodUSJXmpghik+lw==)
  // - package deps: retira pi-mcp-adapter@2.27.0, añade strip-json-comments@5.0.3; devDeps retira pi-mcp-adapter
  // - archive: 13401 -> 12290 (-1111 solo retiradas: 2 shim extensions/engram-child.ts + extensions/engram-mcp-wrapper.mjs y 1109 node_modules del closure bundled); tar==git para contratos y bytes cambiados; package.json ignora packageManager
  // - bytes 0.8.28: 17993987, sha256 3490845ad6d67c82cb0828847d0c9510a58958f068c4e8408161aadfe6f28ed9, sha512 7ec1c46ccbafe8052effca13ef5e2bdff2ad09a2624bbe4ad7884622e231bbe25119b7124b6ba8f96916be34d99e511bfd83a9c16708d6f828ccf9f9d705bd7c (integrity spec); fileCount 12290
  // El fixture modela la transición completa de inventario con un centinela por cada
  // una de las 53 raíces `package/node_modules/<root>` retiradas más los 2 shim de
  // extensiones; la implementación debe exigir la igualdad total ordenada del
  // inventario (cero añadidas, retiradas exactamente las revisadas).
  function applyOfficialEngramDelta(
    fixture: AdoptionFixture,
    options: {
      retainMcpWrapper?: boolean;
      retainClosureMember?: string;
      skip?: { package?: boolean; components?: boolean; assets?: boolean };
      drift?: (piDir: string) => void;
    } = {},
  ): void {
    const contractPath = path.join(fixture.piDir, "contract", "jorgex-pi.v1.json");
    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(REMOVED_MCP_ADAPTER_CAPABILITY);
    expect(contract.capabilities).not.toContain(OFFICIAL_ENGRAM_CAPABILITY);
    const capabilityIndex = contract.capabilities.indexOf(REMOVED_MCP_ADAPTER_CAPABILITY);
    contract.capabilities.splice(capabilityIndex, 1, OFFICIAL_ENGRAM_CAPABILITY);
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

    const agentsPath = path.join(fixture.piDir, "contract", "runtime-agents.v1.json");
    const agents = readJson<{ schemaVersion: number; agents: Array<Record<string, unknown>> }>(
      fixture.piDir,
      "contract/runtime-agents.v1.json",
    );
    const engram = agents.agents.find((agent) => (agent as { name?: string }).name === "engram") as
      | Record<string, unknown>
      | undefined;
    expect(engram).toBeDefined();
    expect(engram).toMatchObject({
      requiredCapability: ENGRAM_BASELINE_CAPABILITY,
      maxDepth: ENGRAM_BASELINE_MAX_DEPTH,
      subagentOnlyExtensions: [ENGRAM_CHILD_ROUTE],
    });
    delete engram!.tools;
    delete engram!.subagentOnlyExtensions;
    fs.writeFileSync(agentsPath, `${JSON.stringify(agents, null, 2)}\n`, "utf8");

    expect(fs.existsSync(path.join(fixture.piDir, ENGRAM_CHILD_MEMBER))).toBe(true);
    expect(fs.existsSync(path.join(fixture.piDir, ENGRAM_MCP_WRAPPER_MEMBER))).toBe(true);
    fs.rmSync(path.join(fixture.piDir, ENGRAM_CHILD_MEMBER), { force: true });
    if (!options.retainMcpWrapper) fs.rmSync(path.join(fixture.piDir, ENGRAM_MCP_WRAPPER_MEMBER), { force: true });
    for (const member of OFFICIAL_REMOVED_NODE_ROOTS) {
      const sentinel = path.join(fixture.piDir, "node_modules", member, OFFICIAL_CLOSURE_SENTINEL);
      if (options.retainClosureMember === member) {
        expect(fs.existsSync(sentinel)).toBe(true);
        continue;
      }
      fs.rmSync(path.join(fixture.piDir, "node_modules", member), { recursive: true, force: true });
    }

    const packagePath = path.join(fixture.piDir, "package.json");
    const producerPackage = readJson<{ dependencies: Record<string, string>; bundledDependencies: string[] }>(
      fixture.piDir,
      "package.json",
    );
    expect(producerPackage.dependencies).toEqual({
      "pi-web-access": "0.24.1",
      [REMOVED_ADAPTER_DEPENDENCY]: REMOVED_ADAPTER_VERSION,
    });
    expect(producerPackage.bundledDependencies).toEqual([...OFFICIAL_BUNDLE_BASE, REMOVED_ADAPTER_DEPENDENCY]);
    if (!options.skip?.package) {
      delete producerPackage.dependencies[REMOVED_ADAPTER_DEPENDENCY];
      producerPackage.dependencies[ADDED_JSONC_DEPENDENCY] = ADDED_JSONC_VERSION;
      producerPackage.bundledDependencies = [...OFFICIAL_BUNDLE_BASE, ADDED_JSONC_DEPENDENCY];
      fs.writeFileSync(packagePath, `${JSON.stringify(producerPackage, null, 2)}\n`, "utf8");
    }

    const componentsPath = path.join(fixture.piDir, "contract", "components.v1.json");
    const producerComponents = readJson<{ schemaVersion: number; components: unknown[] }>(
      fixture.piDir,
      "contract/components.v1.json",
    );
    expect(producerComponents.components).toContainEqual(REMOVED_ADAPTER_COMPONENT);
    if (!options.skip?.components) {
      const withoutAdapter = producerComponents.components.filter(
        (component) => JSON.stringify(component) !== JSON.stringify(REMOVED_ADAPTER_COMPONENT),
      );
      expect(withoutAdapter).toHaveLength(producerComponents.components.length - 1);
      producerComponents.components = withoutAdapter;
      fs.writeFileSync(componentsPath, `${JSON.stringify(producerComponents, null, 2)}\n`, "utf8");
    }

    const assetsPath = path.join(fixture.piDir, "contract", "assets.v1.json");
    const producerAssets = readJson<{ preservedExternalState: Array<Record<string, string>> }>(
      fixture.piDir,
      "contract/assets.v1.json",
    );
    expect(producerAssets.preservedExternalState).toContainEqual(PRESERVED_ADAPTER_CACHE);
    if (!options.skip?.assets) {
      let replaced = 0;
      producerAssets.preservedExternalState = producerAssets.preservedExternalState.map((entry) => {
        if (JSON.stringify(entry) === JSON.stringify(PRESERVED_ADAPTER_CACHE)) {
          replaced += 1;
          return { ...PRESERVED_OFFICIAL_CACHE };
        }
        return entry;
      });
      expect(replaced).toBe(1);
      producerAssets.preservedExternalState.push(...OFFICIAL_PRESERVED_ADDITIONS.map((entry) => ({ ...entry })));
      fs.writeFileSync(assetsPath, `${JSON.stringify(producerAssets, null, 2)}\n`, "utf8");
    }

    options.drift?.(fixture.piDir);

    const nextProducer = commit(fixture.piDir, "pi: 0.8.8 official-engram");
    git(fixture.piDir, ["tag", "-f", `v${fixture.version}`, nextProducer]);
    git(fixture.piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
    const tarball = gitArchive(fixture.piDir, nextProducer);
    (fixture as { next: Pin }).next = pin(fixture.version, nextProducer, tarball);
    (fixture as { tarball: Buffer }).tarball = tarball;
    (fixture as { nextArchive: Artifacts["archive"] }).nextArchive = {
      entries: archiveEntries(path.dirname(fixture.root), tarball),
      parity: { source: { commit: fixture.sourceCommit } },
    };
  }

  // Baseline oficial único: los 12 flags del estado previo/post previo al
  // delta oficial Engram; los tests que necesitan mutaciones extra los
  // extienden con spread sin duplicar la lista (T51).
  const OFFICIAL_ENGRAM_BASELINE_FIXTURE = {
    previousEngramChild: true,
    engramChild: true,
    previousEngramMcpWrapper: true,
    engramMcpWrapper: true,
    previousBundledAdapterClosure: true,
    bundledAdapterClosure: true,
    previousBundledAdapterPackage: true,
    bundledAdapterPackage: true,
    previousBundledAdapterComponent: true,
    bundledAdapterComponent: true,
    previousBundledAdapterPreserved: true,
    bundledAdapterPreserved: true,
  } as const;

  function createOfficialEngramFixture(deltaOptions: {
    retainMcpWrapper?: boolean;
    retainClosureMember?: string;
    skip?: { package?: boolean; components?: boolean; assets?: boolean };
    drift?: (piDir: string) => void;
  } = {}): AdoptionFixture {
    const fixture = createAdoptionFixture({ ...OFFICIAL_ENGRAM_BASELINE_FIXTURE });
    applyOfficialEngramDelta(fixture, deltaOptions);
    return fixture;
  }

  // Inventario revisado completo en términos del fixture: los 2 shim, un
  // centinela por cada una de las 53 raíces del closure y las entradas de
  // directorio que git archive emite y que quedan vacías tras la retirada.
  function officialReviewedRemovals(): string[] {
    const removals = OFFICIAL_REMOVED_EXTENSION_MEMBERS.map((member) => `package/${member}`);
    for (const member of OFFICIAL_REMOVED_NODE_ROOTS) {
      removals.push(`package/node_modules/${member}/${OFFICIAL_CLOSURE_SENTINEL}`, `package/node_modules/${member}/`);
    }
    const scopes = new Set(
      OFFICIAL_REMOVED_NODE_ROOTS.filter((member) => member.includes("/")).map((member) => member.split("/")[0]),
    );
    for (const scope of [...scopes].sort()) removals.push(`package/node_modules/${scope}/`);
    removals.push("package/node_modules/");
    return removals;
  }

  it("rechaza la transición oficial Engram sin aceptación explícita", async () => {
    const fixture = createOfficialEngramFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("acepta el delta exacto oficial Engram sólo con confirmación explícita", async () => {
    const fixture = createOfficialEngramFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });

    const contract = readJson<{ capabilities: string[] }>(fixture.piDir, "contract/jorgex-pi.v1.json");
    expect(contract.capabilities).toContain(OFFICIAL_ENGRAM_CAPABILITY);
    expect(contract.capabilities).not.toContain(REMOVED_MCP_ADAPTER_CAPABILITY);
    const runtimeAgents = readJson<{
      schemaVersion: number;
      agents: Array<{ name: string; subagentOnlyExtensions?: unknown; tools?: unknown }>;
    }>(fixture.piDir, "contract/runtime-agents.v1.json");
    const engram = runtimeAgents.agents.find((agent) => agent.name === "engram");
    expect(engram).toBeDefined();
    expect(engram).not.toHaveProperty("subagentOnlyExtensions");
    expect(engram).not.toHaveProperty("tools");

    const producerPackage = readJson<{ dependencies: Record<string, string>; bundledDependencies: string[] }>(
      fixture.piDir,
      "package.json",
    );
    expect(producerPackage.dependencies).toEqual({
      "pi-web-access": "0.24.1",
      [ADDED_JSONC_DEPENDENCY]: ADDED_JSONC_VERSION,
    });
    expect(producerPackage.bundledDependencies).toEqual([...OFFICIAL_BUNDLE_BASE, ADDED_JSONC_DEPENDENCY]);

    const producerComponents = readJson<{ schemaVersion: number; components: unknown[] }>(
      fixture.piDir,
      "contract/components.v1.json",
    );
    expect(producerComponents.components).toEqual(["agents", "assets"]);

    const producerAssets = readJson<{ preservedExternalState: unknown[] }>(
      fixture.piDir,
      "contract/assets.v1.json",
    );
    expect(producerAssets.preservedExternalState).toContainEqual(PRESERVED_OFFICIAL_CACHE);
    expect(producerAssets.preservedExternalState).not.toContainEqual(PRESERVED_ADAPTER_CACHE);
    for (const entry of OFFICIAL_PRESERVED_ADDITIONS) {
      expect(producerAssets.preservedExternalState).toContainEqual(entry);
    }

    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    const reviewedRemovals = officialReviewedRemovals();
    for (const member of reviewedRemovals) expect(previousEntries).toContain(member);
    expect(nextEntries.filter((entry) => !previousEntries.includes(entry))).toEqual([]);
    expect(previousEntries.filter((entry) => !nextEntries.includes(entry)).sort()).toEqual([...reviewedRemovals].sort());
    expect(fixture.nextArchive.entries).toBe(previousEntries.length - reviewedRemovals.length);
    for (const member of OFFICIAL_REMOVED_EXTENSION_MEMBERS) {
      expect(nextEntries).not.toContain(`package/${member}`);
      expect(git(fixture.piDir, ["ls-tree", "--name-only", fixture.next.provenance.commit, "--", member]).trim()).toBe("");
      expect(git(fixture.piDir, ["ls-tree", "--name-only", fixture.current.provenance.commit, "--", member]).trim()).not.toBe("");
    }
    for (const member of OFFICIAL_REMOVED_NODE_ROOTS) {
      const prefix = `package/node_modules/${member}`;
      expect(nextEntries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`))).toBe(false);
    }
    const adapterPrefix = "package/node_modules/pi-mcp-adapter";
    expect(previousEntries.some((entry) => entry.startsWith(`${adapterPrefix}/`))).toBe(true);
    expect(nextEntries.some((entry) => entry === adapterPrefix || entry.startsWith(`${adapterPrefix}/`))).toBe(false);
    expect(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:contract/jorgex-pi.v1.json`], false)).toContain(OFFICIAL_ENGRAM_CAPABILITY);
  }, 15_000);

  it("no reutiliza acceptEngramChildOnly para la transición oficial Engram", async () => {
    const fixture = createOfficialEngramFixture();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramChildOnly: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["una capability adicional", { extraCapabilities: ["unexpected-capability-v1"] }],
    ["un runner command adicional", { runnerCommands: ["doctor", "sync", "cleanup"] }],
    ["una mutación del contrato raíz", { rootContractMutation: true }],
  ] as const)("rechaza %s aunque se confirme la transición oficial Engram", async (_label, options) => {
    const base = createAdoptionFixture({
      ...OFFICIAL_ENGRAM_BASELINE_FIXTURE,
      ...options,
    });
    applyOfficialEngramDelta(base);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(base);

    await expect(module.preparePiAdoption({
      root: base.root,
      piDir: base.piDir,
      version: base.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(base)).toEqual(before);
  });

  it("rechaza un archivo ajeno añadido al delta oficial Engram confirmado", async () => {
    const fixture = createAdoptionFixture({
      ...OFFICIAL_ENGRAM_BASELINE_FIXTURE,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    applyOfficialEngramDelta(fixture);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza el shim engram-mcp-wrapper retenido aunque se confirme la transición oficial Engram", async () => {
    const fixture = createAdoptionFixture({
      ...OFFICIAL_ENGRAM_BASELINE_FIXTURE,
    });
    applyOfficialEngramDelta(fixture, { retainMcpWrapper: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza el closure bundled retenido aunque se confirme la transición oficial Engram", async () => {
    const fixture = createAdoptionFixture({
      ...OFFICIAL_ENGRAM_BASELINE_FIXTURE,
    });
    applyOfficialEngramDelta(fixture, { retainClosureMember: "pi-mcp-adapter" });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza una retirada ajena junto al delta oficial Engram confirmado", async () => {
    const fixture = createAdoptionFixture({
      ...OFFICIAL_ENGRAM_BASELINE_FIXTURE,
      removeExtraArchiveFile: "extensions/bootstrap.ts",
    });
    applyOfficialEngramDelta(fixture);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["el swap de package", { package: true }],
    ["la retirada del componente", { components: true }],
    ["la transición de preserved", { assets: true }],
  ] as const)("rechaza la transición oficial Engram incompleta sin %s", async (_label, skip) => {
    const fixture = createOfficialEngramFixture({ skip });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([
    ["una versión de dependencia no revisada", (piDir: string) => {
      const producerPackage = readJson<{ dependencies: Record<string, string> }>(piDir, "package.json");
      producerPackage.dependencies[ADDED_JSONC_DEPENDENCY] = "9.9.9";
      writeJson(piDir, "package.json", producerPackage);
    }],
    ["el adapter retenido en el bundle", (piDir: string) => {
      const producerPackage = readJson<{ bundledDependencies: string[] }>(piDir, "package.json");
      producerPackage.bundledDependencies = [...OFFICIAL_BUNDLE_BASE, REMOVED_ADAPTER_DEPENDENCY];
      writeJson(piDir, "package.json", producerPackage);
    }],
    ["el componente del adapter retenido", (piDir: string) => {
      const producerComponents = readJson<{ components: unknown[] }>(piDir, "contract/components.v1.json");
      producerComponents.components.push({ ...REMOVED_ADAPTER_COMPONENT });
      writeJson(piDir, "contract/components.v1.json", producerComponents);
    }],
    ["una integridad de componente no revisada", (piDir: string) => {
      const producerComponents = readJson<{ components: unknown[] }>(piDir, "contract/components.v1.json");
      producerComponents.components.push({
        ...REMOVED_ADAPTER_COMPONENT,
        integrity: "sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000==",
      });
      writeJson(piDir, "contract/components.v1.json", producerComponents);
    }],
    ["una entrada preservada ausente", (piDir: string) => {
      const producerAssets = readJson<{ preservedExternalState: Array<Record<string, string>> }>(piDir, "contract/assets.v1.json");
      producerAssets.preservedExternalState = producerAssets.preservedExternalState.filter(
        (entry) => JSON.stringify(entry) !== JSON.stringify(OFFICIAL_PRESERVED_ADDITIONS[3]),
      );
      writeJson(piDir, "contract/assets.v1.json", producerAssets);
    }],
    ["una entrada preservada ajena", (piDir: string) => {
      const producerAssets = readJson<{ preservedExternalState: unknown[] }>(piDir, "contract/assets.v1.json");
      producerAssets.preservedExternalState.push({
        owner: "user",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "unexpected.json",
      });
      writeJson(piDir, "contract/assets.v1.json", producerAssets);
    }],
  ] as const)("rechaza el drift %s aunque se confirme la transición oficial Engram", async (_label, drift) => {
    const drifted = createAdoptionFixture({
      ...OFFICIAL_ENGRAM_BASELINE_FIXTURE,
    });
    applyOfficialEngramDelta(drifted, { drift });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(drifted);

    await expect(module.preparePiAdoption({
      root: drifted.root,
      piDir: drifted.piDir,
      version: drifted.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(drifted)).toEqual(before);
  });

  it("rechaza un renombrado con el mismo inventario esperado durante el delta oficial Engram", async () => {
    const fixture = createOfficialEngramFixture();
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = true;\n",
      "package/extensions/renamed.ts",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un tarball oficial Engram cuyo contrato no coincide con el productor Git", async () => {
    const fixture = createOfficialEngramFixture();
    const tamperedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/contract/jorgex-pi.v1.json",
      JSON.stringify({ tampered: true }),
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/does not match the producer/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un valor no booleano de acceptOfficialEngram antes de consultar npm", async () => {
    const fixture = createOfficialEngramFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptOfficialEngram: "yes" as unknown as boolean,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Adoption options must be boolean/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("la automatización pasa la aceptación explícita oficial Engram al preparador", async () => {
    const automationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "stack-pi-automation.mjs");
    const automationSource = fs.readFileSync(automationPath, "utf8");
    expect(automationSource).toContain("acceptOfficialEngram");
  });

  it("expone --accept-official-engram en el contrato CLI del preparador", () => {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-cli-official-"));
    temporaryRoots.push(cliRoot);
    const scriptRoot = path.join(cliRoot, ".github", "scripts");
    fs.mkdirSync(scriptRoot, { recursive: true });
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts"), scriptRoot, { recursive: true });
    initializeGit(cliRoot);
    writeJson(cliRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current: Pin = {
      package: { name: "jorgex-pi", version: "0.0.0", source: "npm:jorgex-pi@0.0.0" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    };
    writeJson(cliRoot, PIN_PATH, current);
    writeJson(cliRoot, ARTIFACTS_PATH, {
      current,
      previous: current,
      archive: { entries: 1, parity: { source: { commit: "0".repeat(40) } } },
    });
    commit(cliRoot, "stack: cli parser fixture");
    git(cliRoot, ["switch", "-c", "adoption-test"]);

    const result = spawnSync(process.execPath, [
      path.join(scriptRoot, "prepare-pi-adoption.mjs"),
      "--pi-dir",
      cliRoot,
      "--version",
      "0.0.0",
      "--accept-official-engram",
    ], { cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  // T65 RED: transición provider-only Pi 0.8.29 (v0.8.28@056fbc7 -> v0.8.29@bbaf80f).
  // Delta revisado read-only desde productor y ambos tarballs publicados:
  // - package.json: version 0.8.28 -> 0.8.29 (único cambio; resto idéntico).
  // - contract/jorgex-pi.v1.json: package.version/source 0.8.28 -> 0.8.29;
  //   capabilities, pi (0.84.2), runtimeAgents, runner, assets, components,
  //   schemas y dependencias idénticos (sin drift de provider).
  // - contract/parity.v2.json: source.commit 09947922e6aafee5b75286b56e8f88dd22b8fba0
  //   -> a140809253e2a069fac2fa99c4b9ef45fe78f97f; retira exacta
  //   engramProtocol { sourcePath stack/system-prompt/engram-protocol.md,
  //   targetPath assets/system-prompt/engram-protocol.md, sourceSha256/outputSha256
  //   e23997eda1d8d43c587b5e864b280d4c77055dd30f558c9e9288264398929591 };
  //   agents/skills/systemPromptModules/permissions/policy/exclusions idénticos.
  // - asset retirado: assets/system-prompt/engram-protocol.md (4441 bytes en 0.8.28,
  //   ausente en 0.8.29; Stack también retira stack/system-prompt/engram-protocol.md).
  // - archive: 12290 -> 12289 (-1 exacta package/assets/system-prompt/engram-protocol.md,
  //   0 añadidas); bytes 17993987 -> 17991325; sha256 3490845ad6d67c82cb0828847d0c9510a58958f068c4e8408161aadfe6f28ed9
  //   -> e322f5e2d79974321ef5f3acf1e338c9f2a1e31d5b7796e8c3f5ff88fc886eca;
  //   integrity 0.8.29 sha512-FewjApWFBvsLb8Ks7FXozgI9q3LvNrL+rf64Z4U5XpTlGvFWN0ZWaUdFBwrShV7QCLnJo7wv0hLekmHPuToWSQ==
  //   (fileCount registry 12289); tar==git para contratos y bytes retenidos.
  // El fixture modela la retirada con un asset simplificado (misma forma:
  // parity.engramProtocol + package/assets/.../engram-protocol.md, -1 entrada);
  // la implementación debe exigir flag explícito nuevo (no reutilizar
  // acceptOfficialEngram 0.8.28, más amplio), igualdad total del resto y
  // bytes/inventario exactos.
  const ENGRAM_PROTOCOL_REMOVAL_FIXTURE = {
    previousEngramProtocol: true,
    engramProtocol: false,
  } as const;

  it("rechaza la retirada provider-only de engramProtocol sin aceptación explícita", async () => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("acepta la retirada exacta provider-only sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });

    const oldParity = JSON.parse(git(fixture.piDir, ["show", `${fixture.current.provenance.commit}:contract/parity.v2.json`], false)) as {
      engramProtocol?: unknown;
    };
    const newParity = JSON.parse(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:contract/parity.v2.json`], false)) as {
      engramProtocol?: unknown;
    };
    expect(oldParity.engramProtocol).toEqual({
      sourcePath: ENGRAM_PROTOCOL_SOURCE_PATH,
      targetPath: ENGRAM_PROTOCOL_TARGET_PATH,
      sourceSha256: sha256(Buffer.from(ENGRAM_PROTOCOL_CONTENT, "utf8")),
      outputSha256: sha256(Buffer.from(ENGRAM_PROTOCOL_CONTENT, "utf8")),
    });
    expect(newParity).not.toHaveProperty("engramProtocol");

    const previousEntries = archiveEntryNames(path.dirname(fixture.root), fixture.previousTarball);
    const nextEntries = archiveEntryNames(path.dirname(fixture.root), fixture.tarball);
    expect(previousEntries).toContain(`package/${ENGRAM_PROTOCOL_TARGET_PATH}`);
    expect(nextEntries).not.toContain(`package/${ENGRAM_PROTOCOL_TARGET_PATH}`);
    expect(nextEntries.filter((entry) => !previousEntries.includes(entry))).toEqual([]);
    expect(previousEntries.filter((entry) => !nextEntries.includes(entry))).toEqual([`package/${ENGRAM_PROTOCOL_TARGET_PATH}`]);
    expect(fixture.nextArchive.entries).toBe(previousEntries.length - 1);
    expect(git(fixture.piDir, ["ls-tree", "--name-only", fixture.next.provenance.commit, "--", ENGRAM_PROTOCOL_TARGET_PATH]).trim()).toBe("");
    expect(git(fixture.piDir, ["ls-tree", "--name-only", fixture.current.provenance.commit, "--", ENGRAM_PROTOCOL_TARGET_PATH]).trim()).not.toBe("");
  }, 15_000);

  it("no reutiliza acceptOfficialEngram para la retirada provider-only", async () => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptOfficialEngram: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it.each([
    ["una capability adicional", { extraCapabilities: ["unexpected-capability-v1"] }],
    ["un runner command adicional", { runnerCommands: ["doctor", "sync", "cleanup"] }],
    ["una mutación del contrato raíz", { rootContractMutation: true }],
  ] as const)("rechaza %s aunque se confirme la retirada provider-only", async (_label, options) => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE, ...options });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un archivo ajeno añadido al delta provider-only confirmado", async () => {
    const fixture = createAdoptionFixture({
      ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza el protocolo retenido aunque se confirme la retirada provider-only", async () => {
    const fixture = createAdoptionFixture({
      previousEngramProtocol: true,
      engramProtocol: true,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review|compatibility requires manual review/i);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado con el mismo inventario esperado durante el delta provider-only", async () => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE });
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = true;\n",
      "package/extensions/renamed.ts",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un tarball provider-only cuyo contrato no coincide con el productor Git", async () => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE });
    const tamperedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/contract/jorgex-pi.v1.json",
      JSON.stringify({ tampered: true }),
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: tamperedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/does not match the producer/i);
    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un valor no booleano de acceptEngramProtocolRemoval antes de consultar npm", async () => {
    const fixture = createAdoptionFixture({ ...ENGRAM_PROTOCOL_REMOVAL_FIXTURE });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptEngramProtocolRemoval: "yes" as unknown as boolean,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Adoption options must be boolean/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("la automatización pasa la aceptación explícita provider-only al preparador", async () => {
    const automationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "stack-pi-automation.mjs");
    const automationSource = fs.readFileSync(automationPath, "utf8");
    expect(automationSource).toContain("acceptEngramProtocolRemoval");
  });

  it("expone --accept-engram-protocol-removal en el contrato CLI del preparador", () => {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-cli-engram-protocol-"));
    temporaryRoots.push(cliRoot);
    const scriptRoot = path.join(cliRoot, ".github", "scripts");
    fs.mkdirSync(scriptRoot, { recursive: true });
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts"), scriptRoot, { recursive: true });
    initializeGit(cliRoot);
    writeJson(cliRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current: Pin = {
      package: { name: "jorgex-pi", version: "0.0.0", source: "npm:jorgex-pi@0.0.0" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    };
    writeJson(cliRoot, PIN_PATH, current);
    writeJson(cliRoot, ARTIFACTS_PATH, {
      current,
      previous: current,
      archive: { entries: 1, parity: { source: { commit: "0".repeat(40) } } },
    });
    commit(cliRoot, "stack: cli parser fixture");
    git(cliRoot, ["switch", "-c", "adoption-test"]);

    const result = spawnSync(process.execPath, [
      path.join(scriptRoot, "prepare-pi-adoption.mjs"),
      "--pi-dir",
      cliRoot,
      "--version",
      "0.0.0",
      "--accept-engram-protocol-removal",
    ], { cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  // T70 RED: flag permanente idempotente tras 0.8.29. Automation pasa
  // acceptEngramProtocolRemoval:true siempre; una baseline/candidato posterior
  // donde ambas paridades ya omiten engramProtocol debe ser no-op (flag no
  // aplicable) y la adopción ordinaria compatible procede sin bloqueo histórico.
  it("mantiene la adopción ordinaria compatible aunque se confirme la retirada histórica de engramProtocol", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    const oldParity = JSON.parse(git(fixture.piDir, ["show", `${fixture.current.provenance.commit}:contract/parity.v2.json`], false)) as {
      engramProtocol?: unknown;
    };
    const newParity = JSON.parse(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:contract/parity.v2.json`], false)) as {
      engramProtocol?: unknown;
    };
    expect(oldParity).not.toHaveProperty("engramProtocol");
    expect(newParity).not.toHaveProperty("engramProtocol");

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  // T70 guards: el flag histórico no autoriza retención (old+new presentes) ni
  // reintroducción (old ausente + new presente); sólo la transición exacta
  // oldHas && !newHas de T65 queda autorizada.
  it.each([
    ["la retención del protocolo", { previousEngramProtocol: true, engramProtocol: true }],
    ["la reintroducción del protocolo", { engramProtocol: true }],
  ] as const)("rechaza %s aunque se confirme la retirada histórica", async (_label, options) => {
    const fixture = createAdoptionFixture({ ...options });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    const newParity = JSON.parse(git(fixture.piDir, ["show", `${fixture.next.provenance.commit}:contract/parity.v2.json`], false)) as {
      engramProtocol?: unknown;
    };
    expect(newParity).toHaveProperty("engramProtocol");

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptEngramProtocolRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review|compatibility requires manual review/i);
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);
});
