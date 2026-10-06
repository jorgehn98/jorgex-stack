import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { listBackups } from "../src/lib/backup.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync("/var/tmp/jx-pi-permissions-"); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const options = () => ({ runtimes: ["pi" as const], targetDir: root, scope: { section: "config" as const }, dryRun: false, yes: true });
const policy = () => path.join(root, "pi-agent", "extensions", "pi-permission-system", "config.json");

/** Última coincidencia gana y `*` cruza separadores, como documenta el proveedor. */
function decide(rules: Record<string, string>, target: string): string | undefined {
  let decision: string | undefined;
  for (const [pattern, effect] of Object.entries(rules)) {
    const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    if (expression.test(target)) decision = effect;
  }
  return decision;
}

it("seeds a prompt-free native policy that denies only secret paths", async () => {
  expect(await runInstall(options())).toBe(0);
  const config = JSON.parse(fs.readFileSync(policy(), "utf8"));
  expect(config.yoloMode).toBe(true);
  expect(config.permission["*"]).toBe("allow");
  expect(config.permission.bash).toEqual({ "*": "allow" });
  expect(config.permission.external_directory).toBe("allow");
  expect(Object.keys(config.permission).sort()).toEqual(["*", "bash", "external_directory", "path"]);

  const paths = config.permission.path as Record<string, string>;
  for (const secret of ["/work/app/.env", "/work/app/.env.local", "/home/u/.ssh/id_ed25519", "/home/u/.aws/credentials", "/home/u/.npmrc", "/home/u/.git-credentials", "/work/tls/server.pem", "/work/tls/server.key"]) {
    expect(decide(paths, secret), secret).toBe("deny");
  }
  for (const ordinary of ["/work/app/.env.example", "/work/app/src/index.ts", "/home/u/notes.md"]) {
    expect(decide(paths, ordinary), ordinary).toBe("allow");
  }
});

it("is idempotent and leaves the seeded policy in place on uninstall", async () => {
  expect(await runInstall(options())).toBe(0);
  const before = fs.readFileSync(policy(), "utf8");
  const backups = listBackups(path.join(root, ".jorgex-stack", "backups"));
  expect(await runInstall({ ...options(), command: "update" })).toBe(0);
  expect(fs.readFileSync(policy(), "utf8")).toBe(before);
  expect(listBackups(path.join(root, ".jorgex-stack", "backups"))).toEqual(backups);
  expect(await runUninstall({ ...options(), removeEngram: false })).toBe(0);
  expect(fs.readFileSync(policy(), "utf8")).toBe(before);
});

it("preserves an existing policy byte-identically", async () => {
  const personal = '{\n  "yoloMode": false,\n  "permission": { "bash": { "*": "ask" } }\n}\n';
  fs.mkdirSync(path.dirname(policy()), { recursive: true });
  fs.writeFileSync(policy(), personal);
  expect(await runInstall(options())).toBe(0);
  expect(fs.readFileSync(policy(), "utf8")).toBe(personal);
});
