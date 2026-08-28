import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  serializeQualityReceipt,
  sha256,
  validateQualityReceipt,
} from "../src/lib/quality-receipt.js";
import type { QualityControlDefinition } from "../src/lib/quality-policy.js";
import {
  runQualityCommand,
  runQualityPlan,
  type QualityCommandInput,
  type QualityCommandResult,
  type QualityPlanCommandInput,
  type QualityPlanInput,
} from "../src/lib/quality-runner.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jx-quality-runner-"));
  tempDirs.push(directory);
  return directory;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredControl(id = "typecheck"): QualityControlDefinition {
  return { id, requirement: "required" };
}

function planCommand(
  controlId: string,
  overrides: Partial<QualityPlanCommandInput> = {},
): QualityPlanCommandInput {
  return {
    controlId,
    commandId: controlId,
    executable: process.execPath,
    argv: ["-e", "process.stdout.write('quality-ok\\n')"],
    timeoutMs: 2_000,
    ...overrides,
  };
}

function markerCommand(
  controlId: string,
  commandId: string,
  marker: string,
): QualityPlanCommandInput {
  return planCommand(controlId, {
    commandId,
    argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
  });
}

function qualityPlan(
  commands: readonly QualityPlanCommandInput[],
  controls: readonly QualityControlDefinition[] = [requiredControl()],
): QualityPlanInput {
  return {
    identity: { baseSha: BASE_SHA, headSha: HEAD_SHA },
    profile: "routine",
    controls,
    commands,
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality command runner", () => {
  it("passes argv directly without invoking a shell", async () => {
    const argument = "value with spaces & $(not-a-command) ; `still-argv`";
    const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

    const result = await runQualityCommand({
      commandId: "argv-direct",
      executable: process.execPath,
      argv: ["-e", script, "--", argument],
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.output.stdout).toBe(JSON.stringify([argument]));
    expect(result.output.stderr).toBe("");
  });

  it("uses only the supplied sanitized environment instead of inheriting ambient secrets", async () => {
    const ambientSecretKey = `JX_T10_AMBIENT_SECRET_${process.pid}`;
    const previousAmbientSecret = process.env[ambientSecretKey];
    process.env[ambientSecretKey] = "ambient-secret-sentinel";

    try {
      const script = [
        "const key = process.argv[1];",
        "process.stdout.write(JSON.stringify({",
        "  explicit: process.env.JX_T10_EXPLICIT_VALUE ?? null,",
        "  ambient: Object.prototype.hasOwnProperty.call(process.env, key),",
        "}));",
      ].join("\n");

      const result = await runQualityCommand({
        commandId: "sanitized-env",
        executable: process.execPath,
        argv: ["-e", script, "--", ambientSecretKey],
        env: { JX_T10_EXPLICIT_VALUE: "kept" },
        timeoutMs: 2_000,
      });

      expect(result.status).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output.stdout)).toEqual({
        explicit: "kept",
        ambient: false,
      });
    } finally {
      if (previousAmbientSecret === undefined) delete process.env[ambientSecretKey];
      else process.env[ambientSecretKey] = previousAmbientSecret;
    }
  });

  it("preserves a non-zero exit code and never classifies it as pass", async () => {
    const result = await runQualityCommand({
      commandId: "nonzero-exit",
      executable: process.execPath,
      argv: ["-e", "process.stderr.write('failure\\n'); process.exit(7)"],
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(7);
    expect(result.output.stdout).toBe("");
    expect(result.output.stderr).toBe("failure\n");
  });

  it("returns a typed timeout state for a command that does not finish", async () => {
    const result = await runQualityCommand({
      commandId: "timeout",
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 100,
    });

    expect(result.status).toBe("timeout");
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(2_000);
  }, 3_000);

  it("caps captured output without allowing an unbounded stream", async () => {
    const output = "0123456789abcdef".repeat(256);
    const maxOutputBytes = 64;

    const result = await runQualityCommand({
      commandId: "output-limit",
      executable: process.execPath,
      argv: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
      maxOutputBytes,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("output-limit");
    expect(result.output.stdout).toBe(output.slice(0, maxOutputBytes));
    expect(Buffer.byteLength(result.output.stdout, "utf8")).toBeLessThanOrEqual(maxOutputBytes);
    expect(result.output.stderr).toBe("");
  });

  it("reports an explicit missing executable as unavailable without PATH autodetection", async () => {
    const missingExecutable = path.join(tempDir(), "missing executable");

    const result = await runQualityCommand({
      commandId: "missing-executable",
      executable: missingExecutable,
      argv: [],
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("unavailable");
    expect(result.exitCode).toBeNull();
    expect(result.output.stdout).toBe("");
  });

  it("kills the launched process tree when the root command times out", async () => {
    const marker = path.join(tempDir(), "orphan marker.txt");
    const grandchildScript = [
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), Number(process.argv[2]))",
    ].join(";");
    const rootScript = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2], process.argv[3]], { stdio: 'ignore' });",
      "process.stdout.write('spawned\\n');",
      "setTimeout(() => {}, 60_000);",
    ].join("\n");

    const result = await runQualityCommand({
      commandId: "kill-tree",
      executable: process.execPath,
      argv: ["-e", rootScript, "--", grandchildScript, marker, "300"],
      timeoutMs: 100,
    });

    expect(result.status).toBe("timeout");
    expect(result.output.stdout).toContain("spawned\n");
    await wait(550);
    expect(fs.existsSync(marker)).toBe(false);
  }, 3_000);

  it("rejects a timeout above Node's timer maximum before spawning", async () => {
    const marker = path.join(tempDir(), "overflow-timeout-marker.txt");
    let rejected = false;

    try {
      await runQualityPlan(qualityPlan([{
        ...markerCommand("typecheck", "overflow-timeout", marker),
        timeoutMs: 2_147_483_648,
      }]));
    } catch {
      rejected = true;
    }

    expect({ rejected, markerCreated: fs.existsSync(marker) }).toEqual({
      rejected: true,
      markerCreated: false,
    });
  });

  it("settles with an observable error when termination never closes the child", async () => {
    type TerminationDependencies = {
      terminate: (child: unknown) => void;
    };
    type RunQualityCommandWithDependencies = (
      input: QualityCommandInput,
      dependencies: TerminationDependencies,
    ) => Promise<QualityCommandResult>;

    const runWithDependencies = runQualityCommand as unknown as RunQualityCommandWithDependencies;
    let terminationAttempts = 0;
    const startedAt = Date.now();

    try {
      const result = await runWithDependencies({
        commandId: "termination-deadline",
        executable: process.execPath,
        argv: ["-e", "setTimeout(() => process.exit(0), 300)"],
        timeoutMs: 25,
      }, {
        // The child exits by itself later; this seam models a kill that neither
        // terminates the process nor causes the runner's close event.
        terminate: () => {
          terminationAttempts += 1;
        },
      });

      expect({
        status: result.status,
        reason: result.reason,
        terminationAttempts,
      }).toEqual({
        status: "error",
        reason: "termination-timeout",
        terminationAttempts: 1,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      // Let the deliberately delayed child exit before the test process moves on.
      await wait(350);
    }
  }, 2_000);
});

describe("quality plan tracer contract", () => {
  it.each([
    {
      name: "an unknown controlId",
      makePlan: (marker: string) => qualityPlan([
        markerCommand("unknown-control", "unknown-control-command", marker),
      ]),
    },
    {
      name: "duplicate commandId values",
      makePlan: (marker: string) => qualityPlan([
        markerCommand("typecheck", "duplicate-command", marker),
        markerCommand("lint", "duplicate-command", marker),
      ], [requiredControl("typecheck"), requiredControl("lint")]),
    },
    {
      name: "duplicate controlId values",
      makePlan: (marker: string) => qualityPlan([
        markerCommand("typecheck", "first-command", marker),
        markerCommand("typecheck", "second-command", marker),
      ]),
    },
  ] as const)("rejects $name before spawning any command", async ({ makePlan }) => {
    const marker = path.join(tempDir(), "must-not-be-created.txt");
    let rejected = false;

    try {
      await runQualityPlan(makePlan(marker));
    } catch {
      rejected = true;
    }

    expect({ rejected, markerCreated: fs.existsSync(marker) }).toEqual({
      rejected: true,
      markerCreated: false,
    });
  });

  it("evaluates a passing explicit command and creates a safe, locally validable receipt", async () => {
    const outputSecret = "QUALITY_PLAN_OUTPUT_SECRET_SENTINEL";
    const policy = {
      controls: [requiredControl()],
      profile: "routine" as const,
    };
    const expectedPolicyDigest = sha256(canonicalJson(policy));
    const plan = qualityPlan([
      planCommand("typecheck", {
        argv: [
          "-e",
          "process.stdout.write('quality-ok\\nAuthorization: Bearer ' + process.env.JX_QUALITY_PLAN_SECRET)",
        ],
        env: { JX_QUALITY_PLAN_SECRET: outputSecret },
      }),
    ]);

    const result = await runQualityPlan(plan);
    const secondResult = await runQualityPlan(plan);

    expect(result.evaluation).toEqual({ profile: "routine", status: "pass" });
    expect(result.receipt.authority).toBe("local");
    expect(result.receipt.identity).toEqual({
      profile: "routine",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policyDigest: expectedPolicyDigest,
    });
    expect(secondResult.receipt.identity.policyDigest).toBe(expectedPolicyDigest);
    expect(() => validateQualityReceipt(result.receipt, {
      profile: "routine",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policyDigest: expectedPolicyDigest,
    })).not.toThrow();

    const command = result.receipt.commands[0];
    if (command === undefined) throw new Error("quality plan receipt has no command");
    expect(command).toMatchObject({
      commandId: "typecheck",
      executable: process.execPath,
      exitCode: 0,
      durationMs: expect.any(Number),
      excerpt: expect.stringContaining("quality-ok"),
      outputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(command.argv[0]).toBe("-e");
    expect(command.argv[1]).toEqual(expect.any(String));
    expect(command.excerpt).toContain("[REDACTED]");
    expect(command).not.toHaveProperty("output");
    expect(command).not.toHaveProperty("stdout");
    expect(command).not.toHaveProperty("stderr");

    const passResult = result.receipt.results.find((entry) => entry.controlId === "typecheck");
    if (passResult === undefined) throw new Error("quality plan receipt has no control result");
    expect(passResult.status).toBe("pass");
    if (passResult.status !== "pass") throw new Error("quality plan pass result is incomplete");
    expect(passResult.evidence.trim()).not.toBe("");
    expect(passResult.evidence).not.toContain(outputSecret);

    const serialized = serializeQualityReceipt(result.receipt);
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toMatch(/"output"|"stdout"|"stderr"/);
  });

  it("marks a required control incomplete when no command is declared", async () => {
    const result = await runQualityPlan(qualityPlan([]));

    expect(result.evaluation).toEqual({ profile: "routine", status: "incomplete" });
    expect(result.receipt.authority).toBe("local");
    expect(result.receipt.results).toEqual([
      expect.objectContaining({ controlId: "typecheck", status: "incomplete" }),
    ]);
  });

  it.each([
    {
      name: "timeout",
      makeCommand: () => planCommand("typecheck", {
        argv: ["-e", "setTimeout(() => {}, 60_000)"],
        timeoutMs: 100,
      }),
    },
    {
      name: "unavailable executable",
      makeCommand: () => planCommand("typecheck", {
        executable: path.join(tempDir(), "missing quality executable"),
        argv: [],
      }),
    },
    {
      name: "output limit",
      makeCommand: () => planCommand("typecheck", {
        argv: ["-e", "process.stdout.write('x'.repeat(10_000))"],
        maxOutputBytes: 64,
      }),
    },
  ] as const)("does not turn $name into pass or enforced authority", async ({ makeCommand }) => {
    const result = await runQualityPlan(qualityPlan([makeCommand()]));

    expect(result.evaluation.status).not.toBe("pass");
    expect(result.receipt.authority).toBe("local");
    expect(result.receipt.authority).not.toBe("enforced");
    expect(result.receipt.results).toEqual([
      expect.objectContaining({ controlId: "typecheck", status: "incomplete" }),
    ]);
  }, 5_000);
});
