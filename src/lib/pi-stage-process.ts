import { spawn } from "node:child_process";
import { planDetectedBinCommand } from "./detect.js";
import { stopOwnedPiProcess } from "./pi-stage-smoke.js";

// Cold-cache Windows CI was still fetching successful npm responses at 120s.
export const PI_STAGE_PROCESS_TIMEOUT_MS = process.platform === "win32" ? 300_000 : 120_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

export async function runPiStageProcess(
  executable: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = planDetectedBinCommand(executable, args);
  if (command === null) return { exitCode: 1, stdout: "", stderr: "unsafe Pi executable" };
  const timeoutMs = options.timeoutMs ?? PI_STAGE_PROCESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid Pi stage timeout");
  return await new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      env: options.env, cwd: options.cwd, shell: false,
      detached: process.platform !== "win32", windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = async (exitCode: number, detail = ""): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      await stopOwnedPiProcess(child);
      resolve({ exitCode, stdout, stderr: [detail, stderr].filter(Boolean).join("\n") });
    };
    const capture = (chunk: Buffer, channel: "stdout" | "stderr"): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { void finish(1, "Pi stage output exceeds limit"); return; }
      if (channel === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.once("error", (error) => { void finish(1, error.message); });
    child.once("close", (code) => { void finish(code ?? 1); });
    timer = setTimeout(() => { void finish(1, `Pi stage timed out after ${timeoutMs}ms`); }, timeoutMs);
    timer.unref();
  });
}
