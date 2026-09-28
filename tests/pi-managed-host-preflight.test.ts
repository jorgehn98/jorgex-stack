import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const buildCandidate = vi.hoisted(() => vi.fn(async () => ({ package: { name: "jorgex-pi", version: "0.8.36" } })));

vi.mock("../src/lib/pi-release-resolver.js", () => ({
  resolveLatestPiRelease: async () => ({ version: "0.8.36", tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.36.tgz", integrity: "sha512-test" }),
  resolvePiProducerCommit: async () => "a".repeat(40),
  downloadVerifiedPiTarball: async () => ({ path: "/isolated/verified.tgz", bytes: 10, sha256: "b".repeat(64), sha512: "c".repeat(128) }),
}));
vi.mock("../src/lib/pi-release-stage.js", () => ({
  stageVerifiedPiTarball: async () => ({
    stageDir: "/isolated/stage",
    evidence: { lockSha256: "d".repeat(64), treeSha256: "e".repeat(64), dependencies: [] },
    sourceAlias: "file:/isolated/verified.tgz",
  }),
}));
vi.mock("../src/lib/pi-candidate.js", () => ({ buildStagedPiCandidate: buildCandidate }));

const sandboxes: string[] = [];

afterEach(() => {
  buildCandidate.mockClear();
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function managedHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-host-preflight-"));
  sandboxes.push(root);
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const installDir = path.join(agentDir, "install");
  const downloadsDir = path.join(root, "downloads");
  const wrapper = path.join(agentDir, "bin", "pi");
  const piExecutable = path.join(homeDir, "bin", "pi");
  const packageDir = path.join(installDir, "releases", "0.87.1", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.dirname(piExecutable), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(downloadsDir);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  fs.symlinkSync(wrapper, piExecutable);
  fs.writeFileSync(path.join(installDir, "managed-install.json"), JSON.stringify({
    kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1",
    entrypoint: { type: "symlink", path: piExecutable },
  }));
  fs.writeFileSync(path.join(installDir, "current-version"), "0.87.1\n");
  fs.writeFileSync(path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }));
  return { homeDir, agentDir, downloadsDir, piExecutable, installDir };
}

describe.skipIf(process.platform === "win32")("managed Pi host preflight", () => {
  it("passes the managed host version to the candidate builder without running Pi", async () => {
    const paths = managedHost();
    const { preparePiManagedInstall } = await import("../src/lib/pi-install-preflight.js");
    await preparePiManagedInstall(paths, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      run: vi.fn(),
    });
    expect(buildCandidate).toHaveBeenCalledOnce();
    expect(buildCandidate).toHaveBeenCalledWith(expect.objectContaining({ hostVersion: "0.87.1" }));
  });

  it("blocks invalid managed metadata before candidate construction", async () => {
    const paths = managedHost();
    fs.writeFileSync(path.join(paths.installDir, "current-version"), "../outside\n");
    const { preparePiManagedInstall } = await import("../src/lib/pi-install-preflight.js");
    await expect(preparePiManagedInstall(paths, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      run: vi.fn(),
    })).rejects.toThrow(/cannot detect Pi host version: install\/current-version/);
    expect(buildCandidate).not.toHaveBeenCalled();
  });
});
