import { expect, it } from "vitest";
import os from "node:os";

const moduleUrl = new URL("../src/lib/pi-stage-process.js", import.meta.url).href;

it("runs a native Pi command with bounded output and rejects a timed out child", async () => {
  const mod = await import(/* @vite-ignore */ moduleUrl) as Record<string, unknown>;
  expect(mod.runPiStageProcess).toBeTypeOf("function");
  const run = mod.runPiStageProcess as (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  const options = { env: { ...process.env }, cwd: os.tmpdir(), timeoutMs: 3000 };
  const ok = await run(process.execPath, ["-e", "process.stdout.write('stage-ok')"], options);
  expect(ok).toMatchObject({ exitCode: 0, stdout: "stage-ok", stderr: "" });
  const timed = await run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, timeoutMs: 100 });
  expect(timed.exitCode).not.toBe(0);
  expect(timed.stderr).toMatch(/timed out/);
  const overflowing = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"], options);
  expect(overflowing.exitCode).not.toBe(0);
  expect(overflowing.stderr).toMatch(/output exceeds limit/);
  expect(Buffer.byteLength(overflowing.stdout)).toBeLessThanOrEqual(128 * 1024);
}, 10_000);
