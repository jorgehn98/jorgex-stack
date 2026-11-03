import path from "node:path";
import { describe, expect, it } from "vitest";
import { planOrphanRetirement } from "../src/install.js";

const root = "/tmp/jx-orphan-retirement";
const sharedSkills = path.join(root, ".agents", "skills");
const skillFile = (name: string) => path.join(sharedSkills, name);

describe("planOrphanRetirement", () => {
  it("retira un archivo que ya no proyecta aunque otro runtime lo tenga en la raíz compartida", () => {
    const orphan = skillFile("skill-creator/scripts/run_eval.py");
    expect(planOrphanRetirement({ owned: [orphan], planned: [], ownedByOthers: [orphan], sharedRoots: [sharedSkills] })).toEqual([orphan]);
  });

  it("conserva lo que otro runtime tiene fuera de las raíces compartidas", () => {
    const foreign = path.join(root, ".claude", "settings.json");
    expect(planOrphanRetirement({ owned: [foreign], planned: [], ownedByOthers: [foreign], sharedRoots: [sharedSkills] })).toEqual([]);
  });

  it("conserva lo que el plan sigue proyectando", () => {
    const live = skillFile("skill-creator/SKILL.md");
    expect(planOrphanRetirement({ owned: [live], planned: [live], ownedByOthers: [], sharedRoots: [sharedSkills] })).toEqual([]);
  });
});
