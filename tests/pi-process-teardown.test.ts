import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "tsup";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("keeps standalone Node alive until owned Pi process teardown resolves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-teardown-"));
  const entry = path.join(root, "probe.ts");
  const pidFile = path.join(root, "owned-pid.json");
  const helper = path.resolve("src/lib/pi-stage-smoke.ts");
  fs.writeFileSync(entry, `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import { stopOwnedPiProcess } from ${JSON.stringify(helper)};
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true, stdio: "ignore"
});
await once(child, "spawn");
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(child.pid));
await stopOwnedPiProcess(child);
process.stdout.write("teardown completed\\n");
`);
  try {
    await build({ entry: [entry], outDir: root, format: ["esm"], platform: "node", target: "node22",
      bundle: true, splitting: false, dts: false, config: false, silent: true, outExtension: () => ({ js: ".mjs" }),
    });
    // Vitest's own handles hide an unreferenced cleanup-delay bug. The
    // subprocess has no unrelated timers or streams keeping its await alive.
    const result = spawnSync(process.execPath, [path.join(root, "probe.mjs")], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("teardown completed\n");
    const pid = JSON.parse(fs.readFileSync(pidFile, "utf8")) as number;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = JSON.parse(fs.readFileSync(pidFile, "utf8")) as number;
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
