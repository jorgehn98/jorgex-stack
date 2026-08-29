import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Options } from "tsup";
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
        import: "./dist/quality-verifier.js",
        types: "./dist/quality-verifier.d.ts",
      },
    });
  });

  it("conserva el bin existente sin añadir otro", () => {
    expect(readPackageJson().bin).toEqual({
      "jorgex-stack": "./dist/cli.js",
    });
  });

  it("mantiene dist en los archivos publicados", () => {
    expect(readPackageJson().files).toContain("dist");
  });
});

describe("T37 tsup contract", () => {
  it("declara semánticamente los aliases de entry y habilita dts", () => {
    const config = readTsupConfig();
    expect(config.entry).toEqual(EXPECTED_ENTRIES);
    expect(config.dts).toBeTruthy();
  });
});
