/**
 * Candidate frozen from the jorgex-pi@0.2.2 npm provenance commit
 * 99631aa3712f51a625d196e949e48e27f55031a2.
 * It is deliberately data-only: lifecycle tests must not consume a live checkout.
 */
export const PI_RUNTIME_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.2.2",
    source: "npm:jorgex-pi@0.2.2",
  },
  provenance: {
    commit: "99631aa3712f51a625d196e949e48e27f55031a2",
  },
  tarball: {
    bytes: 89_101_513,
    sha256: "e1c6b63719995cf7ba2c96c3b753f19d8f2f0be74f2af9bc319576b7383913f4",
    sha512: "7b81dc1eb6030d562c70857dcf739798df94c88bddd240b2752c558fc1d21403faa411aa88e182a01664a17e06e2caeef35f1507eff45c97f4acc521469c45a1",
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
      "tui-branding-v1",
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
  entries: 13_396,
  brandingAssets: [
    "assets/brand/eye-logo.svg",
    "themes/JorgeX.json",
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
