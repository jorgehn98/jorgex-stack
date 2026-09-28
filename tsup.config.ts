import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "browser-playwright": "src/browser-playwright.ts",
    "pi-ci-artifact": "src/lib/pi-ci-artifact.ts",
    "quality-verifier": "src/lib/quality-verifier.ts",
  },
  format: ["esm"],
  splitting: false,
  target: "node22",
  clean: true,
  dts: {
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  banner: { js: "#!/usr/bin/env node" },
});
