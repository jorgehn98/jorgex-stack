import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const fullMatch = (value, pattern) => typeof value === "string" && pattern.exec(value)?.[0] === value;

export function readPiPin(value) {
  const pkg = value?.package;
  const tarball = value?.tarball;
  if (
    pkg?.name !== "jorgex-pi" ||
    !fullMatch(pkg.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/) ||
    pkg.source !== `npm:jorgex-pi@${pkg.version}` ||
    !fullMatch(value?.provenance?.commit, /^[0-9a-f]{40}$/) ||
    !Number.isSafeInteger(tarball?.bytes) || tarball.bytes <= 0 || tarball.bytes > 125_829_120 ||
    !fullMatch(tarball.sha256, /^[0-9a-f]{64}$/) ||
    !fullMatch(tarball.sha512, /^[0-9a-f]{128}$/)
  ) {
    throw new Error("Invalid JorgeX Pi pin metadata");
  }
  return {
    url: `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${pkg.version}.tgz`,
    bytes: tarball.bytes,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error("pi-pin.mjs accepts no arguments");
    const value = JSON.parse(readFileSync(new URL("../../src/lib/pi-runtime-pin.json", import.meta.url), "utf8"));
    const { url, bytes } = readPiPin(value);
    process.stdout.write(`url=${url}\nbytes=${bytes}\n`);
  } catch {
    console.error("Cannot read a valid JorgeX Pi pin");
    process.exitCode = 1;
  }
}
