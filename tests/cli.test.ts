import { expect, it, vi } from "vitest";
import { runMenu, type MenuOperations } from "../src/cli.js";

function harness(answers: string[], fail = false) {
  const operate = vi.fn(async () => fail ? 1 : 0);
  const edit = vi.fn(async () => {});
  const messages: string[] = [];
  const operations: MenuOperations = { detect: () => ["pi"], agents: () => ["implementer", "reviewer"], operate, edit };
  const ui = { select: async (_path: string, options: { value: string; label: string }[]) => {
    const value = answers.shift()!;
    expect(options.some((option) => option.value === value)).toBe(true);
    return value;
  }, confirm: vi.fn(async () => true), info: (message: string) => { messages.push(message); } };
  return { operations, ui, operate, edit, messages };
}
it("does nothing without a TTY, including detection", async () => {
  const h = harness([]); const detect = vi.spyOn(h.operations, "detect");
  await runMenu(h.operations, h.ui, false);
  expect(detect).not.toHaveBeenCalled(); expect(h.operate).not.toHaveBeenCalled();
  expect(h.messages.join(" ")).toContain("terminal");
});
it("visits individual Pi agents and returns one level without lifecycle operations", async () => {
  const h = harness(["install", "agents", "pi", "implementer", "edit", "back", "reviewer", "back", "back", "back", "back", "exit"]);
  await runMenu(h.operations, h.ui, true);
  expect(h.edit).toHaveBeenCalledExactlyOnceWith("pi", "implementer", expect.stringContaining("implementer"));
  expect(h.operate).not.toHaveBeenCalled();
});
it("canceling destructive scope confirmation has no operation effects", async () => {
  const h = harness(["uninstall", "config", "pi", "apply", "back", "back", "back", "exit"]);
  h.ui.confirm.mockResolvedValue(false);
  await runMenu(h.operations, h.ui, true);
  expect(h.operate).not.toHaveBeenCalled();
  expect(h.ui.confirm).toHaveBeenCalledOnce();
});
it("confirms the shared destructive scope and never retries a partial operation automatically", async () => {
  const h = harness(["uninstall", "skills", "apply", "back", "back", "exit"], true);
  await runMenu(h.operations, h.ui, true);
  expect(h.ui.confirm).toHaveBeenCalledWith(expect.stringContaining("compartidas"));
  expect(h.operate).toHaveBeenCalledExactlyOnceWith("uninstall", { section: "skills" }, ["pi"]);
  expect(h.messages.join(" ")).toContain("pendiente");
});
it("explains the permission policy before a configuration unit can be applied", async () => {
  const h = harness(["install", "config", "pi", "back", "back", "back", "exit"]);
  await runMenu(h.operations, h.ui, true);
  expect(h.operate).not.toHaveBeenCalled();
  const notice = h.messages.find((message) => message.includes("Permisos"))!;
  expect(notice).toMatch(/sin prompts/);
  expect(notice).toMatch(/existente se conserva/);
  expect(notice).toMatch(/Codex.*\.env/);
});
it("does not show the permission notice for scopes that never write permissions", async () => {
  const h = harness(["install", "skills", "back", "back", "doctor", "config", "pi", "back", "back", "back", "exit"]);
  await runMenu(h.operations, h.ui, true);
  expect(h.messages.some((message) => message.includes("Permisos"))).toBe(false);
});
