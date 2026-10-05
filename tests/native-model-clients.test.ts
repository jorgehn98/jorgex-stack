import { afterEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ query: vi.fn(), supportedModels: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
import { discoverModels } from "../src/lib/native-model-catalog.js";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
it("queries the official SDK supportedModels without sending a prompt and always closes", async () => {
  sdk.query.mockReturnValue({ supportedModels: sdk.supportedModels, close: sdk.close });
  sdk.supportedModels.mockResolvedValueOnce([{ value: "native", displayName: "Native", supportedEffortLevels: ["specific"] }]);
  expect(await discoverModels("claude-code", "detected", "/project")).toEqual({ models: [{ id: "native", name: "Native", efforts: ["specific"] }] });
  const { prompt, options } = sdk.query.mock.calls[0]![0];
  expect(typeof prompt).not.toBe("string");
  expect(options).toMatchObject({ pathToClaudeCodeExecutable: "detected", persistSession: false });
  expect((await prompt.next()).done).toBe(true);
  expect(sdk.close).toHaveBeenCalledOnce();
});
it("bounds stalled SDK requests and redacts provider errors", async () => {
  vi.useFakeTimers();
  sdk.query.mockReturnValue({ supportedModels: sdk.supportedModels, close: sdk.close });
  sdk.supportedModels.mockReturnValueOnce(new Promise(() => {}));
  const request = discoverModels("claude-code", "detected");
  await vi.advanceTimersByTimeAsync(15_000);
  const result = await request;
  expect(result.models).toEqual([]); expect(result.warning).toMatch(/inaccesible/i);
  expect(sdk.close).toHaveBeenCalled();
  sdk.supportedModels.mockRejectedValueOnce(new Error("private provider content"));
  expect((await discoverModels("claude-code", "detected")).warning).not.toContain("private provider content");
});
it("queries an existing OpenCode v2 server by location and reports auth failure without raw body", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ providerID: "p", id: "native", name: "Native", variants: [{ id: "speed" }], headers: { private: "not-displayed" } }] }))).mockResolvedValueOnce(new Response("private response content", { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  const result = await discoverModels("opencode", "detected", "/project");
  expect(result.models).toEqual([{ id: "p/native", name: "Native", efforts: ["speed"] }]);
  const url = fetch.mock.calls[0]![0] as URL;
  expect(url.pathname).toBe("/api/model"); expect(url.searchParams.get("location[directory]")).toBe("/project");
  expect((await discoverModels("opencode", "detected")).warning).not.toContain("private response content");
  expect((await discoverModels("opencode", "detected", "/project", "https://external.invalid")).models).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
