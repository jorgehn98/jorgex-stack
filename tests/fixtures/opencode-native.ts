import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface NativeEvent {
  type?: string;
  part?: { tool?: string; state?: { status?: string; output?: string; error?: string } };
}

export async function nativePermission(input: {
  binary: string;
  permission: unknown;
  command?: string;
  file?: string;
  tool?: "bash" | "read" | "write";
  agent?: string;
}): Promise<"allow" | "ask" | "deny"> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-native-permission-"));
  const configDir = path.join(root, "config", "opencode");
  const tool = input.tool ?? "bash";
  const filePath = path.join(root, input.file ?? "ordinary.txt");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "Synthetic fixture data.\n");
  const args = tool === "bash"
    ? { command: input.command, description: "Local permission fixture" }
    : { filePath, ...(tool === "write" ? { content: "Updated fixture.\n" } : {}) };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let body: { messages?: Array<{ role?: string }> };
    try { body = JSON.parse(raw); }
    catch { response.writeHead(404); response.end(); return; }
    const done = body.messages?.some((message) => message.role === "tool");
    const completion = {
      id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: done ? { content: "Fixture complete." } : {
        role: "assistant", tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }],
      }, finish_reason: null }],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(completion)}\n\n`);
    response.write(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture server has no port");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", NO_COLOR: "1",
  };
  for (const dir of [env.HOME!, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_CACHE_HOME!, configDir]) fs.mkdirSync(dir, { recursive: true });
  // OpenCode's native permission engine runs normally; this shell stub only prints a marker and ignores the proposed command.
  env.SHELL = path.join(root, "bash");
  fs.writeFileSync(env.SHELL, "#!/bin/sh\nprintf NATIVE_INTERCEPTED\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "opencode.json"), JSON.stringify({
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local fixture", options: { baseURL: `http://127.0.0.1:${address.port}/v1` }, models: { fixture: { name: "fixture", limit: { context: 100000, output: 10000 } } } } },
    model: "fixture/fixture", small_model: "fixture/fixture", permission: input.permission,
  }));
  if (input.agent) {
    fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "agents", "probe.md"), input.agent.replace("mode: subagent", "mode: primary"));
  }
  let stdout = "", stderr = "";
  try {
    const child = spawn(input.binary, ["run", "--pure", "--model", "fixture/fixture", "--format", "json", "--title", "Permission fixture", ...(input.agent ? ["--agent", "probe"] : []), "Execute the local fixture once."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
    let code;
    try { code = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); }); }
    finally { clearTimeout(timer); }
    if (code !== 0) throw new Error(`OpenCode fixture failed (${code}): ${stderr.slice(-1000)}`);
    const event = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as NativeEvent).find((item) => item.type === "tool_use");
    const state = event?.part?.state;
    if (event?.part?.tool === "invalid" && state?.output?.includes("unavailable tool")) return "deny";
    if (state?.error?.includes("user rejected permission")) return "ask";
    if (state?.error?.includes("rule which prevents")) return "deny";
    if (state?.status === "completed") {
      if (tool === "bash" && state.output !== "NATIVE_INTERCEPTED") throw new Error("Native fixture shell was not used");
      return "allow";
    }
    throw new Error(`Unexpected native permission result: ${JSON.stringify(state)} ${stderr.slice(-800)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
