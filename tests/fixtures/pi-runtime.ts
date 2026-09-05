/**
 * Data-only candidate frozen from the exact published jorgex-pi@0.8.4
 * registry artifact; lifecycle tests must not consume a live checkout.
 * The provenance commit is the release checkout. The workflow trigger is
 * attestation metadata, not this fixture's release-checkout provenance.
 */
export const PI_RUNTIME_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.8.4",
    source: "npm:jorgex-pi@0.8.4",
  },
  provenance: {
    commit: "2b5cf37d9bfdb0c574e66712000ecc432eca8a69",
  },
  tarball: {
    bytes: 89_133_070,
    sha256: "e30cbc0595bfbaa35b37f97096b77d46749315e3cf6ab13f830fe84432798b10",
    sha512: "39255e7ccf7aad2cbe1069e2dbeb3335dc59f28ad1f0f32b677889e39e167e5fd39b546da9f448c33fad4581f0b4a8f1dda95a2f1b1bce010cc031b188ffc292",
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
 * Test-only context for the previously published Stack/Pi 0.8.3 pin. It models the
 * outgoing Stack context for rollback tests and is not a production candidate.
 */
export const PI_RUNTIME_PREVIOUS_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.8.3",
    source: "npm:jorgex-pi@0.8.3",
  },
  provenance: {
    commit: "0a35c283fe30a9fed87da3cedc00bab97163e68b",
  },
  tarball: {
    bytes: 89_129_618,
    sha256: "4dfe5aed6ad3043b285d4d171656934708df159846634712a88f947ca8334ef4",
    sha512: "36f958cb2edcb2ce22e28c59f32ddcb976b889a37cba3637e89478261ddc05d3a9cf1001d29a6aca30a92d935cb07b50243c4d3eca783ed8e580bf15bb3d07aa",
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
  entries: 13_403,
  parity: {
    source: {
      commit: "5e89b970e72cfac0003b11e054c861bed6d44884",
    },
  },
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
