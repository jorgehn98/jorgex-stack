import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
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
