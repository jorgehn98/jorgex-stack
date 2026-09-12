import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPiFromVerifiedTarball, PI_RUNTIME_CANDIDATE } from "../src/lib/pi-runtime.js";
import { filterProjectedPiPackage, planPiPackageLifecycle } from "../src/lib/pi-package-lifecycle.js";
import { runPiProjectionLifecycle } from "../src/lib/pi-projection-lifecycle.js";
import { stackRoot } from "../src/lib/paths.js";

describe("Pi installed object alias through projection and subsequent operations", () => {
  it("completes the real empty-filter object shape and remains healthy and idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-alias-projection-"));
    try {
      const agentDir = path.join(root, "pi-agent");
      const settingsFile = path.join(agentDir, "settings.json");
      const engramBin = path.join(root, "engram");
      const artifact = path.join(root, "downloads", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`);
      const files = new Map<string, string>([[settingsFile, JSON.stringify({
        theme: "custom",
        packages: ["npm:foreign@1.0.0", { source: `npm:jorgex-pi@file:${artifact}`, skills: [], prompts: [] }],
      })]]);
      let packageReceipt = "";
      const installed = installPiFromVerifiedTarball({
        targetDir: root, piExecutable: path.join(root, "pi"), engramBin,
        candidate: { source: PI_RUNTIME_CANDIDATE.package.source, ...PI_RUNTIME_CANDIDATE.tarball },
      }, {
        download: () => ({ path: artifact, ...PI_RUNTIME_CANDIDATE.tarball }),
        backupSettings: () => {},
        run: (call) => ({ exitCode: 0, stderr: "", stdout: call.args[0] === "install" ? "" : JSON.stringify({
          schemaVersion: 1, command: "doctor", ok: true,
          package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version,
            root: path.join(agentDir, "npm", "node_modules", "jorgex-pi") },
          result: { healthy: true },
        }) + "\n" }),
        readSettings: () => files.get(settingsFile)!,
        rewriteSettings: (content) => { files.set(settingsFile, content); },
        writeReceiptAtomic: (content) => { packageReceipt = content; },
      });
      expect(installed.kind).toBe("installed");
      expect(JSON.parse(files.get(settingsFile)!)).toEqual({ theme: "custom", packages: [
        "npm:foreign@1.0.0", { source: PI_RUNTIME_CANDIDATE.package.source, skills: [], prompts: [] },
      ] });
      const input = {
        operation: "install" as const,
        scope: { kind: "target-dir" as const, home: path.join(root, "home"), codingAgentDir: agentDir,
          receiptFile: path.join(root, "projection.json") },
        packageSource: PI_RUNTIME_CANDIDATE.package.source, stackDir: stackRoot(), engramBin,
        playwrightCliEnabled: false,
      };
      const deps = {
        readText: (file: string) => files.get(file) ?? null,
        backup: () => {},
        writeText: (file: string, content: string) => { files.set(file, content); },
        copyFile: (source: string, target: string) => { files.set(target, fs.readFileSync(source, "utf8")); },
        removeFile: (file: string) => { files.delete(file); },
        readManifest: () => ({ runtimes: {} }),
      };
      expect(runPiProjectionLifecycle(input, deps).kind).toBe("installed");
      expect(runPiProjectionLifecycle({ ...input, operation: "sync" }, deps)).toEqual({ kind: "synced", changed: false });
      expect(runPiProjectionLifecycle({ ...input, operation: "doctor" }, deps)).toEqual({ kind: "healthy" });
      expect(planPiPackageLifecycle({
        candidate: PI_RUNTIME_CANDIDATE, observedTarball: PI_RUNTIME_CANDIDATE.tarball,
        pi: { executable: path.join(root, "pi"), version: PI_RUNTIME_CANDIDATE.pi.testedVersions[0]!,
          packageRunner: path.join(agentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs"),
          settingsJson: files.get(settingsFile)! },
        engramBin, receiptJson: packageReceipt,
        scope: { kind: "target-dir", codingAgentDir: agentDir, receiptPath: path.join(root, "package.json"),
          environment: { PI_CODING_AGENT_DIR: agentDir, ENGRAM_BIN: engramBin } },
      }).kind).toBe("ready");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not erase foreign package filters or metadata to claim managed ownership", () => {
    const settings = JSON.stringify({ packages: [{ source: PI_RUNTIME_CANDIDATE.package.source,
      skills: ["custom-skill"], prompts: ["custom-prompt"], custom: true }] });
    expect(filterProjectedPiPackage(settings, PI_RUNTIME_CANDIDATE.package.source)).toBeNull();
  });
});
