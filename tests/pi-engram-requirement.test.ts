import { describe, expect, it } from "vitest";

type EngramDecision =
  | { kind: "existing"; bin: string; scope: "host" | "target-dir" }
  | { kind: "offer"; accepted: false }
  | { kind: "blocked"; reason: string; remedy: string };

type PiEngramRequirement = {
  resolvePiEngramRequirement(
    input: { targetDir?: string; interactive: boolean; yes: boolean },
    deps: {
      detectHost(): string | null;
      detectTarget(targetDir: string): string | null;
      confirm(input: { message: string; initialValue: false }): Promise<boolean>;
      installNative(input: { version: "1.20.0"; channels: ["brew", "go", "url"] }): Promise<boolean>;
    },
  ): Promise<EngramDecision>;
};

async function requirement(): Promise<PiEngramRequirement> {
  const mod = await import("../src/lib/pi-runtime.js") as Partial<PiEngramRequirement>;
  expect(mod.resolvePiEngramRequirement).toBeTypeOf("function");
  return mod as PiEngramRequirement;
}

function deps(overrides: Partial<{
  host: string | null;
  target: string | null;
  accepted: boolean;
  installed: boolean;
  redetected: string | null;
}> = {}) {
  const events: string[] = [];
  let hostReads = 0;
  return {
    events,
    api: {
      detectHost() {
        events.push("detect-host");
        hostReads++;
        return hostReads === 1 ? (overrides.host ?? null) : (overrides.redetected ?? null);
      },
      detectTarget(targetDir: string) {
        events.push(`detect-target:${targetDir}`);
        return overrides.target ?? null;
      },
      async confirm(input: { message: string; initialValue: false }) {
        events.push(`confirm:${input.initialValue}`);
        expect(input.message).toMatch(/engram/i);
        return overrides.accepted ?? false;
      },
      async installNative(input: { version: "1.20.0"; channels: ["brew", "go", "url"] }) {
        events.push(`install:${input.version}:${input.channels.join(",")}`);
        return overrides.installed ?? true;
      },
    },
  };
}

describe("Pi Engram requirement", () => {
  it("preserves an existing host binary and never offers or installs over it", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const state = deps({ host: "/opt/engram/bin/engram" });

    await expect(resolvePiEngramRequirement({ interactive: true, yes: false }, state.api)).resolves.toEqual({
      kind: "existing",
      bin: "/opt/engram/bin/engram",
      scope: "host",
    });
    expect(state.events).toEqual(["detect-host"]);
  });

  it("keeps target-dir hermetic: it only accepts its local binary and never queries or installs host Engram", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const existing = deps({ target: "/tmp/pi-target/bin/engram", host: "/real/host/engram" });
    await expect(resolvePiEngramRequirement({ targetDir: "/tmp/pi-target", interactive: true, yes: false }, existing.api)).resolves.toEqual({
      kind: "existing",
      bin: "/tmp/pi-target/bin/engram",
      scope: "target-dir",
    });
    expect(existing.events).toEqual(["detect-target:/tmp/pi-target"]);

    const absent = deps({ target: null });
    await expect(resolvePiEngramRequirement({ targetDir: "/tmp/pi-target", interactive: true, yes: false }, absent.api)).resolves.toMatchObject({
      kind: "blocked",
      reason: "engram-missing-target",
      remedy: expect.stringMatching(/target-dir|engram/i),
    });
    expect(absent.events).toEqual(["detect-target:/tmp/pi-target"]);
  });

  it("blocks --yes and noninteractive missing Engram before prompting or running a subprocess", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    for (const input of [
      { interactive: true, yes: true },
      { interactive: false, yes: false },
    ]) {
      const state = deps();
      await expect(resolvePiEngramRequirement(input, state.api)).resolves.toMatchObject({
        kind: "blocked",
        reason: "engram-required",
        remedy: expect.stringMatching(/engram/i),
      });
      expect(state.events).toEqual(["detect-host"]);
    }
  });

  it("offers native installation only to an interactive user, defaults to No, and re-detects once after acceptance", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const declined = deps();
    await expect(resolvePiEngramRequirement({ interactive: true, yes: false }, declined.api)).resolves.toEqual({ kind: "offer", accepted: false });
    expect(declined.events).toEqual(["detect-host", "confirm:false"]);

    const accepted = deps({ accepted: true, installed: true, redetected: "/opt/engram/bin/engram" });
    await expect(resolvePiEngramRequirement({ interactive: true, yes: false }, accepted.api)).resolves.toEqual({
      kind: "existing",
      bin: "/opt/engram/bin/engram",
      scope: "host",
    });
    expect(accepted.events).toEqual([
      "detect-host",
      "confirm:false",
      "install:1.20.0:brew,go,url",
      "detect-host",
    ]);
  });
});
