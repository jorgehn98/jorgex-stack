import { describe, expect, it } from "vitest";
import { resolveEngramRollback, type EngramRollbackAction } from "../src/update.js";

// Rutas usadas en los tests — constantes para poder verificar que aparecen en mensajes.
const BIN = "C:/u/.engram/engram.exe";
const ROTATED = "C:/u/.engram/engram.exe.old-123";

// ---------------------------------------------------------------------------
// resolveEngramRollback — 3 caminos de la review del PR #3 + casos none
// ---------------------------------------------------------------------------

describe("resolveEngramRollback: camino 1 — GOBIN distinto (installOk, bin ausente)", () => {
  it("devuelve action restore con warnGobinMismatch=true", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    expect(result.action).toBe("restore");
    if (result.action !== "restore") return; // narrowing para TS
    expect(result.warnGobinMismatch).toBe(true);
  });

  it("el mensaje onRestore contiene la ruta de bin", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    if (result.action !== "restore") throw new Error("esperado restore");
    expect(result.messages.onRestore).toContain(BIN);
  });

  it("el mensaje onRestore menciona GOBIN", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    if (result.action !== "restore") throw new Error("esperado restore");
    expect(result.messages.onRestore.toLowerCase()).toContain("gobin");
  });

  it("el mensaje onRenameFail contiene la ruta rotated", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    if (result.action !== "restore") throw new Error("esperado restore");
    expect(result.messages.onRenameFail).toContain(ROTATED);
  });
});

describe("resolveEngramRollback: camino 2 — revert tras install fallido (binExists=false)", () => {
  it("devuelve action restore con warnGobinMismatch=false", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    expect(result.action).toBe("restore");
    if (result.action !== "restore") return;
    expect(result.warnGobinMismatch).toBe(false);
  });

  it("el mensaje onRestore indica que la rotación fue revertida", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    if (result.action !== "restore") throw new Error("esperado restore");
    // La review pedía que el usuario sepa que el binario anterior sigue disponible.
    expect(result.messages.onRestore.toLowerCase()).toContain("revert");
  });

  it("el mensaje onRenameFail contiene rotated y bin (para renombrar a mano)", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: ROTATED,
      bin: BIN,
      binExists: false,
    });

    if (result.action !== "restore") throw new Error("esperado restore");
    expect(result.messages.onRenameFail).toContain(ROTATED);
    expect(result.messages.onRenameFail).toContain(BIN);
  });
});

describe("resolveEngramRollback: camino 3 — install fallido pero go dejó binario (binExists=true)", () => {
  it("devuelve action leave_old (sin rename)", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: ROTATED,
      bin: BIN,
      binExists: true,
    });

    expect(result.action).toBe("leave_old");
  });

  it("el mensaje onLeaveOld contiene bin y rotated", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: ROTATED,
      bin: BIN,
      binExists: true,
    });

    if (result.action !== "leave_old") throw new Error("esperado leave_old");
    expect(result.messages.onLeaveOld).toContain(BIN);
    expect(result.messages.onLeaveOld).toContain(ROTATED);
  });
});

describe("resolveEngramRollback: casos none", () => {
  it("installOk=true y binExists=true → none (install limpio, sin rollback)", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: ROTATED,
      bin: BIN,
      binExists: true,
    });

    expect(result.action).toBe("none");
  });

  it("rotated=null → none (no hay rotación que revertir)", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: null,
      bin: BIN,
      binExists: false,
    });

    expect(result.action).toBe("none");
  });

  it("rotated=null con installOk=true → none", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: null,
      bin: BIN,
      binExists: false,
    });

    expect(result.action).toBe("none");
  });

  it("bin=null → none (callsite: fs.existsSync(null ?? '') → binExists=false, pero sin bin no hay destino)", () => {
    const result = resolveEngramRollback({
      installOk: false,
      rotated: ROTATED,
      bin: null,
      binExists: false, // fs.existsSync("") es false
    });

    expect(result.action).toBe("none");
  });

  it("bin=null con installOk=true → none", () => {
    const result = resolveEngramRollback({
      installOk: true,
      rotated: ROTATED,
      bin: null,
      binExists: false,
    });

    expect(result.action).toBe("none");
  });
});
