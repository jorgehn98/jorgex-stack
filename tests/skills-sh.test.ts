import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stackRoot } from "../src/lib/paths.js";

type Grouping = { title: string; description?: string; skills: string[] };
type SkillsSh = { paths?: string[]; notGrouped?: string; groupings?: Grouping[] };

const skillsDir = path.join(stackRoot(), "skills");
const repoRoot = path.dirname(stackRoot());
const manifest: SkillsSh = JSON.parse(fs.readFileSync(path.join(repoRoot, "skills.sh.json"), "utf8"));

/** El título del grupo es legible ("Agent tooling"); la carpeta es su slug. */
const slug = (title: string) => title.toLowerCase().replace(/\s+/g, "-");

function categoryFolders(): string[] {
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function skillsIn(category: string): string[] {
  return fs
    .readdirSync(path.join(skillsDir, category), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("skills.sh.json", () => {
  it("lists every skill in the group of its category and none that does not exist", () => {
    const groupings = new Map((manifest.groupings ?? []).map((grouping) => [slug(grouping.title), grouping]));
    expect([...groupings.keys()].sort()).toEqual(categoryFolders());
    for (const category of categoryFolders()) {
      expect(groupings.get(category)?.skills.slice().sort(), category).toEqual(skillsIn(category));
    }
  });

  it("points paths at existing folders relative to the repository root", () => {
    expect(manifest.paths?.length).toBeGreaterThan(0);
    for (const entry of manifest.paths!) {
      expect(entry.startsWith("./"), entry).toBe(true);
      expect(fs.statSync(path.resolve(repoRoot, entry)).isDirectory(), entry).toBe(true);
    }
  });
});
