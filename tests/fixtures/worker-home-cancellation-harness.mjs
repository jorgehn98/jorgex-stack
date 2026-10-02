import fs from "node:fs";
import * as mod from "../helpers/bounded-process.ts";
import { prepareRepoBuildRun, removeTemporaryRoots } from "../helpers/pnpm-tooling.ts";

/**
 * Authoritative ownership harness: uses the real build preparation with an
 * inert fake pnpm, creates its OWN real HOME/root plus a build child and
 * grandchild, reports them through handshake files, then cancels itself. The
 * owned-resource lifecycle must stop the children and remove that HOME before
 * the parent test touches anything.
 *
 * The optional registration keeps this same case reproducible against a helper
 * without the callback seam (the HOME then leaks and the parent test fails).
 */

const [mode, signal, repoRoot, homeHandshake, leaderPidFile, childPidFile, foreignMarkerFile] =
  process.argv.slice(2);

const roots = [];
const register = mod.registerOwnedResourceCleanup;
if (typeof register === "function") {
  register("worker-owned-roots", () => removeTemporaryRoots(roots));
}

const prepared = await prepareRepoBuildRun({
  repoRoot,
  env: process.env,
  runProcess: mod.runBoundedProcess,
  versionCheckTimeoutMs: 5_000,
  registerTempRoot: (root) => roots.push(root),
});
fs.writeFileSync(homeHandshake, prepared.root);

const buildMarker = `${homeHandshake}.leak`;
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

const run = mod.runBoundedProcess(
  {
    command: process.execPath,
    args: ["-e", leader, "--", grandchild, buildMarker, "1500", leaderPidFile, childPidFile],
  },
  { cwd: prepared.root, timeoutMs: 60_000 },
);

const deadline = Date.now() + 10_000;
while (
  (!fs.existsSync(leaderPidFile) || !fs.existsSync(childPidFile)) &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

process.stdout.write(
  `home=${prepared.root} leader=${fs.readFileSync(leaderPidFile, "utf8").trim()} child=${fs.readFileSync(childPidFile, "utf8").trim()}\n`,
);

if (mode === "foreign") {
  process.on(signal, () => {
    fs.writeFileSync(foreignMarkerFile, "framework-handler");
    process.exit(0);
  });
}

process.kill(process.pid, signal);
await run;
