import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE, PI_RUNTIME_PREVIOUS_CANDIDATE, type PiRuntimeCandidate } from "./fixtures/pi-runtime.js";

type PiPackageReceipt = {
  schemaVersion: 1;
  state: "installing" | "installed";
  candidate: Pick<PiRuntimeCandidate, "package" | "tarball" | "provenance">;
  scope: { kind: "real" | "target-dir"; codingAgentDir: string };
  engram: { binary: string };
};

type PiPackageEnvironment = {
  PI_CODING_AGENT_DIR: string;
  ENGRAM_BIN: string;
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
  TMPDIR?: string;
};

type PiPackageLifecycleInput = {
  candidate: PiRuntimeCandidate;
  observedTarball: { bytes: number; sha256: string; sha512: string };
  pi: {
    executable: string;
    version: string;
    packageRunner: string;
    settingsJson: string;
  };
  engramBin: string | null;
  receiptJson: string | null;
  scope: {
    kind: "real" | "target-dir";
    codingAgentDir: string;
    receiptPath: string;
    environment: PiPackageEnvironment;
  };
};

type PiPackageLifecyclePlan = {
  kind: "install" | "manual-existing" | "ready" | "blocked";
  reason?:
    | "tarball-integrity"
    | "unsupported-pi-version"
    | "settings-corrupt"
    | "source-divergent"
    | "duplicate-package"
    | "receipt-corrupt"
    | "receipt-upgrade-required"
    | "partial-state"
    | "engram-missing";
  invocation?: {
    executable: string;
    args: string[];
    environment: PiPackageEnvironment;
  };
  receipt?: PiPackageReceipt;
  receiptPath: string;
  ownership: {
    receipt: boolean;
    adapters: false;
    manifest: false;
    modelMap: false;
  };
};

type PiPackageSyncResult =
  | { kind: "synced"; actions: unknown[]; upgraded?: boolean; policySha256?: string }
  | { kind: "blocked"; reason: "runner-output" | "runner-unhealthy" };

type PiPackageLifecycleModule = {
  planPiPackageLifecycle(input: PiPackageLifecycleInput): PiPackageLifecyclePlan;
  executePiPackageLifecycle(
    input: {
      operation: "sync";
      plan: { kind: "ready" };
      candidate: PiRuntimeCandidate;
      packageRunner: string;
      environment: PiPackageEnvironment;
      upgradePermissions?: boolean;
    },
    deps: {
      writeReceipt(receipt: PiPackageReceipt): void;
      run(invocation: { executable: string; args: string[]; environment: PiPackageEnvironment }): {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
    },
  ): PiPackageSyncResult;
};

async function lifecycle(): Promise<PiPackageLifecycleModule> {
  const mod = await import("../src/lib/pi-package-lifecycle.js") as Partial<PiPackageLifecycleModule>;
  expect(mod.planPiPackageLifecycle).toBeTypeOf("function");
  expect(mod.executePiPackageLifecycle).toBeTypeOf("function");
  return mod as PiPackageLifecycleModule;
}

const CODING_AGENT_DIR = path.resolve("/tmp/pi-agent");
const PACKAGE_ROOT = path.join(CODING_AGENT_DIR, "packages", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}`);
const MANAGED_PROJECTED_PACKAGE = {
  source: PI_RUNTIME_CANDIDATE.package.source,
  skills: [],
  prompts: [],
};
const EXACT_SETTINGS = JSON.stringify({ packages: [MANAGED_PROJECTED_PACKAGE] });

const PERMISSIONS_POLICY_CAPABILITY = "permissions-policy-v1";
type ExternalWrite = {
  readonly owner: "jorgex-pi";
  readonly root: "PI_CODING_AGENT_DIR";
  readonly relativePath: string;
  readonly semantics: string;
};

const HISTORICAL_CAPABILITIES = [
  "foundation-contract-v1",
  "runner-json-v1",
  "managed-primary-model-v1",
] as const;

const HISTORICAL_WRITES = [
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "settings.json",
    semantics: "merge missing Pi defaults and preserve user changes",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "models.json",
    semantics: "merge the managed model override and preserve user changes",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/sol-lifecycle.v1.json",
    semantics: "record field, container, and file ownership",
  },
] as const;

const PERMISSIONS_WRITES = [
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "extensions/pi-permission-system/config.json",
    semantics: "merge the permission policy and preserve user changes",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/permissions-lifecycle.v1.json",
    semantics: "record permission policy field ownership",
  },
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/permissions-backups",
    semantics: "store permission policy backups",
  },
] as const;

const EXPERIENCE_DEFAULTS_CAPABILITY = "experience-defaults-v1";
const EXPERIENCE_WRITES = [
  {
    owner: "jorgex-pi",
    root: "PI_CODING_AGENT_DIR",
    relativePath: "jorgex-pi/experience-lifecycle.v1.json",
    semantics: "record experience defaults field ownership",
  },
] as const;

function candidateWithPermissions(
  managedExternalWrites: readonly ExternalWrite[],
  capabilities: readonly string[] = [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY],
): PiRuntimeCandidate {
  const baseline = historicalCandidate();
  return {
    ...baseline,
    contract: {
      ...baseline.contract,
      capabilities,
      managedExternalWrites,
    },
  } as unknown as PiRuntimeCandidate;
}

function historicalCandidate(): PiRuntimeCandidate {
  return {
    ...PI_RUNTIME_CANDIDATE,
    contract: {
      ...PI_RUNTIME_CANDIDATE.contract,
      capabilities: HISTORICAL_CAPABILITIES,
      managedExternalWrites: HISTORICAL_WRITES,
    },
  } as unknown as PiRuntimeCandidate;
}

function healthyInput(overrides: Partial<PiPackageLifecycleInput> = {}): PiPackageLifecycleInput {
  return {
    candidate: PI_RUNTIME_CANDIDATE,
    observedTarball: PI_RUNTIME_CANDIDATE.tarball,
    pi: {
      executable: "/opt/pi/bin/pi",
      version: "0.84.2",
      packageRunner: `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`,
      settingsJson: JSON.stringify({ packages: [] }),
    },
    engramBin: "/opt/engram/bin/engram",
    receiptJson: null,
    scope: {
      kind: "real",
      codingAgentDir: CODING_AGENT_DIR,
      receiptPath: "/home/test/.jorgex-stack/pi-receipt.json",
      environment: {
        PI_CODING_AGENT_DIR: CODING_AGENT_DIR,
        ENGRAM_BIN: "/opt/engram/bin/engram",
      },
    },
    ...overrides,
  };
}

function installedReceipt(): PiPackageReceipt {
  return {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: PI_RUNTIME_CANDIDATE.package,
      tarball: PI_RUNTIME_CANDIDATE.tarball,
      provenance: PI_RUNTIME_CANDIDATE.provenance,
    },
    scope: { kind: "real", codingAgentDir: CODING_AGENT_DIR },
    engram: { binary: "/opt/engram/bin/engram" },
  };
}

function syncRunnerJson(result: unknown): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "sync",
    ok: true,
    package: {
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
      root: PACKAGE_ROOT,
    },
    result,
  })}\n`;
}

