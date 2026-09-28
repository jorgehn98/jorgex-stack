import fs from "node:fs";
import path from "node:path";

const CONTRACT_FILE = "browser-handoffs.v1.json";
const MAX_CONTRACT_BYTES = 4 * 1024;

function fail(message: string): never {
  throw new Error(`Pi browser handoff contract: ${message}`);
}

function validSchemas(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16
    && value.every((schema, index) => Number.isInteger(schema) && schema > 0 && schema <= 16
      && (index === 0 || schema > value[index - 1]));
}

/** The caller must first authenticate the installed Pi package through its managed receipt. */
export function requirePiBrowserHandoffSchemas(
  packageRoot: string,
  required: { playwright?: number; devtools?: number },
): void {
  if (required.playwright === undefined && required.devtools === undefined) return;
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) fail("package root is not absolute");
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(packageRoot);
    if (!fs.statSync(realRoot).isDirectory()) fail("package root is not a directory");
  } catch { fail("installed Pi package root is unavailable"); }
  const contractDir = path.join(realRoot, "contract");
  const file = path.join(contractDir, CONTRACT_FILE);
  let raw: Buffer;
  try {
    const dirStat = fs.lstatSync(contractDir);
    const stat = fs.lstatSync(file);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()
      || stat.size > MAX_CONTRACT_BYTES) fail("contract is not a bounded regular file");
    if (fs.realpathSync(file) !== file) fail("contract path is not canonical");
    raw = fs.readFileSync(file);
    if (raw.byteLength > MAX_CONTRACT_BYTES || !Buffer.from(raw.toString("utf8"), "utf8").equals(raw)) {
      fail("contract is not bounded UTF-8");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Pi browser handoff contract: ")) throw error;
    fail("installed Pi does not provide a readable browser schema contract");
  }
  let contract: unknown;
  try { contract = JSON.parse(raw.toString("utf8")) as unknown; }
  catch { fail("contract is invalid JSON"); }
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) fail("contract is invalid");
  const record = contract as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["devtools", "playwright", "schemaVersion"].join("\0")
    || record.schemaVersion !== 1 || !validSchemas(record.playwright) || !validSchemas(record.devtools)) {
    fail("contract schema is invalid");
  }
  if (required.playwright !== undefined && !(record.playwright as number[]).includes(required.playwright)) {
    fail(`Playwright handoff schema ${required.playwright} is unsupported`);
  }
  if (required.devtools !== undefined && !(record.devtools as number[]).includes(required.devtools)) {
    fail(`DevTools handoff schema ${required.devtools} is unsupported`);
  }
}
