import { describe, expect, it } from "vitest";
import type { EngramInstallResult } from "../src/lib/engram-install.js";

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
      installShared(): Promise<EngramInstallResult>;
    },
  ): Promise<EngramDecision>;
};

async function requirement(): Promise<PiEngramRequirement> {
  const mod = await import("../src/lib/pi-runtime.js") as unknown as Partial<PiEngramRequirement>;
  expect(mod.resolvePiEngramRequirement).toBeTypeOf("function");
  return mod as unknown as PiEngramRequirement;
}

function deps(overrides: Partial<{
  host: string | null;
  target: string | null;
  accepted: boolean;
  installResult: EngramInstallResult;
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
      async installShared(...args: unknown[]) {
        events.push("install-shared");
        expect(args).toEqual([]);
        return overrides.installResult ?? { ok: true, bin: "/opt/engram/bin/engram" };
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

  it("offers the single shared versionless installation only to an interactive user, defaults to No, and re-detects once after acceptance", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const declined = deps();
    expect(declined.api).not.toHaveProperty("installNative");
    expect("version" in declined.api).toBe(false);
    await expect(resolvePiEngramRequirement({ interactive: true, yes: false }, declined.api)).resolves.toEqual({ kind: "offer", accepted: false });
    expect(declined.events).toEqual(["detect-host", "confirm:false"]);

    const accepted = deps({
      accepted: true,
      installResult: { ok: true, bin: "/opt/engram/bin/engram" },
      redetected: "/opt/engram/bin/engram",
    });
    expect(accepted.api).not.toHaveProperty("installNative");
    await expect(resolvePiEngramRequirement({ interactive: true, yes: false }, accepted.api)).resolves.toEqual({
      kind: "existing",
      bin: "/opt/engram/bin/engram",
      scope: "host",
    });
    expect(accepted.events).toEqual([
      "detect-host",
      "confirm:false",
      "install-shared",
      "detect-host",
    ]);
  });

  it("carries a structured installer failure reason into the blocked remedy", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const detail = "simulated installer boom: ECONNRESET";
    const failed = deps({
      accepted: true,
      installResult: { ok: false, reason: detail },
      redetected: null,
    });
    await expect(
      resolvePiEngramRequirement({ interactive: true, yes: false }, failed.api),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "engram-install-failed",
      remedy: expect.stringContaining(detail),
    });
    expect(failed.events).toEqual(["detect-host", "confirm:false", "install-shared"]);
  });
});

// ---------------------------------------------------------------------------
// T41-RED: el install Pi gestionado exige el binario Engram antes del setup.
// Contrato: install real resuelve/instala el binario primero (requirement
// existente), con binario absoluto; solo entonces respalda cada path mutable,
// ejecuta `engram setup pi` (argv exacto) y verifica singleton antes del
// package install. Sin binario absoluto no hay backup/spawn/verify ni package.
// Aislado, sin HOME real/red.
// ---------------------------------------------------------------------------

describe("[T41-RED] Pi install exige Engram absoluto antes del setup pi", () => {
  it("el requirement resuelto es un binario absoluto reutilizable por el setup", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const state = deps({ host: "/isolated/bin/engram" });

    const decision = await resolvePiEngramRequirement({ interactive: true, yes: false }, state.api);
    expect(decision).toEqual({ kind: "existing", bin: "/isolated/bin/engram", scope: "host" });
    expect((decision as { bin: string }).bin.startsWith("/")).toBe(true);
    expect(state.events).toEqual(["detect-host"]);
  });

  it("el setup pi posterior usa ese binario absoluto con argv exacto y targets explícitos", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const state = deps({ host: "/isolated/bin/engram" });
    const decision = await resolvePiEngramRequirement({ interactive: true, yes: false }, state.api);
    expect(decision).toMatchObject({ kind: "existing" });
    const bin = (decision as { bin: string }).bin;

    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof setup.resolveOfficialSetupArgv, "falta argv setup pi tras Engram (T41)").toBe("function");
    expect(setup.resolveOfficialSetupArgv("pi")).toEqual(["setup", "pi"]);
    expect(bin.startsWith("/")).toBe(true);

    const targets = setup.collectOfficialSetupBackupTargets("pi", "/isolated/pi-agent", "/isolated/home") as string[];
    expect(Array.isArray(targets) && targets.length > 0, "Pi debe declarar backup targets tras Engram").toBe(true);
    expect(targets.join("\n")).not.toMatch(/\.engram\/engram\.db|engram\.db/);
  });

  it("sin binario absoluto no hay setup pi: falla cerrado antes de backup/spawn", async () => {
    const { resolvePiEngramRequirement } = await requirement();
    const missing = deps();
    const decision = await resolvePiEngramRequirement({ interactive: false, yes: false }, missing.api);
    expect(decision).toMatchObject({ kind: "blocked", reason: "engram-required" });
    expect(missing.events).toEqual(["detect-host"]);

    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    // Sin engramBin absoluto el núcleo debe exigirlo antes de mutar.
    await expect(setup.runOfficialSetup("pi", {
      homeDir: "/isolated/home",
      engramBin: null,
      targets: ["/isolated/pi-agent/settings.json"],
      backup: async () => ({ id: "must-not-run" }),
      spawn: async () => { throw new Error("must-not-spawn-without-engram"); },
      verify: async () => ({ ok: true }),
    })).rejects.toThrow(/engramBin absoluto/i);
  });
});
