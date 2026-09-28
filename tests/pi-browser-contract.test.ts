import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type RequireSchemas = (packageRoot: string, required: { playwright?: number; devtools?: number }) => void;
const roots: string[] = [];

function packageRoot(contract?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-browser-contract-"));
  roots.push(root);
  if (contract !== undefined) {
    fs.mkdirSync(path.join(root, "contract"));
    fs.writeFileSync(path.join(root, "contract", "browser-handoffs.v1.json"), `${JSON.stringify(contract)}\n`);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi browser handoff contract from an authenticated package root", () => {
  it("requires declared v2/v3 support without inferring it from a Pi version or v1 capability", async () => {
    const modulePath = new URL("../src/lib/pi-browser-contract.js", import.meta.url).href;
    const api = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
    const requireSchemas = api.requirePiBrowserHandoffSchemas as RequireSchemas;
    expect(requireSchemas).toBeTypeOf("function");
    expect(() => requireSchemas(packageRoot(), { playwright: 2 })).toThrow(/contract|schema|browser/i);
    expect(() => requireSchemas(packageRoot({ schemaVersion: 1, playwright: [1], devtools: [1, 2] }),
      { playwright: 2, devtools: 3 })).toThrow(/Playwright|DevTools|schema/i);
    const current = packageRoot({ schemaVersion: 1, playwright: [1, 2], devtools: [1, 2, 3] });
    expect(() => requireSchemas(current, { playwright: 2, devtools: 3 })).not.toThrow();
    expect(() => requireSchemas(current, {})).not.toThrow();
    expect(() => requireSchemas(packageRoot({ schemaVersion: 1, playwright: [2, 1], devtools: [1, 2, 3] }),
      { playwright: 2 })).toThrow(/contract|schema/i);
    expect(() => requireSchemas(packageRoot({ schemaVersion: 1, playwright: [1, 2], devtools: [1, 2, 3], extra: true }),
      { devtools: 3 })).toThrow(/contract|schema/i);
  });
});
