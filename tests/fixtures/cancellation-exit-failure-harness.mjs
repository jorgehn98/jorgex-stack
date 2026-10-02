import { runBoundedProcess } from "../helpers/bounded-process.ts";

/**
 * Final-cleanup-failure harness: registers an owned group whose stop cannot be
 * verified, then exits with the requested code. The lifecycle's exit retry must
 * report the failure and turn a zero exit into a nonzero one without replacing
 * an existing nonzero code.
 */

const exitCode = Number(process.argv[2] ?? "0");

const result = await runBoundedProcess(
  { command: process.execPath, args: ["-e", "process.exit(0)"] },
  {
    cwd: process.cwd(),
    timeoutMs: 5_000,
    stopOwnProcessGroup: () => ({ ok: false, cause: "mock cleanup failure" }),
  },
);

process.stdout.write(`pid=${result.treeCleanupError?.pid ?? "none"}\n`);
process.exitCode = exitCode;