const PERMISSIONS_UPGRADE_CAPABILITY = "permissions-upgrade-v1";
const UPGRADE_POLICY_SHA256 = "0123456789abcdef".repeat(4);

function upgradeCapableCandidate(): PiRuntimeCandidate {
  const capabilities = PI_RUNTIME_CANDIDATE.contract.capabilities.includes(PERMISSIONS_UPGRADE_CAPABILITY)
    ? [...PI_RUNTIME_CANDIDATE.contract.capabilities]
    : [...PI_RUNTIME_CANDIDATE.contract.capabilities, PERMISSIONS_UPGRADE_CAPABILITY];
  const commands = PI_RUNTIME_CANDIDATE.contract.runner.commands.includes("upgrade")
    ? [...PI_RUNTIME_CANDIDATE.contract.runner.commands]
    : [...PI_RUNTIME_CANDIDATE.contract.runner.commands, "upgrade"];
  return {
    ...PI_RUNTIME_CANDIDATE,
    contract: {
      ...PI_RUNTIME_CANDIDATE.contract,
      capabilities,
      runner: {
        ...PI_RUNTIME_CANDIDATE.contract.runner,
        commands,
      },
    },
  } as unknown as PiRuntimeCandidate;
}

function upgradeIncapableCandidate(): PiRuntimeCandidate {
  return {
    ...PI_RUNTIME_CANDIDATE,
    contract: {
      ...PI_RUNTIME_CANDIDATE.contract,
      capabilities: PI_RUNTIME_CANDIDATE.contract.capabilities.filter(
        (capability) => capability !== PERMISSIONS_UPGRADE_CAPABILITY,
      ),
      runner: {
        ...PI_RUNTIME_CANDIDATE.contract.runner,
        commands: PI_RUNTIME_CANDIDATE.contract.runner.commands.filter((command) => command !== "upgrade"),
      },
    },
  } as unknown as PiRuntimeCandidate;
}

function upgradeRunnerJson(result: unknown): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "upgrade",
    ok: true,
    package: {
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
      root: PACKAGE_ROOT,
    },
    result,
  })}\n`;
}

function configLockedRunnerJson(errorCode = "CONFIG_LOCKED"): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "upgrade",
    ok: false,
    package: {
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
      root: PACKAGE_ROOT,
    },
    result: null,
    error: { code: errorCode, message: "upgrade already in progress" },
  })}\n`;
}

