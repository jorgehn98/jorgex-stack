import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { stackRoot } from "../src/lib/paths.js";
import { nativePermission } from "./fixtures/opencode-native.js";

const binary = process.env.JORGEX_OPENCODE_BIN;
const permission = JSON.parse(fs.readFileSync(path.join(stackRoot(), "config", "defaults.json"), "utf8")).opencode.permission;
const models = { strong: { model: "fixture/fixture" }, standard: { model: "fixture/fixture" }, cheap: { model: "fixture/fixture" } };
const safeDiff = "git --no-pager -c core.fsmonitor=false -c log.showSignature=false diff --no-ext-diff --no-textconv --end-of-options";

describe.skipIf(!binary || process.platform === "win32")("OpenCode 1.18.30 native permission contract", () => {
  beforeAll(() => { expect(execFileSync(binary!, ["--version"], { encoding: "utf8" }).trim()).toBe("1.18.30"); });
  // Contrato fresco permisivo estilo gentle-ai (T01): trabajo ordinario en
  // allow, ask solo para rebase/reset-hard y familia ssh, deny solo para
  // destrucción evidente. Sin red bash para secretos o rutas de sistema: esa
  // cobertura vive en read/edit. Filas fijadas por observación contra el
  // binario real (1.18.31 disponible localmente; el gate versionado sigue
  // siendo 1.18.30): no forzar expectativas, fijar lo observado.
  it.each([
    ["printf ordinary", "allow"],
    ["rm -rf ordinary", "allow"], ["rm -rf /tmp/ordinary", "allow"],
    ["sudo printf ordinary", "allow"],
    ["find . -delete", "allow"], ["find . -exec rm -rf /tmp/ordinary \\;", "allow"],
    ["truncate -s 0 ordinary", "allow"], ["Remove-Item -Recurse ordinary", "allow"],
    ["pnpm dlx cowsay hello", "allow"],
    ["python -c \"print(1)\"", "allow"], ["node -e \"1\"", "allow"], ["sh -c \"printf hi\"", "allow"],
    ["git status", "allow"], ["git diff", "allow"], ["git log -10", "allow"],
    ["git push origin main", "allow"], ["git push --force origin main", "allow"],
    ["git push --force-with-lease origin main", "allow"], ["git push origin main -f", "allow"],
    ["GIT_OPTIONAL_LOCKS=0 git push --force origin main", "allow"],
    ["git commit -m ordinary", "allow"], ["git clean -fd", "allow"],
    ["git checkout main", "allow"], ["git switch main", "allow"], ["docker run ordinary", "allow"],
    ["git checkout -- ordinary", "allow"], ["git checkout -f main", "allow"], ["git restore ordinary", "allow"],
    ["git switch --discard-changes main", "allow"], ["cd ordinary && git restore ordinary", "allow"],
    ["git reset --hard", "ask"], ["git reset --hard HEAD~1", "ask"],
    ["git rebase", "ask"], ["git rebase main", "ask"],
    ["ssh example.com", "ask"], ["scp a b", "ask"], ["sftp user@host", "ask"], ["rsync -a a b", "ask"],
    ["dd if=ordinary of=output", "deny"], ["/usr/bin/dd if=ordinary of=output", "deny"],
    ["mkfs.ext4 ordinary", "deny"], ["shred ordinary", "deny"], ["format ordinary", "deny"],
    // Patrones exactos sin `*` inicial: no casan con prefijo env ni con ruta.
    ["FOO=bar git reset --hard", "allow"], ["/usr/bin/git reset --hard", "allow"],
    ["FOO=bar rm -rf ordinary", "allow"], ["FOO=bar sudo printf ordinary", "allow"],
    ["printf ordinary; rm -rf ordinary", "allow"],
    // Sin red bash para secretos o raíz: lo observado en el binario real es
    // allow; la protección de secretos vive en read/edit (filas read/write).
    ["rm -rf /", "allow"], ["sudo rm -rf /", "allow"], ["rm -rf /etc/ordinary", "allow"],
    ["cat .env", "allow"], ["cat ~/.ssh/id_ed25519", "allow"], ["FOO=bar rm -rf .env", "allow"],
  ] as const)("%s → %s", async (command, expected) => {
    expect(await nativePermission({ binary: binary!, permission, command })).toBe(expected);
  }, 25000);
  it.each([
    ["read", "ordinary.txt", "allow"], ["write", "ordinary.txt", "allow"], ["read", ".env", "deny"],
    ["write", ".ssh/id_rsa", "deny"], ["read", ".env.example", "allow"],
  ] as const)("%s %s → %s", async (tool, file, expected) => {
    expect(await nativePermission({ binary: binary!, permission, tool, file })).toBe(expected);
  }, 25000);
  it("a full writer still inherits protected edit paths", async () => {
    const [agent] = opencodeAdapter.renderAgent({ name: "probe", description: "Permission fixture", mode: "subagent", tier: "standard", readonly: false, bash: "full", spawn: true, body: "Use the local fixture." }, models);
    expect(await nativePermission({ binary: binary!, permission, tool: "write", file: ".env", agent: agent!.content })).toBe("deny");
  }, 25000);
  it.each([
    ["engram", "allow"], ["context7", "allow"], ["unknown", "allow"],
  ] as const)("MCP %s read_docs → %s", async (name, expected) => {
    expect(await nativePermission({ binary: binary!, permission, mcp: { name } })).toBe(expected);
  }, 25000);
  it.each([
    ["none", "printf ordinary", "deny"], ["full", "rm -rf ordinary", "allow"],
    ["git-read", "printf ordinary", "deny"], ["git-read", `${safeDiff} HEAD`, "allow"],
    // Sin denies bash de secretos en el canon, el subagente git-read hereda
    // solo denies de destrucción: diff sobre .env o *.key da allow observado.
    ["git-read", `${safeDiff} HEAD -- .env`, "allow"],
    ["git-read", `${safeDiff} HEAD -- credentials.key`, "allow"],
    ["git-read", `${safeDiff} HEAD; printf side-effect`, "deny"],
    ["git-read", `${safeDiff} $(printf side-effect)`, "deny"],
  ] as const)("%s subagent: %s → %s", async (bash, command, expected) => {
    const [agent] = opencodeAdapter.renderAgent({ name: "probe", description: "Permission fixture", mode: "subagent", tier: "standard", readonly: bash !== "full", bash, spawn: false, body: "Use the local fixture." }, models);
    expect(await nativePermission({ binary: binary!, permission, command, agent: agent!.content })).toBe(expected);
  }, 25000);
});
