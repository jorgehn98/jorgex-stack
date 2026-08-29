import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { planDetectedBinCommand } from "./detect.js";
import {
  QUALITY_PROFILES,
  evaluateQualityPolicy,
  type QualityControlDefinition,
  type QualityPolicyEvaluation,
  type QualityProfile,
} from "./quality-policy.js";
import {
  canonicalJson,
  createQualityReceipt,
  sha256,
  validateQualityReceipt,
  type QualityReceipt,
  type QualityReceiptCommandInput,
  type QualityReceiptResult,
} from "./quality-receipt.js";

export type QualityCommandStatus = "pass" | "fail" | "timeout" | "error" | "unavailable";

export type QualityCommandFailureReason =
  | "output-limit"
  | "unsafe-command"
  | "spawn-error"
  | "termination-timeout";

export interface QualityCommandInput {
  commandId: string;
  executable: string;
  argv: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface QualityCommandOutput {
  stdout: string;
  stderr: string;
}

export interface QualityCommandResult {
  commandId: string;
  status: QualityCommandStatus;
  exitCode: number | null;
  durationMs: number;
  output: QualityCommandOutput;
  reason?: QualityCommandFailureReason;
}

export interface QualityCommandDeps {
  terminate(child: ChildProcess): void;
}

export interface QualityPlanIdentity {
  baseSha: string;
  headSha: string;
}

export interface QualityPlanCommandInput extends Omit<QualityCommandInput, "commandId"> {
  controlId: string;
  commandId: string;
}

export interface QualityPlanInput {
  identity: QualityPlanIdentity;
  profile: QualityProfile;
  controls: readonly QualityControlDefinition[];
  commands: readonly QualityPlanCommandInput[];
}

export interface QualityPlanResult {
  evaluation: QualityPolicyEvaluation;
  receipt: QualityReceipt;
}

interface CapturedOutput {
  stdout: Buffer[];
  stderr: Buffer[];
  bytes: number;
}

function normalizeLimit(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const TERMINATION_GRACE_MS = 250;
const TASKKILL_TIMEOUT_MS = 2_000;

function normalizeTimeout(value: number | undefined): number | undefined {
  const timeoutMs = normalizeLimit(value, "timeoutMs");
  if (timeoutMs !== undefined && timeoutMs > MAX_NODE_TIMEOUT_MS) {
    throw new Error(`timeoutMs must not exceed ${MAX_NODE_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

type UnknownRecord = { [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isDenseStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index)) || typeof value[index] !== "string") return false;
  }
  return true;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isQualityProfile(value: unknown): value is QualityProfile {
  return typeof value === "string" && (QUALITY_PROFILES as readonly string[]).includes(value);
}

function assertValidEnvironment(value: unknown, label: string): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`Invalid ${label}.${key}`);
  }
}

function assertQualityPlanInput(value: unknown): asserts value is QualityPlanInput {
  if (!isRecord(value)) throw new Error("Invalid quality plan");

  if (!isRecord(value.identity)) throw new Error("Invalid quality plan identity");
  if (typeof value.identity.baseSha !== "string" || !COMMIT_SHA_PATTERN.test(value.identity.baseSha)) {
    throw new Error("Invalid quality plan identity.baseSha");
  }
  if (typeof value.identity.headSha !== "string" || !COMMIT_SHA_PATTERN.test(value.identity.headSha)) {
    throw new Error("Invalid quality plan identity.headSha");
  }
  if (!isQualityProfile(value.profile)) throw new Error("Invalid quality plan profile");

  if (!Array.isArray(value.controls)) throw new Error("Invalid quality plan controls");
  const controlIds = new Set<string>();
  for (let index = 0; index < value.controls.length; index += 1) {
    const control = value.controls[index];
    if (!isRecord(control) || !hasText(control.id)
      || (control.requirement !== "required" && control.requirement !== "optional")) {
      throw new Error(`Invalid quality plan controls[${index}]`);
    }
    if (controlIds.has(control.id)) {
      throw new Error(`Duplicate quality plan control id: ${control.id}`);
    }
    controlIds.add(control.id);
    if (Object.prototype.hasOwnProperty.call(control, "notApplicable")
      && typeof control.notApplicable !== "boolean") {
      throw new Error(`Invalid quality plan controls[${index}].notApplicable`);
    }
  }

  if (!Array.isArray(value.commands)) throw new Error("Invalid quality plan commands");
  const commandIds = new Set<string>();
  const commandControlIds = new Set<string>();
  for (let index = 0; index < value.commands.length; index += 1) {
    const command = value.commands[index];
    if (!isRecord(command)) throw new Error(`Invalid quality plan commands[${index}]`);
    const timeoutMs = command.timeoutMs;
    if (!hasText(command.controlId)
      || !hasText(command.commandId)
      || !hasText(command.executable)
      || !isDenseStringArray(command.argv)
      || !isNonNegativeSafeInteger(timeoutMs)) {
      throw new Error(`Invalid quality plan commands[${index}]`);
    }
    if (timeoutMs > MAX_NODE_TIMEOUT_MS) {
      throw new Error(`Invalid quality plan commands[${index}].timeoutMs: maximum is ${MAX_NODE_TIMEOUT_MS}`);
    }
    if (!controlIds.has(command.controlId)) {
      throw new Error(`Unknown quality plan command control id: ${command.controlId}`);
    }
    if (commandIds.has(command.commandId)) {
      throw new Error(`Duplicate quality plan command id: ${command.commandId}`);
    }
    if (commandControlIds.has(command.controlId)) {
      throw new Error(`Multiple quality plan commands for control id: ${command.controlId}`);
    }
    commandIds.add(command.commandId);
    commandControlIds.add(command.controlId);
    if (command.maxOutputBytes !== undefined && !isNonNegativeSafeInteger(command.maxOutputBytes)) {
      throw new Error(`Invalid quality plan commands[${index}].maxOutputBytes`);
    }
    if (command.env !== undefined) assertValidEnvironment(command.env, `quality plan commands[${index}].env`);
  }
}

function appendOutput(
  captured: CapturedOutput,
  stream: "stdout" | "stderr",
  chunk: Buffer,
  maxOutputBytes: number | undefined,
): boolean {
  if (maxOutputBytes === undefined) {
    captured[stream].push(chunk);
    return false;
  }

  const remaining = maxOutputBytes - captured.bytes;
  if (remaining <= 0) return chunk.length > 0;

  if (chunk.length > remaining) {
    captured[stream].push(chunk.subarray(0, remaining));
    captured.bytes += remaining;
    return true;
  }

  captured[stream].push(chunk);
  captured.bytes += chunk.length;
  return captured.bytes >= maxOutputBytes;
}

function decodeOutput(chunks: Buffer[], maxOutputBytes: number | undefined): string {
  const output = Buffer.concat(chunks);
  if (maxOutputBytes === undefined || output.length === 0) return output.toString("utf8");

  let end = output.length;
  let decoded = output.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(decoded, "utf8") > maxOutputBytes && end > 0) {
    end -= 1;
    decoded = output.subarray(0, end).toString("utf8");
  }
  return decoded;
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const result = spawnSync(taskkill, ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and the kill attempt.
      }
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and the kill attempt.
    }
  }
}

function resultFromCaptured(
  input: QualityCommandInput,
  status: QualityCommandStatus,
  exitCode: number | null,
  startedAt: number,
  captured: CapturedOutput,
  maxOutputBytes: number | undefined,
  reason?: QualityCommandFailureReason,
): QualityCommandResult {
  return {
    commandId: input.commandId,
    status,
    exitCode,
    durationMs: Math.max(0, Date.now() - startedAt),
    output: {
      stdout: decodeOutput(captured.stdout, maxOutputBytes),
      stderr: decodeOutput(captured.stderr, maxOutputBytes),
    },
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Runs one quality command with direct argv and an explicit environment (empty
 * when omitted), optionally bounded capture, and best-effort tree termination
 * for timeout/output-limit failures. This is local process orchestration, not
 * a sandbox or an enforcement boundary.
 */
export async function runQualityCommand(
  input: QualityCommandInput,
  deps: QualityCommandDeps = { terminate: killProcessTree },
): Promise<QualityCommandResult> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const maxOutputBytes = normalizeLimit(input.maxOutputBytes, "maxOutputBytes");
  if (timeoutMs === undefined) throw new Error("timeoutMs is required");

  const planned = planDetectedBinCommand(input.executable, [...input.argv]);
  const startedAt = Date.now();
  const captured: CapturedOutput = { stdout: [], stderr: [], bytes: 0 };

  if (planned === null) {
    return resultFromCaptured(input, "error", null, startedAt, captured, maxOutputBytes, "unsafe-command");
  }

  return new Promise<QualityCommandResult>((resolve) => {
    let settled = false;
    let terminationReason: "timeout" | "output-limit" | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let terminationDeadline: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let cleanedUp = false;
    let onStdoutData = (_chunk: Buffer): void => {};
    let onStderrData = (_chunk: Buffer): void => {};
    let onError = (_error: NodeJS.ErrnoException): void => {};
    const onErrorSink = (): void => {};
    let onClose = (_exitCode: number | null): void => {};

    const cleanupChild = (): void => {
      if (cleanedUp || child === undefined) return;
      cleanedUp = true;
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      child.on("error", onErrorSink);
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    const settle = (result: QualityCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      cleanupChild();
      resolve(result);
    };

    try {
      child = spawn(planned.command, planned.args, {
        detached: true,
        env: input.env === undefined ? {} : { ...input.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle(resultFromCaptured(input, "unavailable", null, startedAt, captured, maxOutputBytes, "spawn-error"));
      return;
    }

    const stopFor = (reason: "timeout" | "output-limit"): void => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = reason;
      try {
        deps.terminate(child);
      } catch {
        // A failed termination is reported by the grace deadline below.
      }
      if (settled) return;
      terminationDeadline = setTimeout(() => {
        try {
          deps.terminate(child);
        } catch {
          // A failed termination is reported by the grace deadline below.
        }
        cleanupChild();
        settle(resultFromCaptured(input, "error", null, startedAt, captured, maxOutputBytes, "termination-timeout"));
      }, TERMINATION_GRACE_MS);
    };

    const onOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (settled || appendOutput(captured, stream, chunk, maxOutputBytes)) {
        if (!settled && maxOutputBytes !== undefined) stopFor("output-limit");
      }
    };

    onStdoutData = (chunk: Buffer): void => onOutput("stdout", chunk);
    onStderrData = (chunk: Buffer): void => onOutput("stderr", chunk);
    onError = (error: NodeJS.ErrnoException): void => {
      spawnError = error;
      if (terminationReason === undefined && (error.code === "ENOENT" || error.code === "EACCES")) {
        settle(resultFromCaptured(input, "unavailable", null, startedAt, captured, maxOutputBytes, "spawn-error"));
      }
    };
    onClose = (exitCode: number | null): void => {
      if (terminationReason === "timeout") {
        settle(resultFromCaptured(input, "timeout", exitCode, startedAt, captured, maxOutputBytes));
        return;
      }
      if (terminationReason === "output-limit") {
        settle(resultFromCaptured(input, "error", exitCode, startedAt, captured, maxOutputBytes, "output-limit"));
        return;
      }
      if (spawnError !== undefined) {
        settle(resultFromCaptured(input, "unavailable", null, startedAt, captured, maxOutputBytes, "spawn-error"));
        return;
      }

      settle(resultFromCaptured(
        input,
        exitCode === 0 ? "pass" : "fail",
        exitCode,
        startedAt,
        captured,
        maxOutputBytes,
      ));
    };

    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    child.once("error", onError);
    child.once("close", onClose);

    timeout = setTimeout(() => stopFor("timeout"), timeoutMs);
  });
}

function resultEvidence(result: QualityCommandResult): string {
  const exitCode = result.exitCode === null ? "none" : String(result.exitCode);
  return `exit=${exitCode}; status=${result.status}; durationMs=${result.durationMs}`;
}

function resultReason(result: QualityCommandResult): string | undefined {
  switch (result.status) {
    case "pass":
      return undefined;
    case "fail":
      return "nonzero-exit";
    case "timeout":
      return "timeout";
    case "unavailable":
      return result.reason ?? "unavailable";
    case "error":
      return result.reason ?? "error";
  }
}

function receiptResultFor(
  controlId: string,
  result: QualityCommandResult,
): QualityReceiptResult {
  const evidence = resultEvidence(result);
  if (result.status === "pass") return { controlId, status: "pass", evidence };

  return {
    controlId,
    status: result.status === "fail" ? "fail" : "incomplete",
    evidence,
    reason: resultReason(result),
  };
}

function missingRequiredResults(
  controls: readonly QualityControlDefinition[],
  commands: readonly QualityPlanCommandInput[],
): QualityReceiptResult[] {
  const commandControlIds = new Set(commands.map((command) => command.controlId));
  const missing = new Set<string>();

  for (const control of controls) {
    if (control.requirement !== "required" || !hasText(control.id) || commandControlIds.has(control.id)) continue;
    missing.add(control.id);
  }

  return [...missing].map((controlId) => ({
    controlId,
    status: "incomplete" as const,
    evidence: "required control has no declared command",
    reason: "required-control-missing",
  }));
}

function receiptCommandFor(
  command: QualityPlanCommandInput,
  result: QualityCommandResult,
): QualityReceiptCommandInput {
  return {
    commandId: command.commandId,
    executable: command.executable,
    argv: command.argv,
    exitCode: result.exitCode ?? -1,
    durationMs: result.durationMs,
    output: result.output,
  };
}

/**
 * Executes an explicit quality plan in declaration order and returns its
 * policy evaluation plus a local, redacted receipt. This is lifecycle
 * orchestration, not a sandbox or an authority capable of producing an
 * enforced receipt.
 */
export async function runQualityPlan(input: unknown): Promise<QualityPlanResult> {
  assertQualityPlanInput(input);

  const policy = { controls: input.controls, profile: input.profile };
  const policyDigest = sha256(canonicalJson(policy));
  const identity = {
    profile: input.profile,
    baseSha: input.identity.baseSha,
    headSha: input.identity.headSha,
    policyDigest,
  };
  const commands: QualityReceiptCommandInput[] = [];
  const results: QualityReceiptResult[] = [];

  for (const command of input.commands) {
    const result = await runQualityCommand(command);
    commands.push(receiptCommandFor(command, result));
    results.push(receiptResultFor(command.controlId, result));
  }

  results.push(...missingRequiredResults(input.controls, input.commands));

  const evaluation = evaluateQualityPolicy({
    profile: input.profile,
    controls: input.controls,
    results,
  });
  const receipt = createQualityReceipt({
    authority: "local",
    identity,
    commands,
    results,
  });
  validateQualityReceipt(receipt, identity);

  return { evaluation, receipt };
}
