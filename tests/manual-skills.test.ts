import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { stackRoot } from "../src/lib/paths.js";

/** Skills de invocación manual declarada. Stack no lee estos campos: protege que el texto que ve el runtime no se afloje. */
const MANUAL = [["marketing", "visual-director"], ["engineering", "software-factory"]] as const;

it.each(MANUAL)("keeps %s/%s as manual-only in its frontmatter", (category, name) => {
  const source = fs.readFileSync(path.join(stackRoot(), "skills", category, name, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)![1]!;
  expect(frontmatter).toContain("opencode/autoinvoke: false");
  const description = /^description: (.*)$/m.exec(frontmatter)![1]!;
  expect(description).toMatch(/Use only when the user explicitly invokes/);
});