describe("Pi package-managed lifecycle", () => {
  it("uses only the frozen PR06 candidate and journals a package-owned install", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const plan = planPiPackageLifecycle(healthyInput());

    expect(plan).toEqual({
      kind: "install",
      receiptPath: "/home/test/.jorgex-stack/pi-receipt.json",
      invocation: {
        executable: "/opt/pi/bin/pi",
        args: ["install", PI_RUNTIME_CANDIDATE.package.source, "--no-approve"],
        environment: {
          PI_CODING_AGENT_DIR: CODING_AGENT_DIR,
          ENGRAM_BIN: "/opt/engram/bin/engram",
        },
      },
      receipt: {
        schemaVersion: 1,
        state: "installing",
        candidate: {
          package: PI_RUNTIME_CANDIDATE.package,
          tarball: PI_RUNTIME_CANDIDATE.tarball,
          provenance: PI_RUNTIME_CANDIDATE.provenance,
        },
        scope: { kind: "real", codingAgentDir: CODING_AGENT_DIR },
        engram: { binary: "/opt/engram/bin/engram" },
      },
      ownership: {
        receipt: true,
        adapters: false,
        manifest: false,
        modelMap: false,
      },
    });
    expect(plan.invocation?.environment).not.toHaveProperty("PI_PACKAGE_DIR");
    expect(plan.invocation?.environment.ENGRAM_BIN).toMatch(/^\//);
  });

  it("keeps the previous candidate valid", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const previous = planPiPackageLifecycle(healthyInput({
      candidate: PI_RUNTIME_PREVIOUS_CANDIDATE as unknown as PiRuntimeCandidate,
      observedTarball: PI_RUNTIME_PREVIOUS_CANDIDATE.tarball,
      pi: {
        ...healthyInput().pi,
        packageRunner: `${CODING_AGENT_DIR}/packages/jorgex-pi-${PI_RUNTIME_PREVIOUS_CANDIDATE.package.version}/bin/jorgex-pi.mjs`,
      },
    }));
    expect(previous).toMatchObject({
      kind: "install",
      ownership: { receipt: true, adapters: false, manifest: false, modelMap: false },
    });
  });

  it("accepts exactly six managed external writes with permissions-policy-v1", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const sixWriteCandidate = candidateWithPermissions([
      ...HISTORICAL_WRITES,
      ...PERMISSIONS_WRITES,
    ]);
    const expanded = planPiPackageLifecycle(healthyInput({ candidate: sixWriteCandidate }));
    expect(expanded).toMatchObject({
      kind: "install",
      ownership: { receipt: true, adapters: false, manifest: false, modelMap: false },
    });
  });

  it.each([
    [
      "six writes without the capability",
      candidateWithPermissions([
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES,
      ], HISTORICAL_CAPABILITIES),
    ],
    [
      "three writes with the capability",
      candidateWithPermissions(HISTORICAL_WRITES),
    ],
    [
      "a missing permission write",
      candidateWithPermissions([
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES.slice(0, 2),
      ]),
    ],
    [
      "a duplicate permission write",
      candidateWithPermissions([
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES.slice(0, 2),
        PERMISSIONS_WRITES[0],
      ]),
    ],
    [
      "an extra permission write",
      candidateWithPermissions([
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES.slice(0, 2),
        {
          owner: "jorgex-pi",
          root: "PI_CODING_AGENT_DIR",
          relativePath: "jorgex-pi/unexpected.json",
          semantics: "unexpected write",
        },
      ]),
    ],
    [
      "an escaping permission write",
      candidateWithPermissions([
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES.slice(0, 2),
        {
          owner: "jorgex-pi",
          root: "PI_CODING_AGENT_DIR",
          relativePath: "../permissions.json",
          semantics: "escape",
        },
      ]),
    ],
  ] as const)("rejects %s from the managed external-write allowlist", async (_name, candidate) => {
    const { planPiPackageLifecycle } = await lifecycle();
    const plan = planPiPackageLifecycle(healthyInput({ candidate }));

    expect(plan).toMatchObject({ kind: "blocked", reason: "tarball-integrity" });
  });

  it("accepts exactly seven managed external writes with experience-defaults-v1 and permissions-policy-v1", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const candidate = candidateWithPermissions(
      [...HISTORICAL_WRITES, ...PERMISSIONS_WRITES, ...EXPERIENCE_WRITES],
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY, EXPERIENCE_DEFAULTS_CAPABILITY],
    );
    const plan = planPiPackageLifecycle(healthyInput({ candidate }));

    expect(plan).toMatchObject({
      kind: "install",
      ownership: { receipt: true, adapters: false, manifest: false, modelMap: false },
    });
  });

  it.each([
    [
      "seven writes without experience-defaults-v1",
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY],
      [...HISTORICAL_WRITES, ...PERMISSIONS_WRITES, ...EXPERIENCE_WRITES],
    ],
    [
      "experience-defaults-v1 without permissions-policy-v1",
      [...HISTORICAL_CAPABILITIES, EXPERIENCE_DEFAULTS_CAPABILITY],
      [...HISTORICAL_WRITES, ...EXPERIENCE_WRITES],
    ],
    [
      "six writes with experience-defaults-v1",
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY, EXPERIENCE_DEFAULTS_CAPABILITY],
      [...HISTORICAL_WRITES, ...PERMISSIONS_WRITES],
    ],
    [
      "an extra experience write",
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY, EXPERIENCE_DEFAULTS_CAPABILITY],
      [
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES,
        ...EXPERIENCE_WRITES,
        {
          owner: "jorgex-pi",
          root: "PI_CODING_AGENT_DIR",
          relativePath: "jorgex-pi/unexpected.json",
          semantics: "unexpected write",
        },
      ],
    ],
    [
      "a duplicate experience write",
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY, EXPERIENCE_DEFAULTS_CAPABILITY],
      [...HISTORICAL_WRITES, ...PERMISSIONS_WRITES, ...EXPERIENCE_WRITES, EXPERIENCE_WRITES[0]],
    ],
    [
      "a missing permission write with experience",
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY, EXPERIENCE_DEFAULTS_CAPABILITY],
      [...HISTORICAL_WRITES, ...PERMISSIONS_WRITES.slice(0, 2), ...EXPERIENCE_WRITES],
    ],
    [
      "an escaping experience write",
      [...HISTORICAL_CAPABILITIES, PERMISSIONS_POLICY_CAPABILITY, EXPERIENCE_DEFAULTS_CAPABILITY],
      [
        ...HISTORICAL_WRITES,
        ...PERMISSIONS_WRITES,
        {
          owner: "jorgex-pi",
          root: "PI_CODING_AGENT_DIR",
          relativePath: "../experience-lifecycle.v1.json",
          semantics: "escape",
        },
      ],
    ],
  ] as const)("rejects %s from the experience allowlist", async (_name, capabilities, writes) => {
    const { planPiPackageLifecycle } = await lifecycle();
    const plan = planPiPackageLifecycle(healthyInput({
      candidate: candidateWithPermissions(writes, capabilities),
    }));

    expect(plan).toMatchObject({ kind: "blocked", reason: "tarball-integrity" });
  });

  it("preserves an exact manual install, but blocks corrupt, divergent, duplicate, partial, incompatible, or tampered state", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const cases = [
      {
        name: "manual exact install without a Stack receipt",
        input: healthyInput({ pi: { ...healthyInput().pi, settingsJson: EXACT_SETTINGS } }),
        expected: { kind: "manual-existing", ownership: { receipt: false, adapters: false, manifest: false, modelMap: false } },
      },
      {
        name: "corrupt Pi settings",
        input: healthyInput({ pi: { ...healthyInput().pi, settingsJson: "{broken" } }),
        expected: { kind: "blocked", reason: "settings-corrupt" },
      },
      {
        name: "a divergent source",
        input: healthyInput({ pi: { ...healthyInput().pi, settingsJson: JSON.stringify({ packages: ["npm:jorgex-pi@0.2.3"] }) } }),
        expected: { kind: "blocked", reason: "source-divergent" },
      },
      {
        name: "a duplicate exact source",
        input: healthyInput({ pi: { ...healthyInput().pi, settingsJson: JSON.stringify({ packages: [PI_RUNTIME_CANDIDATE.package.source, PI_RUNTIME_CANDIDATE.package.source] }) } }),
        expected: { kind: "blocked", reason: "duplicate-package" },
      },
      {
        name: "a corrupt receipt",
        input: healthyInput({ receiptJson: "{broken" }),
        expected: { kind: "blocked", reason: "receipt-corrupt" },
      },
      {
        name: "an interrupted install receipt",
        input: healthyInput({ receiptJson: JSON.stringify({ ...installedReceipt(), state: "installing" }) }),
        expected: { kind: "blocked", reason: "partial-state" },
      },
      {
        name: "a Pi version outside the frozen compatibility range",
        input: healthyInput({ pi: { ...healthyInput().pi, version: "0.84.3" } }),
        expected: { kind: "blocked", reason: "unsupported-pi-version" },
      },
      {
        name: "a tampered candidate tarball",
        input: healthyInput({ observedTarball: { ...PI_RUNTIME_CANDIDATE.tarball, sha256: "0".repeat(64) } }),
        expected: { kind: "blocked", reason: "tarball-integrity" },
      },
      {
        name: "an external write outside the Pi-owned allowlist",
        input: healthyInput({
          candidate: {
            ...PI_RUNTIME_CANDIDATE,
            contract: {
              ...PI_RUNTIME_CANDIDATE.contract,
              managedExternalWrites: [
                ...PI_RUNTIME_CANDIDATE.contract.managedExternalWrites.slice(0, 2),
                {
                  owner: "jorgex-pi",
                  root: "PI_CODING_AGENT_DIR",
                  relativePath: "../settings.json",
                  semantics: "escape",
                },
              ],
            },
          } as unknown as PiRuntimeCandidate,
        }),
        expected: { kind: "blocked", reason: "tarball-integrity" },
      },
    ] as const;

    for (const testCase of cases) {
      expect(planPiPackageLifecycle(testCase.input), testCase.name).toMatchObject(testCase.expected);
    }
  });

  it("keeps target-dir process state and receipts isolated, then has no package mutation on an already-owned exact install", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const targetEnvironment: PiPackageEnvironment = {
      HOME: "/tmp/jorgex-target/home",
      XDG_CONFIG_HOME: "/tmp/jorgex-target/config",
      XDG_CACHE_HOME: "/tmp/jorgex-target/cache",
      TMPDIR: "/tmp/jorgex-target/tmp",
      PI_CODING_AGENT_DIR: "/tmp/jorgex-target/pi-agent",
      ENGRAM_BIN: "/tmp/jorgex-target/bin/engram",
    };
    const isolated = planPiPackageLifecycle(healthyInput({
      scope: {
        kind: "target-dir",
        codingAgentDir: "/tmp/jorgex-target/pi-agent",
        receiptPath: "/tmp/jorgex-target/state/pi-receipt.json",
        environment: targetEnvironment,
      },
      engramBin: "/tmp/jorgex-target/bin/engram",
    }));

    expect(isolated).toMatchObject({
      kind: "install",
      receiptPath: "/tmp/jorgex-target/state/pi-receipt.json",
      invocation: { environment: targetEnvironment },
    });
    expect(isolated.receiptPath).not.toContain("/home/test/.jorgex-stack");

    const idempotent = planPiPackageLifecycle(healthyInput({
      pi: { ...healthyInput().pi, settingsJson: EXACT_SETTINGS },
      receiptJson: JSON.stringify(installedReceipt()),
    }));
    expect(idempotent).toMatchObject({
      kind: "ready",
      ownership: { receipt: true, adapters: false, manifest: false, modelMap: false },
    });
    expect(idempotent.invocation).toBeUndefined();
    expect(idempotent.receipt).toBeUndefined();
  });

  it("records the exact verified Engram binary and accepts that receipt idempotently with the filtered package entry", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const engram = { binary: "/opt/engram/bin/engram" };
    const filteredSettings = EXACT_SETTINGS;
    const initial = planPiPackageLifecycle(healthyInput());

    expect(initial.receipt).toMatchObject({ engram });

    const resumed = planPiPackageLifecycle(healthyInput({
      pi: { ...healthyInput().pi, settingsJson: filteredSettings },
      receiptJson: JSON.stringify({ ...initial.receipt, state: "installed", engram }),
    }));
    expect(resumed).toMatchObject({ kind: "ready", ownership: { receipt: true } });
  });

  it.each([
    ["complete projected filters", [MANAGED_PROJECTED_PACKAGE], { kind: "ready" }],
    ["canonical string after projection", [PI_RUNTIME_CANDIDATE.package.source], { kind: "blocked", reason: "source-divergent" }],
    ["partial filters without prompts", [{ source: PI_RUNTIME_CANDIDATE.package.source, skills: [] }], { kind: "blocked", reason: "source-divergent" }],
    ["partial filters without skills", [{ source: PI_RUNTIME_CANDIDATE.package.source, prompts: [] }], { kind: "blocked", reason: "source-divergent" }],
    ["non-empty packaged skills", [{ source: PI_RUNTIME_CANDIDATE.package.source, skills: ["tdd"], prompts: [] }], { kind: "blocked", reason: "source-divergent" }],
    ["duplicate projected filters", [MANAGED_PROJECTED_PACKAGE, MANAGED_PROJECTED_PACKAGE], { kind: "blocked", reason: "duplicate-package" }],
  ])("treats receipt-owned %s as the only ready registration for sync", async (_name, packages, expected) => {
    const { planPiPackageLifecycle } = await lifecycle();
    const plan = planPiPackageLifecycle(healthyInput({
      pi: { ...healthyInput().pi, settingsJson: JSON.stringify({ packages }) },
      receiptJson: JSON.stringify(installedReceipt()),
    }));

    expect(plan).toMatchObject(expected);
  });

  it.each([
    ["changed output with an actions array", true, [{ kind: "write", target: "/tmp/pi-agent/AGENTS.md" }], "synced"],
    ["unchanged output with a non-array action list", false, { kind: "write" }, "blocked"],
  ])("validates sync runner JSON for %s", async (_name, changed, actions, expectedKind) => {
    const { executePiPackageLifecycle } = await lifecycle();
    const result = executePiPackageLifecycle({
      operation: "sync",
      plan: { kind: "ready" },
      candidate: PI_RUNTIME_CANDIDATE,
      packageRunner: `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`,
      environment: healthyInput().scope.environment,
    }, {
      writeReceipt: () => {
        throw new Error("sync must not rewrite the receipt");
      },
      run: () => ({
        exitCode: 0,
        stdout: syncRunnerJson({ changed, actions }),
        stderr: "",
      }),
    });

    expect(result).toMatchObject({ kind: expectedKind });
  });

  it("blocks a legacy receipt without an Engram binding instead of adopting ownership", async () => {
    const { planPiPackageLifecycle } = await lifecycle();
    const { engram: _engram, ...legacyReceipt } = installedReceipt();
    const plan = planPiPackageLifecycle(healthyInput({
      pi: { ...healthyInput().pi, settingsJson: EXACT_SETTINGS },
      receiptJson: JSON.stringify(legacyReceipt),
    }));

    expect(plan).toMatchObject({
      kind: "blocked",
      reason: "receipt-upgrade-required",
      ownership: { receipt: true },
    });
  });

  it("orders upgrade --json only with the flag and the upgrade capability, otherwise stays seed-only", async () => {
    const { executePiPackageLifecycle } = await lifecycle();
    const syncActions = [{ kind: "write", target: "/tmp/pi-agent/AGENTS.md" }];
    const upgradeActions = [{ kind: "upgraded", target: "extensions/pi-permission-system/config.json" }];
    const packageRunner = `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`;
    const environment = healthyInput().scope.environment;

    const runWith = (
      candidate: PiRuntimeCandidate,
      upgradePermissions: boolean | undefined,
      upgradeResult: unknown = { changed: true, actions: upgradeActions, policySha256: UPGRADE_POLICY_SHA256 },
    ) => {
      const calls: string[] = [];
      const result = executePiPackageLifecycle({
        operation: "sync",
        plan: { kind: "ready" },
        candidate,
        packageRunner,
        environment,
        ...(upgradePermissions === undefined ? {} : { upgradePermissions }),
      }, {
        writeReceipt: () => {
          throw new Error("sync must not rewrite the receipt");
        },
        run: (invocation) => {
          calls.push(invocation.args[0]!);
          if (invocation.args[0] === "sync") {
            expect(invocation).toEqual({ executable: packageRunner, args: ["sync", "--json"], environment });
            return { exitCode: 0, stdout: syncRunnerJson({ changed: false, actions: syncActions }), stderr: "" };
          }
          expect(invocation).toEqual({ executable: packageRunner, args: ["upgrade", "--json"], environment });
          return { exitCode: 0, stdout: upgradeRunnerJson(upgradeResult), stderr: "" };
        },
      });
      return { calls, result };
    };

    const capable = upgradeCapableCandidate();

    const optedIn = runWith(capable, true);
    expect(optedIn.calls).toEqual(["sync", "upgrade"]);
    expect(optedIn.result).toEqual({
      kind: "synced",
      actions: [...syncActions, ...upgradeActions],
      upgraded: true,
      policySha256: UPGRADE_POLICY_SHA256,
    });

    const withoutFlag = runWith(capable, undefined);
    expect(withoutFlag.calls).toEqual(["sync"]);
    expect(withoutFlag.result).toEqual({ kind: "synced", actions: syncActions });
    expect(withoutFlag.result).not.toHaveProperty("upgraded");
    expect(withoutFlag.result).not.toHaveProperty("policySha256");

    const incapableWithFlag = runWith(upgradeIncapableCandidate(), true);
    expect(incapableWithFlag.calls).toEqual(["sync"]);
    expect(incapableWithFlag.result).toEqual({ kind: "synced", actions: syncActions });
    expect(incapableWithFlag.result).not.toHaveProperty("upgraded");
  });

  it.each([
    ["changed with a valid 64-hex hash merges actions", { changed: true, actions: [{ kind: "upgraded" }], policySha256: UPGRADE_POLICY_SHA256 }, { kind: "synced", upgraded: true }],
    ["unchanged without a hash merges actions", { changed: false, actions: [{ kind: "noop" }] }, { kind: "synced", upgraded: false }],
    ["changed without a hash is rejected", { changed: true, actions: [] }, { kind: "blocked", reason: "runner-output" }],
    ["changed with a non-hex hash is rejected", { changed: true, actions: [], policySha256: "ZZZ" }, { kind: "blocked", reason: "runner-output" }],
    ["changed with a short hash is rejected", { changed: true, actions: [], policySha256: "a".repeat(63) }, { kind: "blocked", reason: "runner-output" }],
    ["a policy dump is rejected without exposing contents", { changed: true, actions: [], policySha256: UPGRADE_POLICY_SHA256, policy: "{\"permission\":{}}" }, { kind: "blocked", reason: "runner-output" }],
    ["a config dump is rejected without exposing contents", { changed: false, actions: [], config: "{\"permission\":{}}" }, { kind: "blocked", reason: "runner-output" }],
    ["a non-boolean changed is rejected", { changed: "yes", actions: [] }, { kind: "blocked", reason: "runner-unhealthy" }],
    ["a non-array actions list is rejected", { changed: false, actions: { kind: "write" } }, { kind: "blocked", reason: "runner-unhealthy" }],
  ] as const)("validates the upgrade envelope for %s", async (_name, upgradeResult, expected) => {
    const { executePiPackageLifecycle } = await lifecycle();
    const syncActions = [{ kind: "write", target: "/tmp/pi-agent/AGENTS.md" }];
    const packageRunner = `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`;
    const environment = healthyInput().scope.environment;

    const result = executePiPackageLifecycle({
      operation: "sync",
      plan: { kind: "ready" },
      candidate: upgradeCapableCandidate(),
      packageRunner,
      environment,
      upgradePermissions: true,
    }, {
      writeReceipt: () => {
        throw new Error("sync must not rewrite the receipt");
      },
      run: (invocation) => {
        if (invocation.args[0] === "sync") {
          return { exitCode: 0, stdout: syncRunnerJson({ changed: false, actions: syncActions }), stderr: "" };
        }
        return { exitCode: 0, stdout: upgradeRunnerJson(upgradeResult), stderr: "" };
      },
    });

    expect(result).toMatchObject(expected);
    if (expected.kind === "synced" && "upgraded" in expected && expected.upgraded === true) {
      expect(result).toMatchObject({ policySha256: UPGRADE_POLICY_SHA256 });
    }
    if (expected.kind === "blocked") {
      expect(JSON.stringify(result)).not.toContain("{\"permission\"");
    }
  });

  it("retries the upgrade order on CONFIG_LOCKED then merges on success", async () => {
    const { executePiPackageLifecycle } = await lifecycle();
    const syncActions = [{ kind: "write", target: "/tmp/pi-agent/AGENTS.md" }];
    const upgradeActions = [{ kind: "upgraded", target: "extensions/pi-permission-system/config.json" }];
    const packageRunner = `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`;
    const environment = healthyInput().scope.environment;
    const calls: string[] = [];
    let upgrades = 0;

    const result = executePiPackageLifecycle({
      operation: "sync",
      plan: { kind: "ready" },
      candidate: upgradeCapableCandidate(),
      packageRunner,
      environment,
      upgradePermissions: true,
    }, {
      writeReceipt: () => {
        throw new Error("sync must not rewrite the receipt");
      },
      run: (invocation) => {
        calls.push(invocation.args[0]!);
        if (invocation.args[0] === "sync") {
          return { exitCode: 0, stdout: syncRunnerJson({ changed: false, actions: syncActions }), stderr: "" };
        }
        upgrades += 1;
        if (upgrades === 1) {
          return { exitCode: 1, stdout: configLockedRunnerJson(), stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: upgradeRunnerJson({ changed: true, actions: upgradeActions, policySha256: UPGRADE_POLICY_SHA256 }),
          stderr: "",
        };
      },
    });

    expect(calls).toEqual(["sync", "upgrade", "upgrade"]);
    expect(result).toEqual({
      kind: "synced",
      actions: [...syncActions, ...upgradeActions],
      upgraded: true,
      policySha256: UPGRADE_POLICY_SHA256,
    });
  });

  it("fails visibly after exhausting CONFIG_LOCKED retries", async () => {
    const { executePiPackageLifecycle } = await lifecycle();
    const syncActions = [{ kind: "write", target: "/tmp/pi-agent/AGENTS.md" }];
    const packageRunner = `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`;
    const environment = healthyInput().scope.environment;
    const calls: string[] = [];

    const result = executePiPackageLifecycle({
      operation: "sync",
      plan: { kind: "ready" },
      candidate: upgradeCapableCandidate(),
      packageRunner,
      environment,
      upgradePermissions: true,
    }, {
      writeReceipt: () => {
        throw new Error("sync must not rewrite the receipt");
      },
      run: (invocation) => {
        calls.push(invocation.args[0]!);
        if (invocation.args[0] === "sync") {
          return { exitCode: 0, stdout: syncRunnerJson({ changed: false, actions: syncActions }), stderr: "" };
        }
        return { exitCode: 1, stdout: configLockedRunnerJson(), stderr: "" };
      },
    });

    expect(calls).toEqual(["sync", "upgrade", "upgrade", "upgrade"]);
    expect(result).toEqual({ kind: "blocked", reason: "runner-unhealthy" });
  });

  it.each([
    ["a non-lock exit 1 without the signal", { exitCode: 1, stdout: "", stderr: "boom" }],
    ["a lock signal on a different exit code", { exitCode: 2, stdout: configLockedRunnerJson(), stderr: "" }],
    ["an unrelated error code on exit 1", { exitCode: 1, stdout: configLockedRunnerJson("UPGRADE_FAILED"), stderr: "" }],
    ["plain-text lock text without the JSON envelope", { exitCode: 1, stdout: "CONFIG_LOCKED: upgrade already in progress\n", stderr: "" }],
  ])("stays fail-fast on %s: no upgrade retry", async (_name, upgradeFailure) => {
    const { executePiPackageLifecycle } = await lifecycle();
    const syncActions = [{ kind: "write", target: "/tmp/pi-agent/AGENTS.md" }];
    const packageRunner = `${PACKAGE_ROOT}/bin/jorgex-pi.mjs`;
    const environment = healthyInput().scope.environment;
    const calls: string[] = [];

    const result = executePiPackageLifecycle({
      operation: "sync",
      plan: { kind: "ready" },
      candidate: upgradeCapableCandidate(),
      packageRunner,
      environment,
      upgradePermissions: true,
    }, {
      writeReceipt: () => {
        throw new Error("sync must not rewrite the receipt");
      },
      run: (invocation) => {
        calls.push(invocation.args[0]!);
        if (invocation.args[0] === "sync") {
          return { exitCode: 0, stdout: syncRunnerJson({ changed: false, actions: syncActions }), stderr: "" };
        }
        return upgradeFailure;
      },
    });

      expect(calls).toEqual(["sync", "upgrade"]);
      expect(result).toEqual({ kind: "blocked", reason: "runner-unhealthy" });
  });
});

