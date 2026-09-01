/**
 * Data-only candidate frozen from the exact published jorgex-pi@0.7.0
 * registry artifact; lifecycle tests must not consume a live checkout.
 * The provenance commit is the release checkout. The workflow trigger is
 * attestation metadata, not this fixture's release-checkout provenance.
 */
export const PI_RUNTIME_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.7.0",
    source: "npm:jorgex-pi@0.7.0",
  },
  provenance: {
    commit: "41b41b7a49617b59c7eb72bdedaa75455b362496",
  },
  tarball: {
    bytes: 89_125_185,
    sha256: "4db392a68187a05a530e6d5ac4c45f834aab5972201edc9ef86da547981109e5",
    sha512: "fb5fdcf15463f3dab36be9b2e6cb55b7397831fe8a172972666a0d6d146ba5e26e70b74e2962dc2702b4ae6ee025094291597c910f967dd924c5a51bd0cc655b",
  },
  pi: {
    testedVersions: ["0.84.2"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
      "foundation-contract-v1",
      "stack-snapshot-v2",
      "runtime-agents-v1",
      "permission-gated-tools-v1",
      "structured-questions-v1",
      "web-access-v1",
      "goal-continuation-v1",
      "mcp-adapter-v1",
      "engram-runtime-tools-v1",
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
    ],
  },
} as const;

/**
 * Test-only context for the previously published Stack/Pi pin. It models the
 * old Stack context for rollback tests and is not a production candidate.
 */
export const PI_RUNTIME_PREVIOUS_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.6.1",
    source: "npm:jorgex-pi@0.6.1",
  },
  provenance: {
    commit: "fa3cc0dbf06398dc39f70fdf0ba99e4a10846203",
  },
  tarball: {
    bytes: 89_120_966,
    sha256: "9a4040ce34dba36aff56f618f957189749219f9560fb796e2b6864bdabf51b93",
    sha512: "0b08a0ae2477c9dd0c2f62cbf15bc212d2ea9ef66c1a366e29c9f772ee73d073ab991d177583bbbaf3db8844053d7f34d8350a4acd9eb270c3887bd05cddd92f",
  },
  pi: {
    testedVersions: ["0.84.2"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
      "foundation-contract-v1",
      "stack-snapshot-v2",
      "runtime-agents-v1",
      "permission-gated-tools-v1",
      "structured-questions-v1",
      "web-access-v1",
      "goal-continuation-v1",
      "mcp-adapter-v1",
      "engram-runtime-tools-v1",
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
    ],
  },
} as const;

/**
 * Evidence about the exact frozen tarball. This is test-only metadata: the
 * runtime receipt intentionally keeps only bytes and digests.
 */
export const PI_RUNTIME_ARCHIVE = {
  entries: 13_402,
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
