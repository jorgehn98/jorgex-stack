import fs from "node:fs";
import { runBoundedProcess } from "../helpers/bounded-process.ts";

/**
 * Cancellation harness with a preexisting framework-style handler: the owned
 * group must still be cleaned by the lifecycle, but the framework handler must
 * keep ownership of termination (this process exits 0, not by signal).
 */

const [signal, marker, delay, leaderPidFile, childPidFile, foreignMarkerFile] =
  process.argv.slice(2);

const grandchild =
  "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), Number(process.argv[2]))";

const leader = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2], process.argv[3]], { stdio: 'ignore' });",
  "child.unref();",
  "fs.writeFileSync(process.argv[4], String(process.pid));",
  "fs.writeFileSync(process.argv[5], String(child.pid));",
  "setTimeout(() => {}, 60000);",
].join("\n");

const run = runBoundedProcess(
  {
    command: process.execPath,
    args: ["-e", leader, "--", grandchild, marker, delay, leaderPidFile, childPidFile],
  },
  { cwd: process.cwd(), timeoutMs: 60_000 },
);

const deadline = Date.now() + 10_000;
while (
  (!fs.existsSync(leaderPidFile) || !fs.existsSync(childPidFile)) &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

process.on(signal, () => {
  fs.writeFileSync(foreignMarkerFile, "framework-handler");
  process.exit(0);
});

process.stdout.write(
  `leader=${fs.readFileSync(leaderPidFile, "utf8").trim()} child=${fs.readFileSync(childPidFile, "utf8").trim()}\n`,
);

process.kill(process.pid, signal);
await run;
