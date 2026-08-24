/**
 * Candidate frozen from jorgex-pi main at 02a109d9005f4c948dde2a599c3209a22852fb17.
 * It is deliberately data-only: lifecycle tests must not consume a live checkout.
 */
export const PI_RUNTIME_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.1.0",
    source: "npm:jorgex-pi@0.1.0",
  },
  provenance: {
    commit: "02a109d9005f4c948dde2a599c3209a22852fb17",
  },
  tarball: {
    bytes: 238_390,
    sha256: "4645799fc7d03feaa9db924ccd6835a61ddad638563dd710c122e213556d4c6d",
    sha512: "d29d9c0e02092fe0cea067d9482c82d1cca26751c3c7ad059ac83576f95f5bfd65ace5c792ae1995909056eaa1dbddf19920addfb2e3596e3c0cf6dbd072ab1c",
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

export type PiRuntimeCandidate = typeof PI_RUNTIME_CANDIDATE;
