import { describe, expect, it } from "vitest";
import { parseCliArgs, type Flags } from "../src/cli.js";

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
    [["quality", "plan with spaces.json", "--receipt", "receipt.json"], "plan with spaces.json", "receipt.json"],
    [["quality", "--receipt", "receipt.json", "plan with spaces.json"], "plan with spaces.json", "receipt.json"],
  ] as const)("reconoce quality con plan y receipt sin mezclar posicionales y flags: %j", (argv, plan, receipt) => {
    const parsed = parseCliArgs([...argv]);
    const flags = parsed.flags as Flags & { receipt?: string };

    expect(parsed.action).toBe("run");
    expect(parsed.command).toBe("quality");
    expect(flags.positional).toEqual([plan]);
    expect(flags.receipt).toBe(receipt);
    expect(flags.unknownFlags).toEqual([]);
  });

  it.each([
    [["quality", "plan.json", "--receipt"]],
    [["quality", "plan.json", "--receipt="]],
  ] as const)("rechaza %j como flag --receipt incompleto, no como receipt ausente", (argv) => {
    const parsed = parseCliArgs([...argv]);

    expect(parsed.action).toBe("unknown-flags");
    expect(parsed.flags.positional).toEqual(["plan.json"]);
    expect(parsed.flags.unknownFlags).toEqual([argv[2]]);
    expect(parsed.flags.receipt).toBeUndefined();
  });

  it.each([
    ["--agents"],
    ["--agents", "opencode"],
    ["--agents=opencode"],
    ["-a"],
    ["-a", "opencode"],
    ["--target-dir"],
    ["--target-dir", "tmp"],
    ["--target-dir=tmp"],
    ["--mode"],
    ["--mode", "human"],
    ["--mode=human"],
    ["--subagent-concurrency"],
    ["--subagent-concurrency", "serial"],
    ["--subagent-concurrency=serial"],
    ["--dry-run"],
    ["--yes"],
    ["-y"],
    ["--list"],
    ["--check"],
    ["--remove-engram"],
    ["--playwright"],
    ["--remove-playwright"],
    ["--devtools"],
    ["--no-devtools"],
  ] as const)("rechaza %j en quality como flag de otro comando sin convertir su operando en plan", (...args) => {
    const [flag, operand] = args;
    const parsed = parseCliArgs(["quality", "plan.json", flag, ...(operand === undefined ? [] : [operand])]);

    expect(parsed.action).toBe("unknown-flags");
    expect(parsed.flags.unknownFlags).toEqual([flag]);
    expect(parsed.flags.positional).toEqual(["plan.json"]);
  });

  it.each([
    "install",
    "sync",
    "models",
    "update",
    "doctor",
    "restore",
    "uninstall",
  ] as const)("no acepta --receipt en el comando no-quality %s", (command) => {
    const parsed = parseCliArgs([command, "--receipt", "receipt.json"]);

    expect(parsed.action).toBe("unknown-flags");
    expect(parsed.flags.unknownFlags).toEqual(["--receipt"]);
    expect(parsed.flags.receipt).toBeUndefined();
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

  it.each([
    ["--playwright", "playwright"],
    ["--remove-playwright", "removePlaywright"],
    ["--devtools", "devtools"],
    ["--no-devtools", "noDevtools"],
  ] as const)("reconoce %s como flag de navegador", (flag, property) => {
    const parsed = parseCliArgs(["install", flag]);

    expect(parsed.action).toBe("run");
    expect(parsed.flags[property]).toBe(true);
    expect(parsed.flags.unknownFlags).toEqual([]);
  });
});

describe("flags desconocidos", () => {
  it.each([
    [["install", "--frobnicate"], ["--frobnicate"]],
    [["install", "--mode=programmatic", "--frobnicate"], ["--frobnicate"]],
    [["install", "-x"], ["-x"]],
    [["--frobnicate"], ["--frobnicate"]],
    [["install", "--foo", "--bar"], ["--foo", "--bar"]],
  ] as const)("%j → action unknown-flags con los flags recogidos", (argv, expected) => {
    const parsed = parseCliArgs([...argv]);

    expect(parsed.action).toBe("unknown-flags");
    expect(parsed.flags.unknownFlags).toEqual([...expected]);
  });

  it("no marca como desconocido un argumento posicional legítimo (restore <id>)", () => {
    const parsed = parseCliArgs(["restore", "20260626-094855"]);

    expect(parsed.action).toBe("run");
    expect(parsed.flags.unknownFlags).toEqual([]);
    expect(parsed.flags.positional).toEqual(["20260626-094855"]);
  });

  it("un comando desconocido gana sobre el flag desconocido (precedencia)", () => {
    const parsed = parseCliArgs(["instal", "--frobnicate"]);

    expect(parsed.action).toBe("unknown");
    expect(parsed.unknownCommand).toBe("instal");
  });

  it("un flag conocido sin valor no traga el siguiente token: este cae a desconocido", () => {
    const parsed = parseCliArgs(["install", "--target-dir", "--frobnicate"]);

    expect(parsed.action).toBe("unknown-flags");
    expect(parsed.flags.targetDir).toBeUndefined();
    expect(parsed.flags.unknownFlags).toEqual(["--frobnicate"]);
  });

  it("--help gana sobre un flag desconocido", () => {
    const parsed = parseCliArgs(["install", "--frobnicate", "--help"]);

    expect(parsed.action).toBe("help");
  });

  it("--version gana sobre un flag desconocido", () => {
    const parsed = parseCliArgs(["install", "--frobnicate", "--version"]);

    expect(parsed.action).toBe("version");
  });
});
