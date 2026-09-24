// T05 RED for T07 settings boundary (tests only, no prod change).
//
// Contract under test (pure helper, no HOME/network):
// - Export `planPiManagedSettings(settingsJson, previousSource, nextSource)`
//   from src/lib/pi-package-lifecycle.ts.
// - Caller has already authenticated the previous receipt when previousSource
//   is non-null; the helper itself must NOT infer ownership from raw JSON
//   (a bare string entry never counts as owned, even when it equals
//   previousSource).
// - Fresh (previousSource null) appends `{source:nextSource,skills:[],prompts:[]}`
//   only when NO existing jorgex-pi entry exists; any manual string, edited
//   object, duplicate, invalid JSON/shape, or divergent source blocks null.
// - Owned migration replaces only the exact managed object
//   `{source:previousSource,skills:[],prompts:[]}` with
//   `{source:nextSource,skills:[],prompts:[]}`, preserving foreign entries,
//   other top-level keys, and order.
// - Same-source (`nextSource === previousSource`) returns stable canonical
//   JSON and a second application must not change the object (idempotence).
// - Synthetic stable versions 9.9.9/9.9.10 are test-only and never claim a
//   published Pi release nor select a next version.
import { describe, expect, it } from "vitest";

const PREV = "npm:jorgex-pi@9.9.9";
const NEXT = "npm:jorgex-pi@9.9.10";
const FOREIGN_JPIX = "npm:jorgex-pi@8.0.0";
const FOREIGN = "npm:foreign@1.0.0";

function managed(source: string): { source: string; skills: never[]; prompts: never[] } {
  return { source, skills: [], prompts: [] };
}

type SettingsCase = {
  readonly name: string;
  readonly settingsJson: string;
  readonly previousSource: string | null;
  readonly nextSource: string;
  readonly expectedParsed: unknown | null;
};

const CASES: readonly SettingsCase[] = [
  {
    name: "fresh adds managed entry preserving foreign and keys",
    settingsJson: JSON.stringify({ theme: "custom", packages: [FOREIGN], extra: { note: "keep" } }),
    previousSource: null,
    nextSource: NEXT,
    expectedParsed: { theme: "custom", packages: [FOREIGN, managed(NEXT)], extra: { note: "keep" } },
  },
  {
    name: "owned migration replaces only exact entry preserving order",
    settingsJson: JSON.stringify({ theme: "custom", packages: [FOREIGN, managed(PREV)], extra: 42 }),
    previousSource: PREV,
    nextSource: NEXT,
    expectedParsed: { theme: "custom", packages: [FOREIGN, managed(NEXT)], extra: 42 },
  },
  {
    name: "foreign jorgex-pi blocks fresh",
    settingsJson: JSON.stringify({ packages: [FOREIGN, managed(FOREIGN_JPIX)] }),
    previousSource: null,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "manual string blocks even when it equals previousSource",
    settingsJson: JSON.stringify({ packages: [FOREIGN, PREV] }),
    previousSource: PREV,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "duplicate managed entries block",
    settingsJson: JSON.stringify({ packages: [managed(PREV), managed(PREV)] }),
    previousSource: PREV,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "edited managed object blocks",
    settingsJson: JSON.stringify({ packages: [FOREIGN, { source: PREV, skills: ["custom"], prompts: [] }] }),
    previousSource: PREV,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "invalid JSON blocks",
    settingsJson: "{broken",
    previousSource: PREV,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "invalid shape blocks",
    settingsJson: JSON.stringify({ theme: "custom" }),
    previousSource: null,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "source mismatch blocks when previous entry is absent",
    settingsJson: JSON.stringify({ packages: [FOREIGN] }),
    previousSource: PREV,
    nextSource: NEXT,
    expectedParsed: null,
  },
  {
    name: "same source returns stable canonical JSON",
    settingsJson: JSON.stringify({ theme: "custom", packages: [FOREIGN, managed(PREV)] }),
    previousSource: PREV,
    nextSource: PREV,
    expectedParsed: { theme: "custom", packages: [FOREIGN, managed(PREV)] },
  },
] as const;

describe("[T05-RED] planPiManagedSettings settings boundary", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("case %s", async (_name, testCase) => {
    const mod = (await import("../src/lib/pi-package-lifecycle.js")) as any;
    const plan = mod.planPiManagedSettings as unknown;
    expect(typeof plan, "missing export planPiManagedSettings(settingsJson, previousSource, nextSource)").toBe("function");
    const fn = plan as (settingsJson: string, previousSource: string | null, nextSource: string) => string | null;
    const before = testCase.settingsJson;
    const result = fn(testCase.settingsJson, testCase.previousSource, testCase.nextSource);

    if (testCase.expectedParsed === null) {
      expect(result, `blocking case must return null: ${testCase.name}`).toBeNull();
      expect(testCase.settingsJson, "pure helper must not mutate its input").toBe(before);
      return;
    }

    expect(typeof result, `success case must return JSON: ${testCase.name}`).toBe("string");
    const parsed: any = JSON.parse(result as string);
    expect(parsed, `parsed output must match expected: ${testCase.name}`).toEqual(testCase.expectedParsed);

    // Stable canonical JSON: no pretty print, re-stringify is identical.
    expect(JSON.stringify(parsed), `output must be canonical JSON: ${testCase.name}`).toBe(result);

    // Preserve foreign entries, other top-level keys, and order.
    const inputParsed: any = JSON.parse(testCase.settingsJson);
    expect(Object.keys(parsed), `top-level key order must be preserved: ${testCase.name}`).toEqual(
      Object.keys(inputParsed),
    );
    expect(parsed.packages[0], `foreign entry must stay first: ${testCase.name}`).toBe(FOREIGN);
    expect(parsed.theme, "foreign top-level settings must be preserved").toBe(inputParsed.theme);

    // Idempotence: a second application with the published source must not change the object.
    const publishedSource: string = testCase.nextSource;
    const second = fn(result as string, publishedSource, publishedSource);
    expect(second, `second application must be stable: ${testCase.name}`).toBe(result);
  });
});

