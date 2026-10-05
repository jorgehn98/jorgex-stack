import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentModel, saveAgentModel, editAgentModel } from "../src/lib/agent-model.js";
import type { RuntimeId } from "../src/adapters/types.js";
let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("native individual preferences", () => {
  it.each(["claude-code", "codex", "opencode", "pi"] as RuntimeId[])("saves model and effort for %s, backs up and preserves neighboring policy", (runtime) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-native-model-"));
    const directory = root;
    const file = path.join(directory, runtime === "codex" ? "agent.toml" : "agent.md");
    const before = runtime === "codex" ? 'name = "agent"\nsandbox_mode = "read-only"\ndeveloper_instructions = "body"\n' : '---\nname: agent\ntools: read\n---\nbody\n';
    fs.writeFileSync(file, before);
    const neighbor = path.join(root, "neighbor.md"); fs.writeFileSync(neighbor, "untouched");
    const unit = readAgentModel(runtime, file);
    saveAgentModel(runtime, file, unit.content, { model: 'provider/model"', variant: "special" }, new Set([file]), directory, path.join(directory, "backups"));
    expect(readAgentModel(runtime, file).selection).toEqual({ model: 'provider/model"', variant: "special" });
    expect(fs.readFileSync(neighbor, "utf8")).toBe("untouched");
    expect(fs.readdirSync(path.join(root, "backups"))).toHaveLength(1);
    const saved = fs.readFileSync(file, "utf8");
    expect(editAgentModel(runtime, saved, {})).toBe(before);
    expect(() => saveAgentModel(runtime, file, before, {}, new Set([file]), directory, path.join(directory, "backups"))).toThrow(/cambió/i);
    expect(() => saveAgentModel(runtime, file, saved, {}, new Set(), directory, path.join(directory, "backups"))).toThrow(/ajeno/i);
  });
  it("keeps native formatting on maintain and ignores foreign OpenCode effort fields", () => {
    const commented = '---\r\nname: agent\r\nmodel: "personal" # keep comment\r\neffort: high\r\n---\r\nbody';
    expect(editAgentModel("claude-code", commented, { model: "personal", variant: "high" })).toBe(commented);
    expect(editAgentModel("opencode", commented, {})).toContain("effort: high\r\n");
    const injected = editAgentModel("pi", '---\nname: agent\n---\nbody', { model: 'model"\n---\ntools: bash', variant: 'level\nallowedAgents: generalist' });
    expect(injected.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(injected).not.toMatch(/^tools: bash|^allowedAgents:/m);
  });
  it("keeps absent selections absent and refuses malformed native preference fields", () => {
    expect(editAgentModel("pi", "---\nname: agent\n---\nbody", {})).toBe("---\nname: agent\n---\nbody");
    expect(() => editAgentModel("claude-code", "---\nmodel: [invalid]\n---\nbody", {})).toThrow(/inválid/i);
    expect(() => editAgentModel("codex", 'model = "unterminated\ndeveloper_instructions = "body"', {})).toThrow(/inválid/i);
  });
});
