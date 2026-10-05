import { expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
it("accepts four native runtimes and an isolated target", () => {
  expect(parseCliArgs(["install", "--agents", "pi", "--target-dir=/var/tmp/isolated", "--dry-run"]).flags).toMatchObject({ agents: ["pi"], targetDir: "/var/tmp/isolated", dryRun: true });
});
it.each(["--playwright", "--devtools", "--browser-control-service", "--engram-typebox-compat", "--mode", "--subagent-concurrency"])("rejects retired flag %s", (flag) => {
  expect(parseCliArgs(["install", flag]).action).toBe("unknown-flags");
});
it("does not retain the managed browser dispatcher or public sync", () => {
  expect(parseCliArgs(["browser", "control"]).action).toBe("unknown");
  expect(parseCliArgs(["sync"]).action).toBe("unknown");
});
it("does not confuse help, version and read-only checks with installation", () => {
  expect(parseCliArgs(["--help"]).action).toBe("help");
  expect(parseCliArgs(["--version"]).action).toBe("version");
  expect(parseCliArgs(["update", "--check"]).flags.check).toBe(true);
});
