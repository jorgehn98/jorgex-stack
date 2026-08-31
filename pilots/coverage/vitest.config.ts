import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/quality-policy.test.ts",
      "tests/quality-receipt.test.ts",
      "tests/quality-verifier.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/quality-policy.ts",
        "src/lib/quality-receipt.ts",
        "src/lib/quality-verifier.ts",
      ],
      reporter: ["text", "json", "lcov"],
      reportsDirectory: "coverage/quality",
    },
  },
});