// ---------------------------------------------------------------------------
// T41-RED: verificación singleton del post-estado `engram setup pi`.
// Contrato: tras el setup, exactamente una entrada global gentle-engram +
// exactamente una global pi-mcp-adapter + un mcpServers.engram oficial válido;
// versiones provider-managed (se observan, no se fijan). Ausente/duplicado/
// inválido/ilegible/parcial falla cerrado, preserva bytes previos y no activa
// Pi (sin invocación al package). Temporales aislados; cero HOME real/red.
// El verificador Pi sigue el patrón de los adapters (verifyOfficialSetup).
// ---------------------------------------------------------------------------

const T41_PI_LIFECYCLE_ROOTS: string[] = [];

afterEach(() => {
  for (const root of T41_PI_LIFECYCLE_ROOTS.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function t41PiPostState(kind: "valid" | "missing-adapter" | "duplicate-engram" | "invalid-mcp" | "partial"): {
  root: string;
  piAgentDir: string;
  engramBin: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t41-pi-post-"));
  T41_PI_LIFECYCLE_ROOTS.push(root);
  const piAgentDir = path.join(root, "pi-agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(root, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  // Canónico upstream main + Pi 0.8.28: packages como sources
  // `npm:gentle-engram` / `npm:pi-mcp-adapter` (provider-managed, se observan
  // sin pin) y mcp.json con mcpServers.engram directo exacto (command absoluto,
  // args ["mcp","--tools=agent"], lifecycle "lazy", directTools false).
  const packages =
    kind === "valid"
      ? ["npm:gentle-engram@0.1.99-observada", "npm:pi-mcp-adapter@2.99.0-observada"]
      : kind === "missing-adapter"
        ? ["npm:gentle-engram@0.1.99-observada"]
        : kind === "duplicate-engram"
          ? [
            "npm:gentle-engram@0.1.99-observada",
            "npm:gentle-engram@0.1.100-observada",
            "npm:pi-mcp-adapter@2.99.0-observada",
          ]
          : kind === "invalid-mcp"
            ? ["npm:gentle-engram@0.1.99-observada", "npm:pi-mcp-adapter@2.99.0-observada"]
            : ["npm:gentle-engram@0.1.99-observada"];
  fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify({ packages }));
  const mcp =
    kind === "invalid-mcp"
      ? { mcpServers: { engram: { command: "foreign-server" } } }
      : kind === "valid"
        ? { mcpServers: { engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }
        : { mcpServers: {} };
  fs.writeFileSync(path.join(piAgentDir, "mcp.json"), JSON.stringify(mcp));
  if (kind === "partial") {
    // Parcial ilegible: directorio donde se espera el MCP exacto (mcp.json).
    fs.rmSync(path.join(piAgentDir, "mcp.json"), { force: true });
    fs.mkdirSync(path.join(piAgentDir, "mcp.json"));
  }
  return { root, piAgentDir, engramBin };
}

describe("[T41-RED] verify Pi singleton + MCP exacto antes del package", () => {
  it("acepta el post-estado válido con versiones rolling observadas (sin pin)", async () => {
    const { piAgentDir, engramBin } = t41PiPostState("valid");
    const pi = (await import("../src/adapters/pi.js")) as any;
    const verify = pi.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Pi singleton + MCP exacto (T41)").toBe("function");

    const report = await verify({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["packages", "mcp"]));
    expect(report.duplicates ?? false).toBe(false);
    // Versiones rolling aceptadas: el reporte las observa sin exigir pin.
    expect(JSON.stringify(report)).not.toMatch(/sin pin/i);
  });

  it.each([
    ["missing-adapter", /pi-mcp-adapter|singleton|missing/i],
    ["duplicate-engram", /duplicate|singleton/i],
    ["invalid-mcp", /mcp|engram|invalid/i],
    ["partial", /partial|unreadable|invalid|mcp|singleton/i],
  ] as const)("falla cerrado ante post-estado %s sin activar Pi", async (kind, reasonPattern) => {
    const { piAgentDir, engramBin } = t41PiPostState(kind);
    const before = kind === "partial"
      ? null
      : fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8");
    const pi = (await import("../src/adapters/pi.js")) as any;
    const verify = pi.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Pi fail-closed (T41)").toBe("function");

    const report = await verify({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(reasonPattern);
    // Preserva bytes previos: el verificador es solo lectura.
    if (before !== null) {
      expect(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")).toBe(before);
    }
  });
});

// ---------------------------------------------------------------------------
// T42-RED: verificación Pi acepta SOLO la forma directa canónica de upstream
// main. Contrato: mcpServers.engram debe ser exactamente
// { command === engramBin, args === ["mcp","--tools=agent"],
//   lifecycle === "lazy", directTools === false }.
// Cualquier wrapper arbitrario/Node/shell se rechaza aunque sus args
// contengan tokens confiables (engramBin, "mcp", "--tools=agent"), y la forma
// directa sin lifecycle lazy o sin directTools false explícito también se
// rechaza. Solo lectura; temporales aislados.
// ---------------------------------------------------------------------------

function t42PiDir(): { piAgentDir: string; engramBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t42-pi-mcp-"));
  T41_PI_LIFECYCLE_ROOTS.push(root);
  const piAgentDir = path.join(root, "pi-agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(root, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:gentle-engram@0.1.99-observada", "npm:pi-mcp-adapter@2.99.0-observada"] }),
  );
  return { piAgentDir, engramBin };
}

describe("[T42-RED] verify Pi solo acepta MCP directo canónico upstream", () => {
  it("control: acepta la forma directa canónica con lifecycle lazy + directTools false", async () => {
    const { piAgentDir, engramBin } = t42PiDir();
    fs.writeFileSync(
      path.join(piAgentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
        },
      }),
    );
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi canónico (T42)").toBe("function");

    const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["packages", "mcp"]));
  });

  it.each([["node"], ["arbitrary"], ["shell"]] as const)(
    "rechaza wrapper %s aunque sus args contengan tokens confiables",
    async (kind) => {
      const { piAgentDir, engramBin } = t42PiDir();
      const before = fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8");
      const wrapper =
        kind === "node"
          ? { command: "node", args: ["/opt/pi/wrapper.js", engramBin, "mcp", "--tools=agent"], lifecycle: "lazy", directTools: false }
          : kind === "arbitrary"
            ? { command: "/tmp/pi-wrapper", args: [engramBin, "mcp", "--tools=agent"], lifecycle: "lazy", directTools: false }
            : { command: "/bin/sh", args: ["-c", engramBin, "mcp", "--tools=agent"], lifecycle: "lazy", directTools: false };
      fs.writeFileSync(path.join(piAgentDir, "mcp.json"), JSON.stringify({ mcpServers: { engram: wrapper } }));
      const pi = (await import("../src/adapters/pi.js")) as any;
      expect(typeof pi.verifyOfficialSetup, "falta verificador Pi estricto (T42)").toBe("function");

      const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
      expect(report.ok).toBe(false);
      expect(JSON.stringify(report)).toMatch(/mcp|invalid|conflict/i);
      expect(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")).toBe(before);
    },
  );

  it.each([["missing-lifecycle"], ["wrong-lifecycle"], ["missing-directTools"]] as const)(
    "rechaza forma directa sin lifecycle lazy + directTools false exactos (%s)",
    async (kind) => {
      const { piAgentDir, engramBin } = t42PiDir();
      const direct =
        kind === "missing-lifecycle"
          ? { command: engramBin, args: ["mcp", "--tools=agent"], directTools: false }
          : kind === "wrong-lifecycle"
            ? { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "eager", directTools: false }
            : { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy" };
      fs.writeFileSync(path.join(piAgentDir, "mcp.json"), JSON.stringify({ mcpServers: { engram: direct } }));
      const pi = (await import("../src/adapters/pi.js")) as any;
      expect(typeof pi.verifyOfficialSetup, "falta verificador Pi estricto (T42)").toBe("function");

      const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
      expect(report.ok).toBe(false);
      expect(JSON.stringify(report)).toMatch(/mcp|invalid|lifecycle|directTools/i);
    },
  );
});

// ---------------------------------------------------------------------------
// T50-RED: identidad estricta de package source + conflicto legacy servers.
// Contrato: solo bare oficial o selector npm seguro de versión/tag/rango
// (string u objeto con source); file:/link:/workspace:/patch:/URL/Git/paths
// y alias npm a otro paquete se rechazan aunque el prefijo sea
// npm:gentle-engram@/npm:pi-mcp-adapter@. MCP canónico exacto exige ausencia
// de servers.engram legacy adicional: coexistencia es conflicto fail-closed.
// Solo lectura; temporales aislados.
// ---------------------------------------------------------------------------

const T50_PI_SOURCE_ROOTS: string[] = [];

afterEach(() => {
  for (const root of T50_PI_SOURCE_ROOTS.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function t50PiDir(): { piAgentDir: string; engramBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-pi-source-"));
  T50_PI_SOURCE_ROOTS.push(root);
  const piAgentDir = path.join(root, "pi-agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(root, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  fs.writeFileSync(
    path.join(piAgentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }),
  );
  return { piAgentDir, engramBin };
}

describe("[T50-RED] Pi package source identidad estricta", () => {
  it("control: acepta bare y selectores seguros de versión/tag/rango en string", async () => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi identidad (T50)").toBe("function");
    const safePairs = [
      ["npm:gentle-engram", "npm:pi-mcp-adapter"],
      ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5"],
      ["npm:gentle-engram@^0.1.0", "npm:pi-mcp-adapter@^0.2.0"],
      ["npm:gentle-engram@~0.1.0", "npm:pi-mcp-adapter@~0.2.0"],
      ["npm:gentle-engram@latest", "npm:pi-mcp-adapter@latest"],
      ["npm:gentle-engram@beta", "npm:pi-mcp-adapter@beta"],
    ] as const;
    for (const [gentle, adapter] of safePairs) {
      fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify({ packages: [gentle, adapter] }));
      const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
      expect(report.ok, `debe aceptar string seguro ${gentle} + ${adapter}`).toBe(true);
    }
  });

  it("control: acepta bare y selectores seguros en objeto { source }", async () => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi identidad objeto (T50)").toBe("function");
    const safePairs = [
      ["npm:gentle-engram", "npm:pi-mcp-adapter"],
      ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5"],
      ["npm:gentle-engram@^0.1.0", "npm:pi-mcp-adapter@latest"],
    ] as const;
    for (const [gentle, adapter] of safePairs) {
      fs.writeFileSync(
        path.join(piAgentDir, "settings.json"),
        JSON.stringify({ packages: [{ source: gentle }, { source: adapter }] }),
      );
      const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
      expect(report.ok, `debe aceptar objeto seguro ${gentle} + ${adapter}`).toBe(true);
    }
  });

  it.each([
    ["file relativo", "npm:gentle-engram@file:../evil.tgz"],
    ["file absoluto", "npm:gentle-engram@file:/tmp/evil.tgz"],
    ["link", "npm:gentle-engram@link:../evil"],
    ["workspace", "npm:gentle-engram@workspace:*"],
    ["patch", "npm:gentle-engram@patch:gentle-engram@npm:0.1.99#./patch.diff"],
    ["URL https", "npm:gentle-engram@https://evil.invalid/g.tgz"],
    ["URL http", "npm:gentle-engram@http://evil.invalid/g.tgz"],
    ["git https", "npm:gentle-engram@git+https://github.com/evil/r.git"],
    ["git ssh", "npm:gentle-engram@git+ssh://git@github.com/evil/r.git"],
    ["github shorthand", "npm:gentle-engram@github:evil/r"],
    ["path relativo padre", "npm:gentle-engram@../evil"],
    ["path relativo actual", "npm:gentle-engram@./evil"],
    ["path absoluto", "npm:gentle-engram@/tmp/evil"],
    ["alias npm a otro paquete", "npm:gentle-engram@npm:evil@1.0.0"],
  ] as const)("rechaza gentle redirigido %s en string y en objeto", async (_name, gentleRedirected) => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi estricto (T50)").toBe("function");
    const before = fs.readFileSync(path.join(piAgentDir, "mcp.json"), "utf8");

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: [gentleRedirected, "npm:pi-mcp-adapter@0.2.5"] }),
    );
    const asString = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asString.ok, `string redirigido debe fallar: ${gentleRedirected}`).toBe(false);
    expect(JSON.stringify(asString)).toMatch(/singleton|source|divergent|invalid|package/i);

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: gentleRedirected }, { source: "npm:pi-mcp-adapter@0.2.5" }] }),
    );
    const asObject = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asObject.ok, `objeto redirigido debe fallar: ${gentleRedirected}`).toBe(false);
    expect(JSON.stringify(asObject)).toMatch(/singleton|source|divergent|invalid|package/i);
    expect(fs.readFileSync(path.join(piAgentDir, "mcp.json"), "utf8")).toBe(before);
  });

  it.each([
    ["file", "npm:pi-mcp-adapter@file:../evil.tgz"],
    ["URL", "npm:pi-mcp-adapter@https://evil.invalid/a.tgz"],
    ["git", "npm:pi-mcp-adapter@git+https://github.com/evil/a.git"],
    ["alias a otro paquete", "npm:pi-mcp-adapter@npm:evil@1.0.0"],
    ["workspace", "npm:pi-mcp-adapter@workspace:*"],
    ["path", "npm:pi-mcp-adapter@../evil"],
  ] as const)("rechaza adapter redirigido %s en string y en objeto", async (_name, adapterRedirected) => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi estricto adapter (T50)").toBe("function");

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", adapterRedirected] }),
    );
    const asString = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asString.ok, `adapter string redirigido debe fallar: ${adapterRedirected}`).toBe(false);
    expect(JSON.stringify(asString)).toMatch(/singleton|source|divergent|invalid|package/i);

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: "npm:gentle-engram@0.1.99" }, { source: adapterRedirected }] }),
    );
    const asObject = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asObject.ok, `adapter objeto redirigido debe fallar: ${adapterRedirected}`).toBe(false);
    expect(JSON.stringify(asObject)).toMatch(/singleton|source|divergent|invalid|package/i);
  });
});

