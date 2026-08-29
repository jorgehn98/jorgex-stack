import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const TSUP_CONFIG_PATH = path.join(ROOT, "tsup.config.ts");

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
  it("incluye cli y quality-verifier como entradas", () => {
    const config = fs.readFileSync(TSUP_CONFIG_PATH, "utf8");

    expect(config).toMatch(
      /entry:\s*\[[\s\S]*["']src\/cli\.ts["'][\s\S]*["']src\/lib\/quality-verifier\.ts["'][\s\S]*\]/,
    );
  });

  it("habilita la generación de declaraciones", () => {
    const config = fs.readFileSync(TSUP_CONFIG_PATH, "utf8");

    expect(config).toMatch(/\bdts:\s*(?:true|\{)/);
  });
});
