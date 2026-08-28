import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  canonicalJson,
  createQualityReceipt,
  QUALITY_RECEIPT_NAMESPACE,
  QUALITY_RECEIPT_VERSION,
  serializeQualityReceipt,
  validateQualityReceipt,
  type QualityReceiptInput,
  type QualityReceiptResult,
} from "../src/lib/quality-receipt.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const POLICY = {
  controls: [{ id: "typecheck", requirement: "required" }],
  profile: "routine",
};
const POLICY_CANONICAL_JSON =
  '{"controls":[{"id":"typecheck","requirement":"required"}],"profile":"routine"}';

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const POLICY_DIGEST = digest(POLICY_CANONICAL_JSON);
const QUALITY_RECEIPT_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../stack/contracts/quality-receipt.v1.schema.json",
);

type JsonSchemaObject = {
  $schema?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  format?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
};

type ReceiptInput = QualityReceiptInput;
type LocalReceiptInput = Extract<ReceiptInput, { authority: "local" }>;
type EnforcedReceiptInput = Extract<ReceiptInput, { authority: "enforced" }>;
type ReceiptInputOverrides =
  | (Partial<Omit<LocalReceiptInput, "authority">> & { authority?: "local" })
  | (Partial<Omit<EnforcedReceiptInput, "authority" | "provenance">> &
      Pick<EnforcedReceiptInput, "authority" | "provenance">);
type Receipt = ReturnType<typeof createQualityReceipt>;
type PassReceiptResult = Extract<QualityReceiptResult, { status: "pass" }>;
type PassHasRequiredEvidence = [PassReceiptResult] extends [never]
  ? false
  : PassReceiptResult extends { evidence: string } ? true : false;

function input(overrides: ReceiptInputOverrides = {}): ReceiptInput {
  const base: Omit<LocalReceiptInput, "authority" | "provenance"> = {
    commands: [{
      commandId: "typecheck",
      executable: "pnpm",
      argv: ["exec", "vitest", "run"],
      exitCode: 0,
      durationMs: 123,
      output: {
        stdout: "quality check completed\n",
        stderr: "",
      },
    }],
    identity: {
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policyDigest: POLICY_DIGEST,
      profile: "routine",
    },
    results: [{
      controlId: "typecheck",
      status: "pass",
      evidence: "exit=0",
    }],
  };

  if (overrides.authority === "enforced") {
    return { ...base, ...overrides, authority: "enforced" };
  }
  return { ...base, ...overrides, authority: "local" };
}

function receipt(overrides: ReceiptInputOverrides = {}): Receipt {
  return createQualityReceipt(input(overrides));
}

function closedObjectSchema(
  schema: JsonSchemaObject | undefined,
  expectedKeys: readonly string[],
  label: string,
): JsonSchemaObject {
  expect(schema, `${label} schema`).toBeDefined();
  if (schema === undefined) throw new Error(`${label} schema is missing`);
  expect(schema.type, `${label} type`).toBe("object");
  expect(schema.additionalProperties, `${label} closure`).toBe(false);
  expect(Object.keys(schema.properties ?? {}).sort(), `${label} fields`).toEqual([...expectedKeys].sort());
  return schema;
}

function requiredKeys(schema: JsonSchemaObject, expectedKeys: readonly string[], label: string): void {
  expect(schema.required, `${label} required fields`).toHaveLength(expectedKeys.length);
  expect(schema.required, `${label} required fields`).toEqual(expect.arrayContaining([...expectedKeys]));
}

const ENFORCED_PROVENANCE = {
  evidenceDigest: digest("external quality evidence"),
  evidenceLocator: "https://ci.example.invalid/runs/42/quality",
  executionId: "quality-run-42",
  issuer: "ci.example.invalid",
};

