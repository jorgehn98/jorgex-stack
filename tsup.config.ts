import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/lib/quality-verifier.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: {
    entry: {
      cli: "src/cli.ts",
      "quality-verifier": "src/lib/quality-verifier.ts",
    },
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  banner: { js: "#!/usr/bin/env node" },
  esbuildOptions: (options) => {
    options.entryPoints = {
      cli: "src/cli.ts",
      "quality-verifier": "src/lib/quality-verifier.ts",
    };
  },
});
