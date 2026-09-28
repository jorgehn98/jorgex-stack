import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { browserTreeSha256 } from "../src/lib/browser-stage.js";
import { activateManagedBrowserTree, planManagedBrowserInvocation } from "../src/lib/browser-managed.js";

it.skipIf(process.platform !== "win32").each(["@playwright/cli", "chrome-devtools-mcp"] as const)(
  "managed browser Windows guard blocks tampered %s before loading entry",
  async (packageName) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-win-"));
    try {
      const stageDir = path.join(root, "stage");
      const stateDir = path.join(root, "state");
      const nodeModulesPath = path.join(stageDir, "node_modules");
      const treePath = path.join(nodeModulesPath, ...packageName.split("/"));
      const entryPath = path.join(treePath, "entry.js");
      const marker = path.join(root, "marker.txt");
      const version = "9.9.10";
      const integrity = `sha512-${Buffer.alloc(64, 19).toString("base64")}`;
      fs.mkdirSync(treePath, { recursive: true });
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(treePath, "package.json"), `${JSON.stringify({ name: packageName, version, type: "module" })}\n`);
      fs.writeFileSync(entryPath, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
      const receipt = await activateManagedBrowserTree({
        stateDir, packageName,
        release: { version, integrity, tarballUrl: packageName === "@playwright/cli"
          ? `https://registry.npmjs.org/@playwright/cli/-/cli-${version}.tgz`
          : `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${version}.tgz` },
        staged: { treePath, nodeModulesPath, treeSha256: browserTreeSha256(nodeModulesPath, stageDir),
          closure: [{ name: packageName, version, integrity }] },
        entryPath,
      });
      const args = packageName === "@playwright/cli" ? ["--version"]
        : ["--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"];
      const plan = planManagedBrowserInvocation(stateDir, packageName, args);
      expect(plan.command).toBe(process.execPath);
      const run = () => spawnSync(plan.command, plan.args, { encoding: "utf8", timeout: 30_000 });
      const intact = run();
      expect(intact.error).toBeUndefined();
      expect(intact.status, intact.stderr).toBe(0);
      expect(fs.readFileSync(marker, "utf8")).toBe("ran");
      fs.unlinkSync(marker);
      fs.appendFileSync(receipt.entryPath, "// tampered after planning\n");
      const tampered = run();
      expect(tampered.status).not.toBe(0);
      expect(`${tampered.stdout ?? ""}${tampered.stderr ?? ""}`).toMatch(/digest|drift/i);
      expect(fs.existsSync(marker)).toBe(false);
      expect(createHash("sha256").update(fs.readFileSync(receipt.launcherPath)).digest("hex")).toBe(receipt.launcherSha256);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "managed browser Windows activation preserves a replaced foreign lock",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-win-lock-"));
    try {
      const stageDir = path.join(root, "stage");
      const stateDir = path.join(root, "state");
      const nodeModulesPath = path.join(stageDir, "node_modules");
      const treePath = path.join(nodeModulesPath, "@playwright", "cli");
      const entryPath = path.join(treePath, "entry.js");
      const lockPath = path.join(stateDir, ".browser-managed", "playwright-cli", ".activation.lock");
      const foreignLock = Buffer.from("foreign Windows lock owner\n");
      const integrity = `sha512-${Buffer.alloc(64, 19).toString("base64")}`;
      fs.mkdirSync(treePath, { recursive: true });
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(treePath, "package.json"), '{"name":"@playwright/cli","version":"9.9.10"}\n');
      fs.writeFileSync(entryPath, "export {};\n");

      const originalLstat = fs.lstatSync;
      let replaced = false;
      vi.spyOn(fs, "lstatSync").mockImplementation(((file: unknown, options: unknown) => {
        const observed = Reflect.apply(originalLstat, fs, [file, options]) as fs.Stats;
        if (!replaced && path.resolve(String(file)) === path.resolve(lockPath)) {
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, foreignLock);
          replaced = true;
        }
        return observed;
      }) as typeof fs.lstatSync);

      await activateManagedBrowserTree({
        stateDir,
        packageName: "@playwright/cli",
        release: {
          version: "9.9.10",
          integrity,
          tarballUrl: "https://registry.npmjs.org/@playwright/cli/-/cli-9.9.10.tgz",
        },
        staged: {
          treePath, nodeModulesPath, treeSha256: browserTreeSha256(nodeModulesPath, stageDir),
          closure: [{ name: "@playwright/cli", version: "9.9.10", integrity }],
        },
        entryPath,
      });

      expect(replaced).toBe(true);
      expect(fs.readFileSync(lockPath)).toEqual(foreignLock);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