describe("jorgex.quality.receipt contract", () => {
  it("declara namespace/version y localiza la evidencia por identidad completa", () => {
    const value = receipt();

    expect(QUALITY_RECEIPT_NAMESPACE).toBe("jorgex.quality.receipt");
    expect(QUALITY_RECEIPT_VERSION).toBe(1);
    expect(value).toMatchObject({
      namespace: "jorgex.quality.receipt",
      version: 1,
      identity: {
        profile: "routine",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        policyDigest: POLICY_DIGEST,
      },
    });
    expect(value.results).toHaveLength(1);
    expect(value.commands).toHaveLength(1);
  });

  it("usa JSON canónico estable y digests SHA-256 para policy y output sanitizado", () => {
    expect(canonicalJson({
      z: 1,
      a: { d: 2, c: 1 },
      list: [{ b: 2, a: 1 }],
    })).toBe('{"a":{"c":1,"d":2},"list":[{"a":1,"b":2}],"z":1}');
    expect(canonicalJson(POLICY)).toBe(POLICY_CANONICAL_JSON);

    const value = receipt();
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    expect(value.identity.policyDigest).toBe(POLICY_DIGEST);
    expect(command.outputDigest).toBe(digest('{"stderr":"","stdout":"quality check completed\\n"}'));
    expect(command.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(serializeQualityReceipt(value)).toBe(canonicalJson(value));
    expect(serializeQualityReceipt(value)).not.toContain("\n");
  });

  it("rechaza objetos no JSON en la canonicalización", () => {
    expect(() => canonicalJson(new Date("2026-01-01T00:00:00.000Z"))).toThrow(/canonical|object/i);
  });

  it("rechaza arrays sparse en la canonicalización", () => {
    expect(() => canonicalJson([1, , 3])).toThrow(/array|canonical|sparse/i);
  });

  it("redacta argv, entorno y output sin conservar stdout/stderr completos", () => {
    const rawArgvValue = "ARGV_VALUE_SENTINEL";
    const rawEnvironmentValue = "ENV_VALUE_SENTINEL";
    const rawOutputValue = "OUTPUT_VALUE_SENTINEL";
    const rawOutput = [
      "summary",
      `Authorization: Bearer ${rawOutputValue}`,
      `password=${rawOutputValue}`,
      "x".repeat(2_000),
    ].join("\n");
    const value = receipt({
      commands: [{
        commandId: "sensitive-check",
        executable: "pnpm",
        argv: ["run", "check", "--token", rawArgvValue],
        exitCode: 0,
        durationMs: 456,
        output: { stdout: rawOutput, stderr: "" },
        environment: { QUALITY_ENV: rawEnvironmentValue },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");
    const serialized = serializeQualityReceipt(value);

    expect(serialized).not.toContain(rawArgvValue);
    expect(serialized).not.toContain(rawEnvironmentValue);
    expect(serialized).not.toContain(rawOutputValue);
    expect(serialized).not.toMatch(/"environment"|"stdout"|"stderr"/);
    expect(command).not.toHaveProperty("environment");
    expect(command).not.toHaveProperty("output");
    expect(command).not.toHaveProperty("stdout");
    expect(command).not.toHaveProperty("stderr");
    expect(command.excerpt).not.toBe(rawOutput);
    expect(command.excerpt).not.toContain("x".repeat(2_000));
    expect(command.excerpt.length).toBeLessThan(rawOutput.length);
    expect(command.outputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redacta authorization inline en argv", () => {
    const secret = "AUTHORIZATION_VALUE_SENTINEL";
    const rawLines = [
      `--authorization=${secret}`,
      `--auth=${secret}`,
      `authorization=${secret}`,
    ];
    const value = receipt({
      commands: [{
        commandId: "authorization-check",
        executable: "pnpm",
        argv: ["run", ...rawLines],
        exitCode: 0,
        durationMs: 456,
        output: { stdout: rawLines.join("\n"), stderr: "" },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    const expectedLines = rawLines.map((line) => line.replace(secret, "[REDACTED]"));
    expect(command.argv).toEqual(["run", ...expectedLines]);
  });

  it("redacta authorization inline en output", () => {
    const secret = "AUTHORIZATION_OUTPUT_VALUE_SENTINEL";
    const rawLines = [
      `--authorization=${secret}`,
      `--auth=${secret}`,
      `authorization=${secret}`,
    ];
    const value = receipt({
      commands: [{
        commandId: "authorization-output-check",
        executable: "pnpm",
        argv: ["run", "check"],
        exitCode: 0,
        durationMs: 456,
        output: { stdout: rawLines.join("\n"), stderr: "" },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    const expectedLines = rawLines.map((line) => line.replace(secret, "[REDACTED]"));
    expect(command.excerpt).toBe(expectedLines.join("\n"));
    expect(serializeQualityReceipt(value)).not.toContain(secret);
  });

  it("redacta secretos JSON conocidos y valores multilínea", () => {
    const jsonAuthToken = "JSON_AUTH_TOKEN_SENTINEL";
    const awsSecret = "AWS_SECRET_ACCESS_KEY_SENTINEL";
    const privateKeyBody = "PRIVATE_KEY_BODY_SENTINEL";
    const rawOutput = [
      "{",
      `  "_authToken": "${jsonAuthToken}",`,
      `  "AWS_SECRET_ACCESS_KEY": "${awsSecret}",`,
      '  "PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----',
      privateKeyBody,
      '-----END PRIVATE KEY-----"',
      "}",
    ].join("\n");
    const value = receipt({
      commands: [{
        commandId: "structured-secrets-check",
        executable: "pnpm",
        argv: ["run", "check"],
        exitCode: 0,
        durationMs: 456,
        output: { stdout: rawOutput, stderr: "" },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    const serialized = serializeQualityReceipt(value);
    for (const secret of [jsonAuthToken, awsSecret, privateKeyBody]) {
      expect(command.excerpt).not.toContain(secret);
      expect(serialized).not.toContain(secret);
    }
    expect(command.excerpt).toContain("[REDACTED]");
  });

  it("redacta exactamente los valores de claves JSON sensibles comunes", () => {
    const rawOutput = [
      "{",
      '  "token": "JSON_TOKEN_SENTINEL",',
      '  "password": "JSON_PASSWORD_SENTINEL",',
      '  "apiKey": "JSON_API_KEY_SENTINEL",',
      '  "access_token": "JSON_ACCESS_TOKEN_SENTINEL"',
      "}",
    ].join("\n");
    const expectedExcerpt = [
      "{",
      '  "token": "[REDACTED]",',
      '  "password": "[REDACTED]",',
      '  "apiKey": "[REDACTED]",',
      '  "access_token": "[REDACTED]"',
      "}",
    ].join("\n");
    const value = receipt({
      commands: [{
        commandId: "common-json-secrets-check",
        executable: "pnpm",
        argv: ["run", "check"],
        exitCode: 0,
        durationMs: 456,
        output: { stdout: rawOutput, stderr: "" },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    expect(command.excerpt).toBe(expectedExcerpt);
    expect(serializeQualityReceipt(value)).not.toContain("JSON_TOKEN_SENTINEL");
    expect(serializeQualityReceipt(value)).not.toContain("JSON_PASSWORD_SENTINEL");
    expect(serializeQualityReceipt(value)).not.toContain("JSON_API_KEY_SENTINEL");
    expect(serializeQualityReceipt(value)).not.toContain("JSON_ACCESS_TOKEN_SENTINEL");
  });

  it.each(["argv", "excerpt"] as const)("rechaza al validar y serializar un receipt mutado con secreto en %s", (field) => {
    const value = receipt();
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    const tamperedCommand = field === "argv"
      ? {
        ...command,
        argv: [...command.argv, "--token", "ARGV_MUTATED_SECRET_SENTINEL"],
      }
      : {
        ...command,
        excerpt: "Authorization: Bearer EXCERPT_MUTATED_SECRET_SENTINEL",
      };

    const tampered = { ...value, commands: [tamperedCommand] };
    expect(() => validateQualityReceipt(tampered)).toThrow();
    expect(() => serializeQualityReceipt(tampered)).toThrow();
  });

  it("rechaza argv sparse", () => {
    const command = input().commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");
    const sparseArgv = [...command.argv];
    delete sparseArgv[1];

    expect(() => createQualityReceipt(input({
      commands: [{ ...command, argv: sparseArgv }],
    }))).toThrow(/argv|sparse/i);
  });

  it("limita excerpt a 512 code points sin cortar un surrogate", () => {
    const output = `${"x".repeat(511)}😀tail`;
    const value = receipt({
      commands: [{
        commandId: "unicode-check",
        executable: "pnpm",
        argv: ["run", "check"],
        exitCode: 0,
        durationMs: 456,
        output: { stdout: output, stderr: "" },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    expect(command.excerpt).toBe(`${"x".repeat(511)}😀`);
    expect(command.excerpt.endsWith("😀")).toBe(true);
    expect(Array.from(command.excerpt)).toHaveLength(512);
  });

  it("calcula el digest del output saneado completo aunque el excerpt supere 512", () => {
    const secret = "OUTPUT_DIGEST_SECRET_SENTINEL";
    const stdout = `${"output-".repeat(100)}\napiKey=${secret}`;
    const sanitizedStdout = `${"output-".repeat(100)}\napiKey=[REDACTED]`;
    const value = receipt({
      commands: [{
        commandId: "digest-check",
        executable: "pnpm",
        argv: ["run", "check"],
        exitCode: 0,
        durationMs: 456,
        output: { stdout, stderr: "" },
      }],
    });
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    expect(command.outputDigest).toBe(digest(canonicalJson({
      stderr: "",
      stdout: sanitizedStdout,
    })));
  });

  it("rechaza un excerpt ausente", () => {
    const value = receipt();
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");
    const { excerpt: _excerpt, ...commandWithoutExcerpt } = command;

    expect(() => validateQualityReceipt({
      ...value,
      commands: [commandWithoutExcerpt],
    })).toThrow(/excerpt/i);
  });

  it("rechaza un excerpt que no sea string", () => {
    const value = receipt();
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");

    expect(() => validateQualityReceipt({
      ...value,
      commands: [{ ...command, excerpt: 123 }],
    })).toThrow(/excerpt/i);
  });

  it("expone profile como una unión pública de cuatro valores", () => {
    expectTypeOf<ReceiptInput["identity"]["profile"]>().toEqualTypeOf<
      "routine" | "elevated" | "high" | "release"
    >();
  });

  it("no permite un QualityReceiptInput enforced sin provenance", () => {
    // @ts-expect-error Enforced quality receipts require provenance.
    const invalidEnforced: QualityReceiptInput = {
      authority: "enforced",
      commands: [],
      identity: {
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        policyDigest: POLICY_DIGEST,
        profile: "routine",
      },
      results: [],
    };

    void invalidEnforced;
  });

  it("modela autoridad y resultados como uniones discriminadas", () => {
    expectTypeOf<PassHasRequiredEvidence>().toEqualTypeOf<true>();
  });

  it("permite un receipt local sin provenance, pero exige provenance externa para enforced", () => {
    const local = receipt();
    expect(local.authority).toBe("local");
    expect(local.provenance).toBeUndefined();
    expect(() => validateQualityReceipt(local, local.identity)).not.toThrow();

    const enforced = receipt({
      authority: "enforced",
      provenance: ENFORCED_PROVENANCE,
    });
    expect(() => validateQualityReceipt(enforced, enforced.identity)).not.toThrow();
  });

  it.each([
    ["sin provenance", undefined, /provenance|enforced/i],
    ["sin issuer", { ...ENFORCED_PROVENANCE, issuer: undefined }, /issuer/i],
    ["sin executionId", { ...ENFORCED_PROVENANCE, executionId: undefined }, /executionId/i],
    ["sin locator", { ...ENFORCED_PROVENANCE, evidenceLocator: undefined }, /locator/i],
    [
      "locator con espacios",
      { ...ENFORCED_PROVENANCE, evidenceLocator: "https://ci.example.invalid/runs/42/quality run" },
      /locator/i,
    ],
    ["sin evidence digest", { ...ENFORCED_PROVENANCE, evidenceDigest: undefined }, /digest/i],
  ])("rechaza enforced %s", (_caseName, provenance, expected) => {
    const valid = receipt({ authority: "enforced", provenance: ENFORCED_PROVENANCE });
    const value = { ...valid, provenance };

    expect(() => validateQualityReceipt(value)).toThrow(expected);
  });

  it("rechaza en runtime una URL inválida aunque parezca HTTP(S)", () => {
    const valid = receipt({ authority: "enforced", provenance: ENFORCED_PROVENANCE });
    const tampered = {
      ...valid,
      provenance: {
        ...valid.provenance,
        evidenceLocator: "https://[invalid",
      },
    };

    expect(() => validateQualityReceipt(tampered)).toThrow(/evidenceLocator/i);
  });

  it("rechaza un resultado pass sin evidence", () => {
    const value = receipt();
    const result = value.results[0];
    if (result === undefined) throw new Error("receipt fixture has no result");
    const { evidence: _evidence, ...resultWithoutEvidence } = result;

    expect(() => validateQualityReceipt({
      ...value,
      results: [resultWithoutEvidence],
    })).toThrow(/evidence/i);
  });

  it.each([
    ["baseSha", { baseSha: "c".repeat(40) }, /baseSha/i],
    ["headSha", { headSha: "c".repeat(40) }, /headSha/i],
    ["policyDigest", { policyDigest: "c".repeat(64) }, /policyDigest/i],
  ])("rechaza mismatch de identidad en %s", (_field, change, expected) => {
    const value = receipt();
    const tampered = {
      ...value,
      identity: { ...value.identity, ...change },
    };

    expect(() => validateQualityReceipt(tampered, value.identity)).toThrow(expected);
  });

  it("rechaza un digest de output inválido aunque la identidad coincida", () => {
    const value = receipt();
    const command = value.commands[0];
    if (command === undefined) throw new Error("receipt fixture has no command");
    const tampered = {
      ...value,
      commands: [{ ...command, outputDigest: "not-a-sha256" }],
    };

    expect(() => validateQualityReceipt(tampered, value.identity)).toThrow(/digest/i);
  });

  it("no confunde el handoff final ni el receipt de instalación Pi con calidad", () => {
    const handoff = {
      status: "done",
      decision: "pass",
      confidence: 1,
      summary: "handoff fixture",
      risks: [],
      next_steps: [],
      delegations: [],
    };
    const piInstallationReceipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { version: "0.4.0", source: "fixture" },
        tarball: { size: 1, sha256: "a".repeat(64), sha512: "b".repeat(128) },
        provenance: { commit: "c".repeat(40) },
      },
      scope: { kind: "target-dir", codingAgentDir: "C:\\fixture\\pi-agent" },
      engram: { binary: "fixture-engram" },
    };

    expect(() => validateQualityReceipt(handoff)).toThrow(/namespace/i);
    expect(() => validateQualityReceipt(piInstallationReceipt)).toThrow(/namespace/i);

    const value = receipt();
    expect(value.namespace).toBe(QUALITY_RECEIPT_NAMESPACE);
    expect(value.namespace).not.toBe("jorgex.pi.receipt");
    expect(value).not.toHaveProperty("candidate");
    expect(value).not.toHaveProperty("scope");
    expect(value).not.toHaveProperty("engram");
  });

  it("exige el JSON Schema canónico v1 como proyección cerrada de la API", () => {
    const schemaExists = fs.existsSync(QUALITY_RECEIPT_SCHEMA_PATH);
    expect(schemaExists).toBe(true);
    if (!schemaExists) return;

    const schema = JSON.parse(fs.readFileSync(QUALITY_RECEIPT_SCHEMA_PATH, "utf8")) as JsonSchemaObject;
    const local = receipt();
    const enforced = receipt({ authority: "enforced", provenance: ENFORCED_PROVENANCE });
    const command = local.commands[0];
    const result = local.results[0];
    const provenance = enforced.provenance;
    if (command === undefined || result === undefined || provenance === undefined) {
      throw new Error("receipt fixture is incomplete");
    }

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const root = closedObjectSchema(schema, Object.keys(enforced), "receipt");
    requiredKeys(root, ["namespace", "version", "authority", "identity", "commands", "results"], "receipt");
    expect(root.required).not.toContain("provenance");
    expect(root.properties?.namespace).toMatchObject({ type: "string", const: QUALITY_RECEIPT_NAMESPACE });
    expect(root.properties?.version).toMatchObject({ type: "integer", const: QUALITY_RECEIPT_VERSION });
    expect(root.properties?.authority).toMatchObject({ type: "string", enum: ["local", "enforced"] });

    const identity = closedObjectSchema(root.properties?.identity, Object.keys(local.identity), "identity");
    requiredKeys(identity, Object.keys(local.identity), "identity");

    expect(root.properties?.commands).toMatchObject({ type: "array" });
    const commandSchema = closedObjectSchema(root.properties?.commands?.items, Object.keys(command), "commands.items");
    requiredKeys(commandSchema, Object.keys(command), "commands.items");

    expect(root.properties?.results).toMatchObject({ type: "array" });
    const resultSchema = closedObjectSchema(
      root.properties?.results?.items,
      ["controlId", "status", "evidence", "reason"],
      "results.items",
    );
    requiredKeys(resultSchema, ["controlId", "status"], "results.items");

    const provenanceSchema = closedObjectSchema(root.properties?.provenance, Object.keys(provenance), "provenance");
    requiredKeys(provenanceSchema, Object.keys(provenance), "provenance");
    expect(provenanceSchema.properties?.evidenceLocator).toMatchObject({
      type: "string",
      format: "uri",
      pattern: "^https?://\\S+$",
    });
  });
});
