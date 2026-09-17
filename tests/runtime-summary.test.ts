import { describe, expect, it } from "vitest";
import { formatRuntimeSummary } from "../src/install.js";

describe("formatRuntimeSummary", () => {
  it("resume todo al día cuando no hay fallos", () => {
    expect(formatRuntimeSummary("sync", [
      { name: "OpenCode", status: "ok" },
      { name: "Claude Code", status: "ok" },
      { name: "Pi", status: "ok" },
    ])).toBe("Resumen sync: OpenCode al día, Claude Code al día, Pi al día.");
  });

  it("nombra el runtime que falló y conserva los que fueron bien", () => {
    expect(formatRuntimeSummary("sync", [
      { name: "OpenCode", status: "ok" },
      { name: "Pi", status: "failed" },
    ])).toBe("Resumen sync: OpenCode al día; falló en Pi — revisa arriba.");
  });

  it("incluye omitidos y revisados sin marcarlos como fallo", () => {
    expect(formatRuntimeSummary("install", [
      { name: "Codex", status: "skipped" },
      { name: "Pi", status: "preview" },
    ])).toBe("Resumen install: Codex omitido, Pi revisado.");
  });

  it("cierra en vacío sin runtimes", () => {
    expect(formatRuntimeSummary("sync", [])).toBe("Resumen sync: sin runtimes.");
  });
});
