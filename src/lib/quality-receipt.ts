import { createHash } from "node:crypto";
import { QUALITY_PROFILES, type QualityProfile } from "./quality-policy.js";

export const QUALITY_RECEIPT_NAMESPACE = "jorgex.quality.receipt" as const;
export const QUALITY_RECEIPT_VERSION = 1 as const;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_EXCERPT_LENGTH = 512;
const REDACTED = "[REDACTED]";

const QUALITY_RESULT_STATUSES = [
  "pass",
  "fail",
  "incomplete",
  "not-applicable",
] as const;
const SENSITIVE_FLAG_PATTERN = /^(?:-{1,2})(?:(?:[a-z][a-z0-9_.-]*[-_]?)?(?:access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|pass(?:word|wd)?|refresh[-_]?token|secret|token))$/i;
const SENSITIVE_ASSIGNMENT_PATTERN = /^(?:-{0,2})(?:(?:[a-z][a-z0-9_.-]*[-_]?)?(?:access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|pass(?:word|wd)?|refresh[-_]?token|secret|token))\s*[=:]\s*.+$/i;
const SENSITIVE_OUTPUT_PATTERN = /((?:authorization\s*:\s*bearer\s+|bearer\s+))[^\s,;]+/gi;
const SENSITIVE_KEY_VALUE_PATTERN = /((?:^|(?<=[^\w.-]))(?:-{0,2})(?:(?:[a-z][a-z0-9_.-]*[-_]?)?(?:access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|pass(?:word|wd)?|refresh[-_]?token|secret|token))\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
const SENSITIVE_SEPARATE_FLAG_PATTERN = /((?:^|(?<=[^\w.-]))-{1,2}(?:(?:[a-z][a-z0-9_.-]*[-_]?)?(?:access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|pass(?:word|wd)?|refresh[-_]?token|secret|token))[ \t]+)(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
const SENSITIVE_STRUCTURED_VALUE_PATTERN = /((?:"|')?(?:token|password|api[-_]?key|access[-_]?token|_?auth(?:orization)?(?:[-_.]?token)?|aws[-_]?secret[-_]?access[-_]?key|private[-_]?key)(?:"|')?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi;

export type QualityReceiptAuthority = "local" | "enforced";
export type QualityReceiptResultStatus = "pass" | "fail" | "incomplete" | "not-applicable";

export interface QualityReceiptIdentity {
  profile: QualityProfile;
  baseSha: string;
  headSha: string;
  policyDigest: string;
}

export interface QualityReceiptProvenance {
  issuer: string;
  executionId: string;
  evidenceLocator: string;
  evidenceDigest: string;
}

export interface QualityReceiptCommandOutput {
  stdout: string;
  stderr: string;
}

export interface QualityReceiptCommandInput {
  commandId: string;
  executable: string;
  argv: readonly string[];
  exitCode: number;
  durationMs: number;
  output: QualityReceiptCommandOutput;
  /**
   * @deprecated Receipt v1 deliberately omits execution environments. Kept
   * temporarily so callers can migrate without changing their command input.
   */
  environment?: Readonly<Record<string, string>>;
}

interface QualityReceiptInputBase {
  identity: QualityReceiptIdentity;
  commands: readonly QualityReceiptCommandInput[];
  results: readonly QualityReceiptResult[];
}

export interface QualityReceiptLocalInput extends QualityReceiptInputBase {
  authority: "local";
  provenance?: QualityReceiptProvenance;
}

export interface QualityReceiptEnforcedInput extends QualityReceiptInputBase {
  authority: "enforced";
  provenance: QualityReceiptProvenance;
}

export type QualityReceiptInput =
  | QualityReceiptLocalInput
  | QualityReceiptEnforcedInput;

export interface QualityReceiptPassResult {
  controlId: string;
  status: "pass";
  evidence: string;
  reason?: string;
}

export interface QualityReceiptNonPassResult {
  controlId: string;
  status: Exclude<QualityReceiptResultStatus, "pass">;
  evidence?: string;
  reason?: string;
}

export type QualityReceiptResult = QualityReceiptPassResult | QualityReceiptNonPassResult;

export interface QualityReceiptCommand {
  commandId: string;
  executable: string;
  argv: string[];
  exitCode: number;
  durationMs: number;
  excerpt: string;
  outputDigest: string;
}

interface QualityReceiptBase {
  namespace: typeof QUALITY_RECEIPT_NAMESPACE;
  version: typeof QUALITY_RECEIPT_VERSION;
  identity: QualityReceiptIdentity;
  commands: QualityReceiptCommand[];
  results: QualityReceiptResult[];
}

export interface QualityReceiptLocal extends QualityReceiptBase {
  authority: "local";
  provenance?: QualityReceiptProvenance;
}

export interface QualityReceiptEnforced extends QualityReceiptBase {
  authority: "enforced";
  provenance: QualityReceiptProvenance;
}

export type QualityReceipt = QualityReceiptLocal | QualityReceiptEnforced;

type UnknownRecord = { [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDenseStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, String(index)) || typeof value[index] !== "string") return false;
  }
  return true;
}

function assertExactKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Unexpected ${label} field: ${unexpected}`);
  }
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isQualityProfile(value: string): value is QualityProfile {
  return (QUALITY_PROFILES as readonly string[]).includes(value);
}

function isQualityReceiptResultStatus(value: string): value is QualityReceiptResultStatus {
  return (QUALITY_RESULT_STATUSES as readonly string[]).includes(value);
}

function requireSha(value: unknown, label: string, pattern: RegExp): string {
  const text = requireText(value, label);
  if (!pattern.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function redactText(value: string): string {
  return value
    .replace(SENSITIVE_STRUCTURED_VALUE_PATTERN, (_match, prefix: string, quotedValue: string) => {
      const quote = quotedValue[0];
      return `${prefix}${quote}${REDACTED}${quote}`;
    })
    .replace(SENSITIVE_OUTPUT_PATTERN, (_match, prefix: string) => {
      const normalizedPrefix = prefix.toLowerCase().startsWith("authorization")
        ? prefix.slice(0, prefix.toLowerCase().indexOf("bearer") + "bearer".length)
        : "Bearer ";
      return `${normalizedPrefix}${REDACTED}`;
    })
    .replace(SENSITIVE_KEY_VALUE_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_SEPARATE_FLAG_PATTERN, `$1${REDACTED}`);
}

function redactAssignment(value: string): string {
  const separator = value.indexOf("=") >= 0 ? "=" : ":";
  const name = value.slice(0, value.indexOf(separator));
  return `${name}${separator}${REDACTED}`;
}

function redactArgv(argv: readonly string[]): string[] {
  if (!isDenseStringArray(argv)) throw new Error("Invalid argv: sparse or non-string array");

  let redactNext = false;

  return argv.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }

    if (SENSITIVE_FLAG_PATTERN.test(argument)) {
      redactNext = true;
      return argument;
    }

    if (SENSITIVE_ASSIGNMENT_PATTERN.test(argument)) {
      return redactAssignment(argument);
    }

    return redactText(argument);
  });
}

function excerptFor(output: QualityReceiptCommandOutput): string {
  const stdout = redactText(output.stdout);
  const stderr = redactText(output.stderr);
  const combined = [stdout, stderr].filter((part) => part !== "").join("\n");
  return Array.from(combined).slice(0, MAX_EXCERPT_LENGTH).join("");
}

function outputDigestFor(output: QualityReceiptCommandOutput): string {
  const sanitized = {
    stdout: redactText(output.stdout),
    stderr: redactText(output.stderr),
  };
  return sha256(canonicalJson(sanitized));
}

function normalizeCommand(command: QualityReceiptCommandInput): QualityReceiptCommand {
  return {
    commandId: command.commandId,
    executable: command.executable,
    argv: redactArgv(command.argv),
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    excerpt: excerptFor(command.output),
    outputDigest: outputDigestFor(command.output),
  };
}

function normalizeResult(result: QualityReceiptResult): QualityReceiptResult {
  if (result.status === "pass") {
    return {
      controlId: result.controlId,
      status: "pass",
      evidence: result.evidence,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }

  return {
    controlId: result.controlId,
    status: result.status,
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

function normalizeProvenance(provenance: QualityReceiptProvenance): QualityReceiptProvenance {
  return {
    issuer: provenance.issuer,
    executionId: provenance.executionId,
    evidenceLocator: provenance.evidenceLocator,
    evidenceDigest: provenance.evidenceDigest,
  };
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string": {
      const result = JSON.stringify(value);
      if (result === undefined) throw new Error("Unable to canonicalize string");
      return result;
    }
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite number");
      const result = JSON.stringify(value);
      if (result === undefined) throw new Error("Unable to canonicalize number");
      return result;
    }
    case "object": {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (!hasOwn(value, String(index))) {
            throw new Error("Cannot canonicalize sparse array");
          }
        }
        return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Cannot canonicalize non-plain object");
      }

      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => {
        return `${JSON.stringify(key)}:${canonicalValue(object[key])}`;
      }).join(",")}}`;
    }
    default:
      throw new Error(`Cannot canonicalize ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateIdentity(value: unknown, expected?: QualityReceiptIdentity): QualityReceiptIdentity {
  const identity = requireRecord(value, "identity");
  assertExactKeys(identity, ["profile", "baseSha", "headSha", "policyDigest"], "identity");

  const profile = requireText(identity.profile, "identity.profile");
  if (!isQualityProfile(profile)) throw new Error(`Invalid identity.profile: ${profile}`);
  const baseSha = requireSha(identity.baseSha, "identity.baseSha", COMMIT_SHA_PATTERN);
  const headSha = requireSha(identity.headSha, "identity.headSha", COMMIT_SHA_PATTERN);
  const policyDigest = requireSha(identity.policyDigest, "identity.policyDigest", SHA256_PATTERN);

  const actual: QualityReceiptIdentity = { profile, baseSha, headSha, policyDigest };
  if (expected !== undefined) {
    for (const field of ["profile", "baseSha", "headSha", "policyDigest"] as const) {
      if (actual[field] !== expected[field]) {
        throw new Error(`Quality receipt identity mismatch: ${field}`);
      }
    }
  }

  return actual;
}

function validateProvenance(value: unknown): QualityReceiptProvenance {
  const provenance = requireRecord(value, "provenance");
  assertExactKeys(provenance, ["issuer", "executionId", "evidenceLocator", "evidenceDigest"], "provenance");

  const issuer = requireText(provenance.issuer, "provenance.issuer");
  const executionId = requireText(provenance.executionId, "provenance.executionId");
  const evidenceLocator = requireText(provenance.evidenceLocator, "provenance.evidenceLocator");
  if (!/^https?:\/\/\S+$/.test(evidenceLocator)) {
    throw new Error("Invalid provenance.evidenceLocator");
  }
  try {
    const parsed = new URL(evidenceLocator);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported locator protocol");
    }
  } catch {
    throw new Error("Invalid provenance.evidenceLocator");
  }
  const evidenceDigest = requireSha(provenance.evidenceDigest, "provenance.evidenceDigest", SHA256_PATTERN);

  return { issuer, executionId, evidenceLocator, evidenceDigest };
}

function validateCommand(value: unknown, index: number): QualityReceiptCommand {
  const command = requireRecord(value, `commands[${index}]`);
  assertExactKeys(
    command,
    ["commandId", "executable", "argv", "exitCode", "durationMs", "excerpt", "outputDigest"],
    `commands[${index}]`,
  );

  const commandId = requireText(command.commandId, `commands[${index}].commandId`);
  const executable = requireText(command.executable, `commands[${index}].executable`);
  if (!isDenseStringArray(command.argv)) {
    throw new Error(`Invalid commands[${index}].argv`);
  }
  if (typeof command.exitCode !== "number" || !Number.isInteger(command.exitCode)) {
    throw new Error(`Invalid commands[${index}].exitCode`);
  }
  if (typeof command.durationMs !== "number" || !Number.isFinite(command.durationMs) || command.durationMs < 0) {
    throw new Error(`Invalid commands[${index}].durationMs`);
  }
  if (!hasOwn(command, "excerpt") || typeof command.excerpt !== "string") {
    throw new Error(`Invalid commands[${index}].excerpt`);
  }
  const excerpt = command.excerpt;
  if (Array.from(excerpt).length > MAX_EXCERPT_LENGTH) throw new Error(`Invalid commands[${index}].excerpt`);
  if (redactText(excerpt) !== excerpt) {
    throw new Error(`Invalid commands[${index}].excerpt: contains an unredacted secret`);
  }
  const argv = [...command.argv];
  const sanitizedArgv = redactArgv(argv);
  if (sanitizedArgv.some((argument, argumentIndex) => argument !== argv[argumentIndex])) {
    throw new Error(`Invalid commands[${index}].argv: contains an unredacted secret`);
  }
  const outputDigest = requireSha(command.outputDigest, `commands[${index}].outputDigest`, SHA256_PATTERN);

  return {
    commandId,
    executable,
    argv,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    excerpt,
    outputDigest,
  };
}

function validateResult(value: unknown, index: number): QualityReceiptResult {
  const result = requireRecord(value, `results[${index}]`);
  assertExactKeys(result, ["controlId", "status", "evidence", "reason"], `results[${index}]`);
  const controlId = requireText(result.controlId, `results[${index}].controlId`);
  const status = result.status;
  if (typeof status !== "string" || !isQualityReceiptResultStatus(status)) {
    throw new Error(`Invalid results[${index}].status`);
  }
  let evidence: string | undefined;
  if (hasOwn(result, "evidence")) {
    if (typeof result.evidence !== "string") {
      throw new Error(`Invalid results[${index}].evidence`);
    }
    evidence = result.evidence;
  }

  let reason: string | undefined;
  if (hasOwn(result, "reason")) {
    if (typeof result.reason !== "string") {
      throw new Error(`Invalid results[${index}].reason`);
    }
    reason = result.reason;
  }

  if (status === "pass") {
    if (evidence === undefined || evidence.trim() === "") {
      throw new Error(`Invalid results[${index}].evidence: pass requires evidence`);
    }
    return {
      controlId,
      status,
      evidence,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  return {
    controlId,
    status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function validateQualityReceipt(
  value: unknown,
  expectedIdentity?: QualityReceiptIdentity,
): asserts value is QualityReceipt {
  const receipt = requireRecord(value, "quality receipt");
  if (receipt.namespace !== QUALITY_RECEIPT_NAMESPACE) {
    throw new Error(`Invalid quality receipt namespace: ${String(receipt.namespace)}`);
  }
  if (receipt.version !== QUALITY_RECEIPT_VERSION) {
    throw new Error(`Unsupported quality receipt version: ${String(receipt.version)}`);
  }
  assertExactKeys(receipt, ["namespace", "version", "authority", "identity", "commands", "results", "provenance"], "receipt");

  if (receipt.authority !== "local" && receipt.authority !== "enforced") {
    throw new Error(`Invalid quality receipt authority: ${String(receipt.authority)}`);
  }

  const identity = validateIdentity(receipt.identity, expectedIdentity);
  if (!Array.isArray(receipt.commands)) throw new Error("Invalid quality receipt commands");
  if (!Array.isArray(receipt.results)) throw new Error("Invalid quality receipt results");

  for (let index = 0; index < receipt.commands.length; index += 1) {
    validateCommand(receipt.commands[index], index);
  }
  for (let index = 0; index < receipt.results.length; index += 1) {
    validateResult(receipt.results[index], index);
  }

  const hasProvenance = hasOwn(receipt, "provenance");
  if (receipt.authority === "enforced" && (!hasProvenance || receipt.provenance === undefined)) {
    throw new Error("Enforced quality receipts require provenance");
  }
  if (hasProvenance) {
    if (receipt.provenance === undefined) throw new Error("Invalid quality receipt provenance");
    validateProvenance(receipt.provenance);
  }

  // Keep the explicit identity read above as the single validation path for the
  // expected SHA tuple; this also prevents accidental acceptance of Pi receipts.
  void identity;
}

export function createQualityReceipt(input: QualityReceiptInput): QualityReceipt {
  const authority: unknown = input.authority;
  if (authority !== "local" && authority !== "enforced") {
    throw new Error(`Invalid quality receipt authority: ${String(authority)}`);
  }
  if (input.authority === "enforced" && input.provenance === undefined) {
    throw new Error("Enforced quality receipts require provenance");
  }

  const base = {
    namespace: QUALITY_RECEIPT_NAMESPACE,
    version: QUALITY_RECEIPT_VERSION,
    identity: {
      profile: input.identity.profile,
      baseSha: input.identity.baseSha,
      headSha: input.identity.headSha,
      policyDigest: input.identity.policyDigest,
    },
    commands: input.commands.map(normalizeCommand),
    results: input.results.map(normalizeResult),
  };
  let receipt: QualityReceipt;
  if (input.authority === "enforced") {
    const provenance = input.provenance;
    if (provenance === undefined) throw new Error("Enforced quality receipts require provenance");
    receipt = {
      ...base,
      authority: "enforced",
      provenance: normalizeProvenance(provenance),
    };
  } else {
    receipt = {
      ...base,
      authority: "local",
      ...(input.provenance === undefined ? {} : { provenance: normalizeProvenance(input.provenance) }),
    };
  }

  validateQualityReceipt(receipt);
  return receipt;
}

export function serializeQualityReceipt(receipt: QualityReceipt): string {
  validateQualityReceipt(receipt);
  return canonicalJson(receipt);
}