// T05 RED safe managed private-release uninstall substep (tests only, no prod change).
//
// Desired contract (pure helper, no HOME/network, caller authenticates receipt):
// - Export `planPiManagedRemoval(settingsJson, ownedSource)`
//   from src/lib/pi-package-lifecycle.ts.
// - Before removing a verified schema1 managed Pi release, plans settings.json
//   removing ONLY the exact owned `{source:ownedSource,skills:[],prompts:[]}`
//   while keeping `npm:gentle-engram`, `npm:pi-mcp-adapter`, foreign packages
//   and other top-level keys/order.
// - Manual bare string, edited object, duplicate/ambiguous jorgex-pi,
//   missing source, or corrupt settings => null with no writes.
// - Synthetic 9.9.x versions are test-only and never select a future release.
type RemovalCase = {
  readonly name: string;
  readonly settingsJson: string;
  readonly ownedSource: string;
  readonly expectedParsed: unknown | null;
};

const GENTLE = "npm:gentle-engram@9.9.99";
const ADAPTER = "npm:pi-mcp-adapter@9.9.98";

const REMOVAL_CASES: readonly RemovalCase[] = [
  {
    name: "removes only exact owned preserving gentle/adapter/foreign and keys",
    settingsJson: JSON.stringify({
      theme: "custom",
      packages: [FOREIGN, GENTLE, ADAPTER, managed(PREV)],
      extra: { note: "keep" },
    }),
    ownedSource: PREV,
    expectedParsed: {
      theme: "custom",
      packages: [FOREIGN, GENTLE, ADAPTER],
      extra: { note: "keep" },
    },
  },
  {
    name: "manual string blocks even when it equals ownedSource",
    settingsJson: JSON.stringify({ packages: [FOREIGN, GENTLE, PREV] }),
    ownedSource: PREV,
    expectedParsed: null,
  },
  {
    name: "edited managed object blocks",
    settingsJson: JSON.stringify({
      packages: [FOREIGN, { source: PREV, skills: ["custom"], prompts: [] }],
    }),
    ownedSource: PREV,
    expectedParsed: null,
  },
  {
    name: "duplicate managed entries block",
    settingsJson: JSON.stringify({ packages: [managed(PREV), managed(PREV)] }),
    ownedSource: PREV,
    expectedParsed: null,
  },
  {
    name: "ambiguous divergent jorgex-pi blocks",
    settingsJson: JSON.stringify({ packages: [managed(PREV), managed(FOREIGN_JPIX)] }),
    ownedSource: PREV,
    expectedParsed: null,
  },
  {
    name: "missing owned source blocks",
    settingsJson: JSON.stringify({ packages: [FOREIGN, GENTLE, ADAPTER] }),
    ownedSource: PREV,
    expectedParsed: null,
  },
  {
    name: "invalid JSON blocks",
    settingsJson: "{broken",
    ownedSource: PREV,
    expectedParsed: null,
  },
  {
    name: "invalid shape blocks",
    settingsJson: JSON.stringify({ theme: "custom" }),
    ownedSource: PREV,
    expectedParsed: null,
  },
];

describe("[T05-RED] planPiManagedRemoval private-release uninstall planning", () => {
  it.each(REMOVAL_CASES.map((c) => [c.name, c] as const))("case %s", async (_name, testCase) => {
    const mod = (await import("../src/lib/pi-package-lifecycle.js")) as any;
    const plan = mod.planPiManagedRemoval as unknown;
    expect(typeof plan, "missing export planPiManagedRemoval(settingsJson, ownedSource)").toBe("function");
    const fn = plan as (settingsJson: string, ownedSource: string) => string | null;
    const before = testCase.settingsJson;
    const result = fn(testCase.settingsJson, testCase.ownedSource);

    if (testCase.expectedParsed === null) {
      expect(result, `blocking case must return null: ${testCase.name}`).toBeNull();
      expect(testCase.settingsJson, "pure helper must not mutate its input").toBe(before);
      return;
    }

    expect(typeof result, `success case must return JSON: ${testCase.name}`).toBe("string");
    const parsed: any = JSON.parse(result as string);
    expect(parsed, `parsed output must match expected: ${testCase.name}`).toEqual(testCase.expectedParsed);

    // Stable canonical JSON: no pretty print, re-stringify is identical.
    expect(JSON.stringify(parsed), `output must be canonical JSON: ${testCase.name}`).toBe(result);

    // Preserve other top-level keys/order and foreign registrations; drop only owned.
    const inputParsed: any = JSON.parse(testCase.settingsJson);
    expect(Object.keys(parsed), `top-level key order must be preserved: ${testCase.name}`).toEqual(
      Object.keys(inputParsed),
    );
    expect(parsed.packages, `only exact owned entry must be removed: ${testCase.name}`).toEqual(
      (testCase.expectedParsed as any).packages,
    );
    expect(JSON.stringify(result), "owned source must be gone from output").not.toContain(PREV);
    expect(testCase.settingsJson, "pure helper must not mutate its input").toBe(before);
  });
});
