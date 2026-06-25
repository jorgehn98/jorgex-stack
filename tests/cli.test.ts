import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";

describe("CLI argument parsing", () => {
  it.each([
    [["--help"], "install"],
    [["-h"], "install"],
    [["sync", "--help"], "sync"],
    [["sync", "-h"], "sync"],
    [["install", "--target-dir", "tmp", "--help"], "install"],
  ] as const)("%j imprime ayuda sin ejecutar el comando", (argv, command) => {
    const parsed = parseCliArgs([...argv]);

    expect(parsed.action).toBe("help");
    expect(parsed.command).toBe(command);
  });

  it.each([
    [["--version"], "install"],
    [["-v"], "install"],
    [["sync", "--version"], "sync"],
    [["sync", "-v"], "sync"],
  ] as const)("%j imprime versión sin ejecutar el comando", (argv, command) => {
    const parsed = parseCliArgs([...argv]);

    expect(parsed.action).toBe("version");
    expect(parsed.command).toBe(command);
  });

  it("parsea sync normal como ejecución", () => {
    const parsed = parseCliArgs(["sync", "--agents", "opencode", "--target-dir", "tmp", "--yes"]);

    expect(parsed.action).toBe("run");
    expect(parsed.command).toBe("sync");
    expect(parsed.flags).toMatchObject({
      agents: ["opencode"],
      targetDir: "tmp",
      yes: true,
    });
  });

  it.each([
    [["install", "--mode", "programmatic", "--subagent-concurrency", "serial"], { mode: "programmatic", subagentConcurrency: "serial" }],
    [["install", "--mode=programmatic", "--subagent-concurrency=parallel"], { mode: "programmatic", subagentConcurrency: "parallel" }],
  ] as const)("%j expone modo y concurrencia", (argv, expected) => {
    const parsed = parseCliArgs([...argv]);
    const flags = parsed.flags as { mode?: string; subagentConcurrency?: string };

    expect(parsed.action).toBe("run");
    expect(parsed.command).toBe("install");
    expect(flags).toMatchObject(expected);
  });

  it("acepta --mode human sin convertir subagent-concurrency en input posicional", () => {
    const parsed = parseCliArgs(["install", "--mode", "human"]);
    const flags = parsed.flags as { mode?: string; subagentConcurrency?: string; positional: string[] };

    expect(flags.mode).toBe("human");
    expect(flags.positional).toEqual([]);
  });

  it("no traga --subagent-concurrency como argumento posicional", () => {
    const parsed = parseCliArgs(["install", "--subagent-concurrency", "serial"]);

    expect(parsed.flags.positional).toEqual([]);
  });
});
