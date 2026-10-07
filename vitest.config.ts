import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "./tests",
    // The timeout detects hangs. Hosted runners stall filesystem-heavy tests for seconds
    // (5.3 s seen on a 40 ms test, issue #231), which the 5 s default reports as failures.
    testTimeout: 20_000,
  },
});
