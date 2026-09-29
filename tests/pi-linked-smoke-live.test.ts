import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { stageVerifiedPiTarball } from "../src/lib/pi-release-stage.js";
import { materializeStagedPiRuntimeDependencies } from "../src/lib/pi-staged-lock.js";
import { smokeLinkedPiRuntime } from "../src/lib/pi-stage-smoke.js";
import { runPiStageProcess } from "../src/lib/pi-stage-process.js";

const piExecutable = process.env.JORGEX_PI_BIN ?? (process.env.PI_TEST_HOST
  ? path.join(process.env.PI_TEST_HOST, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi")
  : undefined);
const artifactPath = process.env.JORGEX_PI_LIVE_ARTIFACT;
const version: string | undefined = process.env.JORGEX_PI_LIVE_VERSION ?? (process.env.PI_TEST_CANDIDATE
  ? JSON.parse(fs.readFileSync(process.env.PI_TEST_CANDIDATE, "utf8")).version as string
  : undefined);

it.skipIf(!piExecutable || !artifactPath || !version)("real Pi loads the promoted-link topology only with its verified local runtime copies", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-layout-live-"));
  let failed = false;
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
    const staged = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable: piExecutable!, artifact, release },
      runPiStageProcess,
    );
    const packageRoot = path.join(staged.stageDir, "npm", "node_modules", "jorgex-pi");
    // Restore the old topology to prove the same real loader goes RED.
    fs.rmSync(path.join(packageRoot, "node_modules"), { recursive: true });
    const smoke = { piExecutable: piExecutable!, packageRoot, scratchRoot: path.dirname(staged.stageDir) };
    await expect(smokeLinkedPiRuntime(smoke)).rejects.toThrow(/permission load failure|Cannot find module/);
    materializeStagedPiRuntimeDependencies({ stageDir: staged.stageDir, tarballPath: artifact.path, release });
    const ready = await smokeLinkedPiRuntime(smoke);
    expect(ready.commands).toEqual(expect.arrayContaining(["permission-system", "subagents", "goal", "websearch"]));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) console.error(`Failed Pi live stage retained for diagnosis: ${homeDir}`);
    else fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, process.platform === "win32" ? 420_000 : 240_000);
