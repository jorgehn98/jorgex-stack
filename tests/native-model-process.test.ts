import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const invocation = vi.hoisted(() => ({ program: "", args: [] as string[] }));
vi.mock("../src/lib/detect.js", () => ({ planDetectedBinCommand: (_bin: string, args: string[]) => { invocation.args = args; return { command: process.execPath, args: ["-e", invocation.program] }; } }));
import { stdioCatalog } from "../src/lib/native-model-catalog.js";
let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

it("uses the Codex handshake without turns and reaps the owned process", async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-catalog-process-"));
  const directory = root;
  const requests = path.join(directory, "requests");
  invocation.program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(directory, "pid"))},String(process.pid));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},q.method+'\\n');if(q.id)console.log(JSON.stringify({id:q.id,result:q.method==='model/list'?{data:[{model:'native',displayName:'Native',supportedReasoningEfforts:[]}],nextCursor:null}:{}}));});`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
  try {
    expect(await stdioCatalog("codex", "synthetic", directory, controller.signal)).toEqual([{ id: "native", name: "Native", efforts: [] }]);
    expect(invocation.args).toEqual(["app-server"]);
    expect(fs.readFileSync(requests, "utf8")).toBe("initialize\ninitialized\nmodel/list\n");
    expect(() => process.kill(Number(fs.readFileSync(path.join(directory, "pid"), "utf8")), 0)).toThrow();
  } finally { clearTimeout(timer); controller.abort(); }
});

it("times out unresponsive stdio, suppressing raw diagnostics and reaping it", async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-catalog-timeout-"));
  const directory = root;
  const pidFile = path.join(directory, "pid");
  invocation.program = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('private response content');process.stdin.resume();`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await expect(stdioCatalog("pi", "synthetic", root, controller.signal)).rejects.toThrow(/catálogo nativo/i);
    expect(invocation.args).toEqual(["--mode", "rpc", "--no-session"]);
    expect(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0)).toThrow();
  } finally { clearTimeout(timer); controller.abort(); }
});