describe("[T50-RED] Pi MCP canónico exige ausencia de servers.engram legacy", () => {
  it("control: canónico exacto solo sin legacy pasa", async () => {
    const { piAgentDir, engramBin } = t50PiDir();
    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5"] }),
    );
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi MCP (T50)").toBe("function");
    const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(report.ok).toBe(true);
  });

  it.each([
    ["copia exacta legacy", "exact"],
    ["comando ajeno", "foreign"],
    ["forma inválida", "invalid"],
  ] as const)("coexistencia canónico exacto + servers.engram legacy %s es conflicto fail-closed", async (_name, legacyKind) => {
    const { piAgentDir, engramBin } = t50PiDir();
    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5"] }),
    );
    const canonical = { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false };
    const legacy =
      legacyKind === "exact"
        ? { ...canonical }
        : legacyKind === "foreign"
          ? { command: "foreign-server", args: ["mcp"], lifecycle: "lazy", directTools: false }
          : { command: engramBin };
    fs.writeFileSync(
      path.join(piAgentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { engram: canonical }, servers: { engram: legacy } }),
    );
    const before = fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8");
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi conflicto legacy (T50)").toBe("function");
    const report = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(report.ok, `canónico + legacy ${legacyKind} debe fallar cerrado`).toBe(false);
    expect(JSON.stringify(report)).toMatch(/conflict|servers|legacy|mcp/i);
    expect(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// T50-RED fix-check: sufijo tarball local + válido+inseguro mismo nombre.
// Contrato: selector que termina case-insensitive en .tgz/.tar/.tar.gz es
// redirect a tarball local y se rechaza (string y {source}); un válido
// oficial más un segundo inseguro que reclama el mismo nombre protegido
// (gentle-engram o pi-mcp-adapter) falla en vez de filtrar el inseguro
// antes del conteo singleton. Entradas ajenas no protegidas siguen
// permitidas. Solo lectura; temporales aislados.
// ---------------------------------------------------------------------------

describe("[T50-RED] Pi sufijo tarball local rechazado", () => {
  it.each([
    ["gentle tgz minúsculas", "npm:gentle-engram@evil.tgz", "npm:pi-mcp-adapter@0.2.5"],
    ["gentle TGZ mayúsculas", "npm:gentle-engram@EVIL.TGZ", "npm:pi-mcp-adapter@0.2.5"],
    ["gentle tar minúsculas", "npm:gentle-engram@evil.tar", "npm:pi-mcp-adapter@0.2.5"],
    ["gentle TAR mayúsculas", "npm:gentle-engram@evil.TAR", "npm:pi-mcp-adapter@0.2.5"],
    ["gentle tar.gz minúsculas", "npm:gentle-engram@evil.tar.gz", "npm:pi-mcp-adapter@0.2.5"],
    ["gentle TAR.GZ mayúsculas", "npm:gentle-engram@evil.TAR.GZ", "npm:pi-mcp-adapter@0.2.5"],
    ["adapter tgz minúsculas", "npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@evil.tgz"],
    ["adapter TGZ mayúsculas", "npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@EVIL.TGZ"],
    ["adapter tar minúsculas", "npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@evil.tar"],
    ["adapter TAR mayúsculas", "npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@evil.TAR"],
    ["adapter tar.gz minúsculas", "npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@evil.tar.gz"],
    ["adapter TAR.GZ mayúsculas", "npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@evil.TAR.GZ"],
  ] as const)("rechaza tarball local %s en string y en objeto", async (_name, gentle, adapter) => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi tarball (T50)").toBe("function");
    const before = fs.readFileSync(path.join(piAgentDir, "mcp.json"), "utf8");

    fs.writeFileSync(path.join(piAgentDir, "settings.json"), JSON.stringify({ packages: [gentle, adapter] }));
    const asString = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asString.ok, `tarball string debe fallar: ${gentle} + ${adapter}`).toBe(false);
    expect(JSON.stringify(asString)).toMatch(/singleton|source|divergent|invalid|package|tarball/i);

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: gentle }, { source: adapter }] }),
    );
    const asObject = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asObject.ok, `tarball objeto debe fallar: ${gentle} + ${adapter}`).toBe(false);
    expect(JSON.stringify(asObject)).toMatch(/singleton|source|divergent|invalid|package|tarball/i);
    expect(fs.readFileSync(path.join(piAgentDir, "mcp.json"), "utf8")).toBe(before);
  });
});

