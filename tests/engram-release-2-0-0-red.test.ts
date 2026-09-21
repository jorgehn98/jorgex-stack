import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * RED pin contract for Engram 2.0.0 (tasks/12).
 *
 * Real diagnosis: fresh Stack installs must fetch the exact Engram 2.0.0
 * release. GitHub-supplied sizes/SHA below are the independent source of
 * truth (not recomputed from code). Current src/lib/engram-release.json
 * still pins 1.20.0, so every assertion here must FAIL now.
 */

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function readReleasePin(): { version: string; assets: Record<string, { name: string; size: number; sha256: string }> } {
  const raw = fs.readFileSync(path.join(ROOT, "..", "src", "lib", "engram-release.json"), "utf8");
  return JSON.parse(raw) as { version: string; assets: Record<string, { name: string; size: number; sha256: string }> };
}

describe("[engram-release-2.0.0] exact GitHub pin for six platforms", () => {
  it("pins version 2.0.0, not 1.20.0", () => {
    const pin = readReleasePin();
    expect(pin.version).toBe("2.0.0");
  });

  it("darwin arm64 asset name/size/SHA match GitHub release", () => {
    const pin = readReleasePin();
    expect(pin.assets["darwin_arm64"]).toEqual({
      name: "engram_2.0.0_darwin_arm64.tar.gz",
      size: 7210321,
      sha256: "793c695153e0e76144dc53b006a7039771bd24115385856578bc4d6506d46d7f",
    });
  });

  it("darwin amd64 asset name/size/SHA match GitHub release", () => {
    const pin = readReleasePin();
    expect(pin.assets["darwin_x64"]).toEqual({
      name: "engram_2.0.0_darwin_amd64.tar.gz",
      size: 7678428,
      sha256: "f1dcc343ac241c5001617113279b49dec698005550b538250ccf21655fc728ac",
    });
  });

  it("linux arm64 asset name/size/SHA match GitHub release", () => {
    const pin = readReleasePin();
    expect(pin.assets["linux_arm64"]).toEqual({
      name: "engram_2.0.0_linux_arm64.tar.gz",
      size: 6926960,
      sha256: "a942e73ab424faaa6e2785d1563e0d9d7f20739944dae0c50071223301d44333",
    });
  });

  it("linux amd64 asset name/size/SHA match GitHub release", () => {
    const pin = readReleasePin();
    expect(pin.assets["linux_x64"]).toEqual({
      name: "engram_2.0.0_linux_amd64.tar.gz",
      size: 7544949,
      sha256: "23be1c2ce9739c455097ff864736213717b925b3e8821a988dfc619685a5abd5",
    });
  });

  it("windows arm64 asset name/size/SHA match GitHub release", () => {
    const pin = readReleasePin();
    expect(pin.assets["windows_arm64"]).toEqual({
      name: "engram_2.0.0_windows_arm64.zip",
      size: 6980876,
      sha256: "e4d9074ebf8a839573f62d7bd2719421fc428ab25a9affe82ca4b2d5555183d1",
    });
  });

  it("windows amd64 asset name/size/SHA match GitHub release", () => {
    const pin = readReleasePin();
    expect(pin.assets["windows_x64"]).toEqual({
      name: "engram_2.0.0_windows_amd64.zip",
      size: 7738896,
      sha256: "fba31e7221702f213954c2081aa83b38833e0e9b824a981f976f8cee2c74548c",
    });
  });
});
