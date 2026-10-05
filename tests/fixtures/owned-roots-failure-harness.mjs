import fs from "node:fs";
import * as mod from "../helpers/bounded-process.ts";
import { removeTemporaryRoots } from "../helpers/temporary-roots.ts";

/**
 * Owned-roots failure harness: `stop-fail` leaves an owned group with an
 * unverified stop, so root callbacks must NOT run; `rm-fail` makes the root
 * callback itself fail. Both must keep the root and turn a zero exit nonzero.
 */

const [mode, rootDir] = process.argv.slice(2);

fs.mkdirSync(rootDir, { recursive: true });
const roots = [rootDir];
mod.registerOwnedResourceCleanup("owned-roots", () => {
  if (mode === "rm-fail") throw new Error("mock rm failure");
  removeTemporaryRoots(roots);
});

if (mode === "stop-fail") {
  await mod.runBoundedProcess(
    { command: process.execPath, args: ["-e", "process.exit(0)"] },
    {
      cwd: rootDir,
      timeoutMs: 5_000,
      stopOwnProcessGroup: () => ({ ok: false, cause: "mock stop failure" }),
    },
  );
}

process.exitCode = 0;
