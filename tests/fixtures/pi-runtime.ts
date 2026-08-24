/**
 * Candidate frozen from jorgex-pi main at 791db79e33efd6661899995b5491e4dff5caa363.
 * It is deliberately data-only: lifecycle tests must not consume a live checkout.
 */
export const PI_RUNTIME_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.1.0",
    source: "npm:jorgex-pi@0.1.0",
  },
  provenance: {
    commit: "791db79e33efd6661899995b5491e4dff5caa363",
  },
  tarball: {
    bytes: 89_066_153,
    sha256: "6243bf8e3a8dbe7be9103d7ca9b03e196c41ac9eef6578f47ea6d03655366feb",
    sha512: "07590abec9e9594b001e28d75eb810259c4088f9f2f6d1d5b9fe456bb2d15a7259ff31ee225d5f1f59b27a1c337a1f1f8e3e57089656bf7bbad966e653110ddd",
  },
  pi: {
    testedVersions: ["0.84.2"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
      "foundation-contract-v1",
      "stack-snapshot-v1",
      "runtime-agents-v1",
      "permission-gated-tools-v1",
      "structured-questions-v1",
      "web-access-v1",
      "goal-continuation-v1",
      "mcp-adapter-v1",
      "engram-runtime-tools-v1",
      "runner-json-v1",
    ],
    runner: {
      bin: "jorgex-pi",
      commands: ["status", "doctor", "models", "sync", "cleanup"],
      schemaVersion: 1,
      maxStdoutBytes: 65_536,
    },
    managedExternalWrites: [] as string[],
  },
} as const;

/**
 * Evidence about the exact frozen tarball. This is test-only metadata: the
 * runtime receipt intentionally keeps only bytes and digests.
 */
export const PI_RUNTIME_ARCHIVE = {
  entries: 13_392,
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
