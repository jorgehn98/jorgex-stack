import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { stageVerifiedPiTarball } from "../src/lib/pi-release-stage.js";
import { materializeStagedPiRuntimeDependencies } from "../src/lib/pi-staged-lock.js";
import { smokeLinkedPiRuntime } from "../src/lib/pi-stage-smoke.js";

const piExecutable = process.env.JORGEX_PI_BIN;
const artifactPath = process.env.JORGEX_PI_LIVE_ARTIFACT;
const version = process.env.JORGEX_PI_LIVE_VERSION;

it.skipIf(!piExecutable || !artifactPath || !version)("real Pi loads the promoted-link topology only with its verified local runtime copies", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-layout-live-"));
  try {
    const agentDir = path.join(homeDir, "agent");
    fs.mkdirSync(agentDir);
    const bytes = fs.readFileSync(artifactPath!);
    const artifact = {
      path: path.resolve(artifactPath!), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    };
    const release = { version: version!, tarballUrl: `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const staged = await stageVerifiedPiTarball({ homeDir, agentDir, piExecutable: piExecutable!, artifact, release }, (executable, args, options) => {
      const result = spawnSync(executable, args, { ...options, encoding: "utf8", timeout: 120_000 });
      return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
    });
    const packageRoot = path.join(staged.stageDir, "npm", "node_modules", "jorgex-pi");
    // Restore the old topology to prove the same real loader goes RED.
    fs.rmSync(path.join(packageRoot, "node_modules"), { recursive: true });
    const smoke = { piExecutable: piExecutable!, packageRoot, scratchRoot: path.dirname(staged.stageDir) };
    await expect(smokeLinkedPiRuntime(smoke)).rejects.toThrow(/permission load failure|Cannot find module/);
    materializeStagedPiRuntimeDependencies({ stageDir: staged.stageDir, tarballPath: artifact.path, release });
    const ready = await smokeLinkedPiRuntime(smoke);
    expect(ready.commands).toEqual(expect.arrayContaining(["permission-system", "subagents", "goal", "websearch"]));
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, 240_000);
