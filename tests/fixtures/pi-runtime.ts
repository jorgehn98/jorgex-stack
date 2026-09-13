import artifacts from "./pi-runtime-artifacts.json" with { type: "json" };

/**
 * Data-only candidate frozen from independently reviewed registry metadata.
 * Lifecycle tests must not consume a live checkout.
 * The provenance commit is the release checkout. The workflow trigger is
 * attestation metadata, not this fixture's release-checkout provenance.
 */
export const PI_RUNTIME_CANDIDATE = {
  ...artifacts.current,
  pi: {
    testedVersions: ["0.84.2", "0.85.1"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
      "foundation-contract-v1",
      "stack-snapshot-v2",
      "modular-system-prompts-v1",
      "runtime-agents-v1",
      "permission-gated-tools-v1",
      "structured-questions-v1",
      "web-access-v1",
      "goal-continuation-v1",
      "mcp-adapter-v1",
      "engram-runtime-tools-v1",
      "context7-http-v1",
      "permissions-policy-v1",
      "experience-defaults-v1",
      "chrome-devtools-handoff-v1",
      "playwright-handoff-v1",
      "runner-json-v1",
      "tui-branding-v1",
      "managed-primary-model-v1",
      "quality-receipt-contract-v1",
      "quality-capabilities-contract-v1",
    ],
    runner: {
      bin: "jorgex-pi",
      commands: ["status", "doctor", "models", "sync", "cleanup"],
      schemaVersion: 1,
      maxStdoutBytes: 65_536,
    },
    managedExternalWrites: [
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "settings.json",
        semantics: "merge a missing or matching partial defaultProvider=openai-codex and defaultModel=gpt-5.6-sol pair plus first-visit theme=JorgeX, quietStartup=true, and hideThinkingBlock=true defaults; preserve foreign halves and existing experience values; cleanup removes only receipt-owned exact values",
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
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "jorgex-pi/experience-lifecycle.v1.json",
        semantics: "record first initialization and exact ownership of missing theme, quietStartup, and hideThinkingBlock fields; preserve replacements and do not reseed after initialization",
      },
    ],
  },
} as const;

/**
 * Test-only context for the previously accepted Stack/Pi pin. It models the
 * outgoing Stack context for rollback tests and is not a production candidate.
 */
export const PI_RUNTIME_PREVIOUS_CANDIDATE = {
  ...artifacts.previous,
  pi: {
    testedVersions: ["0.84.2", "0.85.1"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
      "foundation-contract-v1",
      "stack-snapshot-v2",
      "modular-system-prompts-v1",
      "runtime-agents-v1",
      "permission-gated-tools-v1",
      "structured-questions-v1",
      "web-access-v1",
      "goal-continuation-v1",
      "mcp-adapter-v1",
      "engram-runtime-tools-v1",
      "context7-http-v1",
      "permissions-policy-v1",
      "chrome-devtools-handoff-v1",
      "playwright-handoff-v1",
      "runner-json-v1",
      "tui-branding-v1",
      "managed-primary-model-v1",
      "quality-receipt-contract-v1",
      "quality-capabilities-contract-v1",
    ],
    runner: {
      bin: "jorgex-pi",
      commands: ["status", "doctor", "models", "sync", "cleanup"],
      schemaVersion: 1,
      maxStdoutBytes: 65_536,
    },
    managedExternalWrites: [
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
    ],
  },
} as const;

/**
 * Evidence about the exact frozen tarball. This is test-only metadata: the
 * runtime receipt intentionally keeps only bytes and digests.
 */
export const PI_RUNTIME_ARCHIVE = {
  ...artifacts.archive,
  workAudit: {
    asset: "skills/work-audit/SKILL.md",
    manifestEntry: "./skills/work-audit",
  },
  brandingAssets: [
    "assets/brand/eye-logo.svg",
    "themes/JorgeX.json",
  ],
  qualityAssets: [
    "contract/schemas/quality-capabilities.v1.schema.json",
    "contract/schemas/quality-receipt.v1.schema.json",
    "extensions/quality-capabilities.ts",
  ],
  bundledDependencies: [
    "@gotgenes/pi-permission-system",
    "@juicesharp/rpiv-ask-user-question",
    "pi-subagents",
    "pi-web-access",
    "@narumitw/pi-goal",
    "pi-mcp-adapter",
  ],
  closurePackageManifests: [
    "@napi-rs/keyring",
    "tree-sitter-bash",
  ],
  nativeBindings: [
    "@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
    "@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node",
    "@napi-rs/keyring-linux-arm-gnueabihf/keyring.linux-arm-gnueabihf.node",
    "@napi-rs/keyring-linux-arm64-gnu/keyring.linux-arm64-gnu.node",
    "@napi-rs/keyring-linux-arm64-musl/keyring.linux-arm64-musl.node",
    "@napi-rs/keyring-linux-riscv64-gnu/keyring.linux-riscv64-gnu.node",
    "@napi-rs/keyring-linux-x64-gnu/keyring.linux-x64-gnu.node",
    "@napi-rs/keyring-linux-x64-musl/keyring.linux-x64-musl.node",
    "@napi-rs/keyring-win32-arm64-msvc/keyring.win32-arm64-msvc.node",
    "@napi-rs/keyring-win32-ia32-msvc/keyring.win32-ia32-msvc.node",
    "@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
    "tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node",
    "tree-sitter-bash/prebuilds/darwin-x64/tree-sitter-bash.node",
    "tree-sitter-bash/prebuilds/linux-arm64/tree-sitter-bash.node",
    "tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node",
    "tree-sitter-bash/prebuilds/win32-arm64/tree-sitter-bash.node",
    "tree-sitter-bash/prebuilds/win32-x64/tree-sitter-bash.node",
  ],
} as const;

export type PiRuntimeCandidate = typeof PI_RUNTIME_CANDIDATE;
