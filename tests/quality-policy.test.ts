import { describe, expect, it } from "vitest";
import {
  evaluateQualityPolicy,
  type QualityControlDefinition,
  type QualityControlResult,
  type QualityProfile,
} from "../src/lib/quality-policy.js";

const PROFILES: QualityProfile[] = ["routine", "elevated", "high", "release"];

function required(id = "typecheck"): QualityControlDefinition {
  return { id, requirement: "required" };
}

function optional(id: string, notApplicable = false): QualityControlDefinition {
  return { id, requirement: "optional", ...(notApplicable ? { notApplicable: true } : {}) };
}

function pass(controlId: string, evidence = "exit=0"): QualityControlResult {
  return { controlId, status: "pass", evidence };
}

function incomplete(controlId: string, reason: string): QualityControlResult {
  return { controlId, status: "incomplete", reason, evidence: reason };
}

function notApplicable(controlId: string, reason = "No aplica en esta tarea"): QualityControlResult {
  return { controlId, status: "not-applicable", reason };
}

function evaluate(
  controls: QualityControlDefinition[],
  results: QualityControlResult[],
  profile?: QualityProfile,
) {
  return evaluateQualityPolicy({
    ...(profile === undefined ? {} : { profile }),
    controls,
    results,
  });
}

describe("evaluateQualityPolicy", () => {
  it.each(PROFILES)("acepta el perfil %s sin inventar gates universales", (profile) => {
    expect(evaluate([required()], [pass("typecheck")], profile)).toMatchObject({
      profile,
      status: "pass",
    });
  });

  it("usa routine como perfil por defecto", () => {
    expect(evaluate([required()], [pass("typecheck")])).toMatchObject({
      profile: "routine",
      status: "pass",
    });
  });

  it("rechaza un perfil desconocido en vez de degradarlo silenciosamente a routine", () => {
    expect(() => evaluate([required()], [pass("typecheck")], "unknown" as QualityProfile)).toThrow(/profile|perfil/i);
  });

  it("no convierte cero required, incluidos todos los controles N/A, en pass", () => {
    expect(evaluate(
      [optional("coverage", true)],
      [notApplicable("coverage")],
    ).status).toBe("incomplete");
  });

  it("acepta N/A solo para un optional predeclarado y conserva su justificación", () => {
    expect(evaluate(
      [required(), optional("coverage", true)],
      [pass("typecheck"), notApplicable("coverage", "Coverage no está configurado")],
    ).status).toBe("pass");
  });

  it.each([
    {
      name: "required",
      controls: [required("acceptance")],
      results: [notApplicable("acceptance")],
    },
    {
      name: "optional no predeclarado",
      controls: [optional("coverage")],
      results: [notApplicable("coverage")],
    },
    {
      name: "optional predeclarado sin justificación",
      controls: [optional("coverage", true)],
      results: [{ controlId: "coverage", status: "not-applicable" as const }],
    },
  ])("marca N/A inválido ($name) como incomplete", ({ controls, results }) => {
    expect(evaluate(controls, results).status).toBe("incomplete");
  });

  it.each([
    { name: "sin resultado", results: [] },
    { name: "pass sin evidencia", results: [{ controlId: "typecheck", status: "pass" as const }] },
  ])("marca required $name como incomplete", ({ results }) => {
    expect(evaluate([required()], results).status).toBe("incomplete");
  });

  it.each(["timeout", "error", "unavailable"] as const)(
    "mantiene required %s en incomplete y no lo trata como pass",
    (reason) => {
      expect(evaluate([required()], [incomplete("typecheck", reason)]).status).toBe("incomplete");
    },
  );

  it("aplica la precedencia fail > incomplete > pass", () => {
    expect(evaluate(
      [required("typecheck"), optional("acceptance"), optional("coverage")],
      [
        pass("typecheck"),
        incomplete("acceptance", "timeout"),
        { controlId: "coverage", status: "fail", evidence: "exit=1" },
      ],
    ).status).toBe("fail");

    expect(evaluate(
      [required("typecheck"), optional("acceptance")],
      [pass("typecheck"), incomplete("acceptance", "unavailable")],
    ).status).toBe("incomplete");
  });

  it("falla cerrado si aparece un check no declarado por la policy", () => {
    expect(evaluate(
      [required("typecheck")],
      [pass("typecheck"), pass("unknown-check")],
    ).status).toBe("incomplete");
  });
});
