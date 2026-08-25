import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE, type PiRuntimeCandidate } from "./fixtures/pi-runtime.js";

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

type PiPackageLifecycleModule = {
  planPiPackageLifecycle(input: PiPackageLifecycleInput): PiPackageLifecyclePlan;
};

async function lifecycle(): Promise<PiPackageLifecycleModule> {
  const mod = await import("../src/lib/pi-package-lifecycle.js") as Partial<PiPackageLifecycleModule>;
  expect(mod.planPiPackageLifecycle).toBeTypeOf("function");
  return mod as PiPackageLifecycleModule;
}

const PACKAGE_ROOT = "/tmp/pi-agent/packages/jorgex-pi-0.1.0";
const EXACT_SETTINGS = JSON.stringify({
  packages: [{ source: PI_RUNTIME_CANDIDATE.package.source, skills: [] }],
});

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
      codingAgentDir: "/tmp/pi-agent",
      receiptPath: "/home/test/.jorgex-stack/pi-receipt.json",
      environment: {
        PI_CODING_AGENT_DIR: "/tmp/pi-agent",
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
    scope: { kind: "real", codingAgentDir: "/tmp/pi-agent" },
    engram: { binary: "/opt/engram/bin/engram" },
  };
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
        args: ["install", "npm:jorgex-pi@0.1.0", "--no-approve"],
        environment: {
          PI_CODING_AGENT_DIR: "/tmp/pi-agent",
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
        scope: { kind: "real", codingAgentDir: "/tmp/pi-agent" },
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
        input: healthyInput({ pi: { ...healthyInput().pi, settingsJson: JSON.stringify({ packages: ["npm:jorgex-pi@0.1.1"] }) } }),
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
    const filteredSettings = JSON.stringify({
      packages: [{ source: PI_RUNTIME_CANDIDATE.package.source, skills: [] }],
    });
    const initial = planPiPackageLifecycle(healthyInput());

    expect(initial.receipt).toMatchObject({ engram });

    const resumed = planPiPackageLifecycle(healthyInput({
      pi: { ...healthyInput().pi, settingsJson: filteredSettings },
      receiptJson: JSON.stringify({ ...initial.receipt, state: "installed", engram }),
    }));
    expect(resumed).toMatchObject({ kind: "ready", ownership: { receipt: true } });
  });
});
