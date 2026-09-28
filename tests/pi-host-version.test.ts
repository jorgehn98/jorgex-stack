import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPiRuntime } from "../src/lib/pi-runtime.js";

const originalPath = process.env.PATH;
const sandboxes: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function managedPiFixture(): { root: string; agentDir: string; marker: string; executable: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-managed-pi-host-"));
  sandboxes.push(root);
  const agentDir = path.join(root, "agent");
  const binDir = path.join(root, "bin");
  const wrapper = path.join(agentDir, "bin", "pi");
  const executable = path.join(binDir, "pi");
  const marker = path.join(root, "executed");
  const releaseDir = path.join(agentDir, "install", "releases", "0.87.1");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(releaseDir, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  fs.symlinkSync(wrapper, executable);
  fs.writeFileSync(path.join(agentDir, "install", "current-version"), "0.87.1\n");
  fs.writeFileSync(path.join(agentDir, "install", "managed-install.json"), JSON.stringify({
    kind: "pi-managed-install",
    schemaVersion: 1,
    layout: "releases-v1",
    entrypoint: { type: "symlink", path: executable },
  }));
  fs.writeFileSync(path.join(releaseDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }));
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return { root, agentDir, marker, executable };
}

describe.skipIf(process.platform === "win32")("Pi host version detection", () => {
  it("recognizes the official managed launcher without executing Pi", () => {
    const fixture = managedPiFixture();
    expect(detectPiRuntime()).toMatchObject({ installed: true, executable: fixture.executable, version: "0.87.1" });
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it("rejects a release version that differs from the installed Pi package", () => {
    const fixture = managedPiFixture();
    const manifest = path.join(fixture.agentDir, "install", "releases", "0.87.1", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    fs.writeFileSync(manifest, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.0" }));
    expect(detectPiRuntime().version).toBeNull();
  });

  it("rejects path traversal in the managed current-version", () => {
    const fixture = managedPiFixture();
    fs.writeFileSync(path.join(fixture.agentDir, "install", "current-version"), "../outside\n");
    expect(detectPiRuntime()).toMatchObject({
      version: null, versionDiagnostic: expect.stringMatching(/install\/current-version.*inválida/),
    });
  });

  it("rejects a managed entrypoint that does not name the detected executable", () => {
    const fixture = managedPiFixture();
    fs.writeFileSync(path.join(fixture.agentDir, "install", "managed-install.json"), JSON.stringify({
      kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1",
      entrypoint: { type: "symlink", path: path.join(fixture.root, "other", "pi") },
    }));
    expect(detectPiRuntime()).toMatchObject({
      version: null, versionDiagnostic: expect.stringMatching(/managed-install\.json.*entrypoint/),
    });
  });

  it("reports corrupt managed-install metadata without executing Pi", () => {
    const fixture = managedPiFixture();
    fs.writeFileSync(path.join(fixture.agentDir, "install", "managed-install.json"), "{invalid json");
    expect(detectPiRuntime()).toMatchObject({
      version: null, versionDiagnostic: expect.stringMatching(/install\/managed-install\.json/),
    });
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it("does not fall back to an ancestor npm manifest when managed metadata is invalid", () => {
    const fixture = managedPiFixture();
    const ancestorPackage = path.join(fixture.agentDir, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(ancestorPackage, { recursive: true });
    fs.writeFileSync(path.join(ancestorPackage, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
    fs.writeFileSync(path.join(fixture.agentDir, "install", "current-version"), "../outside\n");
    expect(detectPiRuntime().version).toBeNull();
  });

  it("rejects a managed release directory that is a symlink", () => {
    const fixture = managedPiFixture();
    const releaseDir = path.join(fixture.agentDir, "install", "releases", "0.87.1");
    const alternate = path.join(fixture.root, "alternate-release");
    fs.renameSync(releaseDir, alternate);
    fs.symlinkSync(alternate, releaseDir);
    expect(detectPiRuntime().version).toBeNull();
  });

  it("keeps direct npm Pi installations detectable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-npm-pi-host-"));
    sandboxes.push(root);
    const binDir = path.join(root, "bin");
    const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }));
    fs.writeFileSync(path.join(packageDir, "dist", "cli.js"), "");
    const executable = path.join(binDir, "pi");
    fs.symlinkSync(path.join(packageDir, "dist", "cli.js"), executable);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    expect(detectPiRuntime()).toMatchObject({ installed: true, executable, version: "0.87.1" });
  });
});

it.skipIf(process.platform !== "win32")("keeps npm Pi .cmd hosts detectable on Windows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-npm-pi-win-"));
  sandboxes.push(root);
  const binDir = path.join(root, "node_modules", ".bin");
  const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "pi.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1" }));
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  expect(detectPiRuntime()).toMatchObject({
    installed: true, executable: path.join(binDir, "pi.cmd"), version: "0.87.1",
  });
});
