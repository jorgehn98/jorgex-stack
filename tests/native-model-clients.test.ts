import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ query: vi.fn(), supportedModels: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
import { discoverModels, openCodeServerAddress } from "../src/lib/native-model-catalog.js";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-native-auth-"));
  vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_STATE_HOME", path.join(root, "state"));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
function registration(value: unknown, state = path.join(root, "state")): string {
  const file = path.join(state, "opencode", "service.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}
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
it("prefers the native registration and binds Basic authentication to its exact origin", async () => {
  const password = randomBytes(24).toString("hex");
  const file = registration({ url: "http://127.0.0.1:49374", pid: 123, version: "2.0.23", password });
  const before = fs.readFileSync(file, "utf8");
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(new Headers(options.headers).get("authorization") === expected).toBe(true);
    expect(options.redirect).toBe("error");
    return new Response(JSON.stringify({ data: [{ providerID: "p", id: "native", name: "Native", variants: [] }] }));
  });
  vi.stubGlobal("fetch", fetch);
  const address = openCodeServerAddress();
  expect(Object.keys(address)).toEqual(["url"]);
  expect(address.url).toBe("http://127.0.0.1:49374");
  const result = await discoverModels("opencode", "detected", "/project");
  expect((fetch.mock.calls[0]![0] as URL).origin).toBe("http://127.0.0.1:49374");
  expect(result.models.map(model => model.id)).toEqual(["p/native"]);
  expect(!JSON.stringify(result).includes(password)).toBe(true);
  await discoverModels("opencode", "detected", "/project", address.url);
  expect(fs.readFileSync(file, "utf8") === before).toBe(true);
});
it.each(["http://127.0.0.1:4096", "http://localhost:49374", "http://[::1]:49374"])("never forwards native authentication to another origin (%s)", async (server) => {
  registration({ url: "http://127.0.0.1:49374", pid: 123, password: randomBytes(24).toString("hex") });
  const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(options.redirect).toBe("error");
    return new Response(JSON.stringify({ data: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  await discoverModels("opencode", "detected", "/project", server);
  expect(fetch.mock.calls.length).toBe(1);
});
it("uses only the native state fallback and preserves manual unauthenticated discovery when registration is absent", async () => {
  expect(openCodeServerAddress().warning).toMatch(/registro.*ausente/i);
  const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    return new Response(JSON.stringify({ data: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  const result = await discoverModels("opencode", "detected", "/project", "http://127.0.0.1:49375");
  expect(result.warning).toMatch(/registro.*ausente/i);
  expect((fetch.mock.calls[0]![0] as URL).origin).toBe("http://127.0.0.1:49375");
  const password = randomBytes(24).toString("hex");
  registration({ url: "http://127.0.0.1:49374", pid: 123, password }, path.join(root, ".local", "state"));
  // An explicit XDG directory never triggers a search elsewhere for credentials.
  expect(openCodeServerAddress().url).toBe("http://127.0.0.1:4096");
  vi.stubEnv("XDG_STATE_HOME", undefined);
  expect(openCodeServerAddress().url).toBe("http://127.0.0.1:49374");
});
it.each(["unreadable", "malformed", "unknown-field", "invalid-pid", "external-url", "normalized-alias", "symlink"])("fails visibly without leaking or authenticating with an unsafe registration (%s)", async (kind) => {
  const password = randomBytes(24).toString("hex");
  const info: Record<string, unknown> = { url: "http://127.0.0.1:49374", pid: 123, password };
  if (kind === "unknown-field") info.extra = true;
  if (kind === "invalid-pid") info.pid = 0;
  if (kind === "external-url") info.url = "http://external.invalid:49374";
  if (kind === "normalized-alias") info.url = "http://127.1:49374";
  const file = registration(info);
  if (kind === "malformed") fs.writeFileSync(file, password);
  if (kind === "symlink") { fs.renameSync(file, file + ".target"); fs.symlinkSync(file + ".target", file); }
  if (kind === "unreadable") vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error(password); });
  const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    return new Response(JSON.stringify({ data: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  const observed = openCodeServerAddress();
  expect(observed.url).toBe("http://127.0.0.1:4096"); expect(observed.warning).toMatch(/registro.*inválido/i);
  const result = await discoverModels("opencode", "detected", "/project", "http://127.0.0.1:49374");
  expect(result.warning).toMatch(/registro.*inválido/i);
  expect(!JSON.stringify([observed, result]).includes(password)).toBe(true);
  expect(fetch.mock.calls.length).toBe(1);
});
it("refuses redirects and redacts authenticated transport failures", async () => {
  const password = randomBytes(24).toString("hex");
  registration({ url: "http://127.0.0.1:49374", pid: 123, password });
  const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(options.redirect).toBe("error");
    return new Response(null, { status: 302, headers: { location: "http://localhost:49374/api/model" } });
  });
  vi.stubGlobal("fetch", fetch);
  expect((await discoverModels("opencode", "detected")).models).toEqual([]);
  expect(fetch.mock.calls.length).toBe(1);
  fetch.mockImplementationOnce(async () => { throw new Error(password); });
  const result = await discoverModels("opencode", "detected");
  expect(result.warning).toMatch(/inaccesible/i);
  expect(!JSON.stringify(result).includes(password)).toBe(true);
});
it("rejects embedded credentials and normalized loopback aliases before making a request", async () => {
  const password = randomBytes(24).toString("hex");
  registration({ url: "http://127.0.0.1:49374", pid: 123, password });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const server of [`http://opencode:${password}@127.0.0.1:49374`, "http://127.1:49374"]) {
    const result = await discoverModels("opencode", "detected", "/project", server);
    expect(result.models).toEqual([]);
    expect(!JSON.stringify(result).includes(password)).toBe(true);
  }
  expect(fetch.mock.calls.length).toBe(0);
});