describe("[T50-RED] Pi válido más inseguro del mismo nombre falla sin filtrar", () => {
  it.each([
    ["gentle válido más file", "npm:gentle-engram@0.1.99", "npm:gentle-engram@file:../evil.tgz"],
    ["gentle válido más URL", "npm:gentle-engram@0.1.99", "npm:gentle-engram@https://evil.invalid/x.tgz"],
    ["gentle válido más alias a otro", "npm:gentle-engram@0.1.99", "npm:gentle-engram@npm:evil@1.0.0"],
    ["gentle válido más workspace", "npm:gentle-engram", "npm:gentle-engram@workspace:*"],
  ] as const)("gentle %s en string y en objeto", async (_name, validGentle, unsafeGentle) => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi válido+inseguro (T50)").toBe("function");

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: [validGentle, unsafeGentle, "npm:pi-mcp-adapter@0.2.5"] }),
    );
    const asString = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asString.ok, `válido+inseguro string debe fallar: ${validGentle} + ${unsafeGentle}`).toBe(false);
    expect(JSON.stringify(asString)).toMatch(/singleton|source|divergent|invalid|duplicate|package/i);

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({
        packages: [{ source: validGentle }, { source: unsafeGentle }, { source: "npm:pi-mcp-adapter@0.2.5" }],
      }),
    );
    const asObject = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asObject.ok, `válido+inseguro objeto debe fallar: ${validGentle} + ${unsafeGentle}`).toBe(false);
    expect(JSON.stringify(asObject)).toMatch(/singleton|source|divergent|invalid|duplicate|package/i);
  });

  it.each([
    ["adapter válido más file", "npm:pi-mcp-adapter@0.2.5", "npm:pi-mcp-adapter@file:../evil.tgz"],
    ["adapter válido más URL", "npm:pi-mcp-adapter@0.2.5", "npm:pi-mcp-adapter@https://evil.invalid/a.tgz"],
    ["adapter válido más alias a otro", "npm:pi-mcp-adapter@0.2.5", "npm:pi-mcp-adapter@npm:evil@1.0.0"],
    ["adapter válido más workspace", "npm:pi-mcp-adapter", "npm:pi-mcp-adapter@workspace:*"],
  ] as const)("adapter %s en string y en objeto", async (_name, validAdapter, unsafeAdapter) => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi válido+inseguro adapter (T50)").toBe("function");

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", validAdapter, unsafeAdapter] }),
    );
    const asString = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asString.ok, `válido+inseguro string debe fallar: ${validAdapter} + ${unsafeAdapter}`).toBe(false);
    expect(JSON.stringify(asString)).toMatch(/singleton|source|divergent|invalid|duplicate|package/i);

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({
        packages: [{ source: "npm:gentle-engram@0.1.99" }, { source: validAdapter }, { source: unsafeAdapter }],
      }),
    );
    const asObject = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asObject.ok, `válido+inseguro objeto debe fallar: ${validAdapter} + ${unsafeAdapter}`).toBe(false);
    expect(JSON.stringify(asObject)).toMatch(/singleton|source|divergent|invalid|duplicate|package/i);
  });

  it("control: entradas ajenas no protegidas siguen permitidas en string y en objeto", async () => {
    const { piAgentDir, engramBin } = t50PiDir();
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verificador Pi ajenas (T50)").toBe("function");

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5", "npm:lodash@4.17.21"] }),
    );
    const asString = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asString.ok, "ajena string no debe bloquear singleton oficial").toBe(true);

    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({
        packages: [{ source: "npm:gentle-engram" }, { source: "npm:pi-mcp-adapter" }, { source: "npm:lodash@4.17.21" }],
      }),
    );
    const asObject = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin, homeDir: path.dirname(piAgentDir) });
    expect(asObject.ok, "ajena objeto no debe bloquear singleton oficial").toBe(true);
  });
});
