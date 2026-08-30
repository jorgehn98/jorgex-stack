import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import { build } from "tsup";
import { describe, expect, it } from "vitest";
import type { Options } from "tsup";
import { samePath } from "../src/lib/paths.js";
import tsupConfig from "../tsup.config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(ROOT, "package.json");

const EXPECTED_ENTRIES = {
  cli: "src/cli.ts",
  "quality-verifier": "src/lib/quality-verifier.ts",
};

type PackageJson = {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
};

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8")) as PackageJson;
}

function readTsupConfig(): Options {
  if (typeof tsupConfig === "function") throw new Error("Expected static tsup config");
  const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig;
  if (config === undefined) throw new Error("Missing tsup config");
  return config;
}

async function buildQualityVerifierArtifacts(root: string): Promise<string> {
  const outputDir = path.join(root, "dist");
  fs.mkdirSync(outputDir);
  const config = readTsupConfig();
  await build({
    ...config,
    config: false,
    entry: {
      "quality-verifier": path.join(ROOT, EXPECTED_ENTRIES["quality-verifier"]),
    },
    outDir: outputDir,
    tsconfig: path.join(ROOT, "tsconfig.json"),
    silent: true,
  });

  return outputDir;
}

function stagePackage(root: string, outputDir: string): string {
  const packageDir = path.join(root, "node_modules", "jorgex-stack");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.copyFileSync(PACKAGE_PATH, path.join(packageDir, "package.json"));
  fs.cpSync(outputDir, path.join(packageDir, "dist"), { recursive: true });
  return packageDir;
}

async function exerciseGeneratedRuntime(root: string): Promise<void> {
  const consumerPath = path.join(root, "runtime-consumer.mjs");
  fs.writeFileSync(consumerPath, `
import { subjectDigestFor, verifyExternalQualityReceipt } from "jorgex-stack/quality-verifier";

const result = await verifyExternalQualityReceipt({}, undefined);
if (typeof subjectDigestFor !== "function"
  || typeof verifyExternalQualityReceipt !== "function"
  || result.status !== "fail"
  || result.rerunRequired !== false) {
  throw new Error("Generated quality-verifier artifact did not satisfy its runtime contract");
}
`);
  await import(pathToFileURL(consumerPath).href);
}

function compileTypeScriptConsumer(root: string, packageDir: string): string[] {
  const consumerPath = path.join(root, "consumer.mts");
  fs.writeFileSync(consumerPath, `
import {
  subjectDigestFor,
  verifyExternalQualityReceipt,
  type ExternalQualityVerifierDeps,
  type ExternalQualityVerifierInput,
  type ExternalQualityVerifierResult,
} from "jorgex-stack/quality-verifier";

declare const input: ExternalQualityVerifierInput;

const deps: ExternalQualityVerifierDeps = {
  resolveEvidence: async () => ({ status: "unavailable" as const, retryable: true }),
  authenticateAttestation: async () => ({ authenticated: false }),
  now: () => "2026-08-29T12:00:00.000Z",
};

const result: Promise<ExternalQualityVerifierResult> =
  verifyExternalQualityReceipt(input, deps);
const subjectDigest: string = subjectDigestFor(input.receipt);
void subjectDigest;

void result.then((outcome) => {
  if (outcome.status === "pass" || outcome.status === "fail") {
    const rerunRequired: false = outcome.rerunRequired;
    return rerunRequired;
  }

  const rerunRequired: boolean = outcome.rerunRequired;
  return rerunRequired;
});
`);

  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const resolved = ts.resolveModuleName(
    "jorgex-stack/quality-verifier",
    consumerPath,
    options,
    ts.sys,
  ).resolvedModule;
  const expectedDtsPath = path.join(packageDir, "dist", "quality-verifier.d.ts");
  expect(samePath(resolved?.resolvedFileName ?? "", expectedDtsPath)).toBe(true);

  const program = ts.createProgram([consumerPath], options);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("T37 setup control", () => {
  it("parsea package.json antes de comprobar el contrato de publicación", () => {
    const packageJson = readPackageJson();

    expect(packageJson.name).toBe("jorgex-stack");
  });
});

describe("T37 package contract", () => {
  it("publica la versión manual 1.6.0", () => {
    expect(readPackageJson().version).toBe("1.6.0");
  });

  it("expone solo el subpath tipado quality-verifier, sin root export", () => {
    expect(readPackageJson().exports).toEqual({
      "./quality-verifier": {
        types: "./dist/quality-verifier.d.ts",
        import: "./dist/quality-verifier.js",
      },
    });
  });

  it("ordena types antes de import para resolvers condicionales", () => {
    const qualityVerifierExport = readPackageJson().exports?.["./quality-verifier"];
    expect(qualityVerifierExport).toBeDefined();
    expect(Object.keys(qualityVerifierExport as Record<string, unknown>)).toEqual([
      "types",
      "import",
    ]);
  });

  it("conserva el bin existente sin añadir otro", () => {
    expect(readPackageJson().bin).toEqual({
      "jorgex-stack": "./dist/cli.js",
    });
  });

  it("mantiene dist en los archivos publicados", () => {
    expect(readPackageJson().files).toContain("dist");
  });

  it("consume los artefactos JS y d.ts generados sin depender de dist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-quality-verifier-package-"));
    try {
      const outputDir = await buildQualityVerifierArtifacts(root);
      const packageDir = stagePackage(root, outputDir);
      const generatedJs = path.join(packageDir, "dist", "quality-verifier.js");
      const generatedDts = path.join(packageDir, "dist", "quality-verifier.d.ts");

      expect(fs.existsSync(generatedJs)).toBe(true);
      expect(fs.existsSync(generatedDts)).toBe(true);
      await exerciseGeneratedRuntime(root);
      expect(compileTypeScriptConsumer(root, packageDir)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("T37 tsup contract", () => {
  it("declara semánticamente los aliases de entry y habilita dts", () => {
    const config = readTsupConfig();
    expect(config.entry).toEqual(EXPECTED_ENTRIES);
    expect(config.dts).toBeTruthy();
  });
});
