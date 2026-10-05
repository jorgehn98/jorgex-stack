import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { readAgentModel, saveAgentModel } from "../src/lib/agent-model.js";

it("fails closed for corrupt native preferences without rewriting or exposing contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-native-corrupt-"));
  try {
    const file = path.join(root, "agent.toml");
    const malformed = 'model = "unterminated\ndeveloper_instructions = "body"\n';
    fs.writeFileSync(file, malformed);
    expect(() => readAgentModel("codex", file)).toThrow(/configuración.*inválida/i);
    expect(() => saveAgentModel("codex", file, malformed, {}, new Set([file]), root, path.join(root, "backups"))).toThrow(/inválida/i);
    expect(fs.readFileSync(file, "utf8")).toBe(malformed);
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
