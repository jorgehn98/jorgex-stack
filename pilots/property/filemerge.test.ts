import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { upsertTomlSection } from "../../src/lib/filemerge.js";

type Eol = "\n" | "\r\n";
type HeaderStyle = "canonical" | "commented" | "spaced-quoted" | "literal-quoted";

type PropertyCase = {
  eol: Eol;
  section: string;
  body: string;
  existing: string;
  targetPresent: boolean;
  beforeLines: string[];
  afterLines: string[];
};

const TARGET = "mcp_servers.target";
const OWN_SECTION = "mcp_servers.own";
const FOREIGN_SECTION = "foreign.settings";

const printableTextArb = fc.string({ maxLength: 18 }).map((value) =>
  value.replace(/[^\x20-\x7e]/g, " ").replace(/'''/g, "''"),
);

const commentTextArb = printableTextArb.map((value) => value.replace(/#/g, "").trim() || "comment");

const scalarValueArb = fc.oneof(
  printableTextArb.map((value) => JSON.stringify(value) ?? '""'),
  fc.integer({ min: -100, max: 100 }).map(String),
  fc.boolean().map(String),
);

const assignmentArb = fc.record({
  value: scalarValueArb,
  quotedKey: fc.boolean(),
  inlineComment: fc.option(commentTextArb, { nil: undefined }),
});

const bodyArb = fc.record({
  assignments: fc.array(assignmentArb, { minLength: 1, maxLength: 3 }),
  includeMultiline: fc.boolean(),
  multilineLines: fc.array(printableTextArb, { minLength: 1, maxLength: 3 }),
  trailingComment: fc.option(commentTextArb, { nil: undefined }),
}).map(({ assignments, includeMultiline, multilineLines, trailingComment }) => {
  const lines = assignments.map(({ value, quotedKey, inlineComment }, index) => {
    const key = quotedKey ? `"key ${index}"` : `key_${index}`;
    const comment = inlineComment === undefined ? "" : ` # ${inlineComment}`;
    return `${key} = ${value}${comment}`;
  });

  if (includeMultiline) {
    lines.push("instructions = '''", "[body.fake]", "# still inside body", ...multilineLines, "'''");
  }
  if (trailingComment !== undefined) lines.push(`# ${trailingComment}`);
  return lines.join("\n");
});

const foreignBodyArb = fc.record({
  value: scalarValueArb,
  multilineLines: fc.array(printableTextArb, { minLength: 1, maxLength: 3 }),
  comment: fc.option(commentTextArb, { nil: undefined }),
}).map(({ value, multilineLines, comment }) => {
  const note = comment === undefined ? "" : ` # ${comment}`;
  return [
    `note = ${value}${note}`,
    "details = '''",
    "[foreign.fake]",
    ...multilineLines,
    "'''",
  ].join("\n");
});

const rootArb = fc.record({
  value: scalarValueArb,
  comment: commentTextArb,
}).map(({ value, comment }) => [`# ${comment}`, `root_value = ${value}`]);

const headerStyleArb = fc.constantFrom<HeaderStyle>(
  "canonical",
  "commented",
  "spaced-quoted",
  "literal-quoted",
);

function renderHeader(section: string, style: HeaderStyle): string {
  const [namespace, leaf] = section.split(".");
  if (namespace === undefined || leaf === undefined) throw new Error(`Invalid generated section: ${section}`);

  switch (style) {
    case "commented":
      return `[${section}] # user comment`;
    case "spaced-quoted":
      return `[ ${namespace}."${leaf}" ] # quoted header`;
    case "literal-quoted":
      return `[${namespace}.'${leaf}']`;
    case "canonical":
      return `[${section}]`;
  }
}

function renderSection(section: string, style: HeaderStyle, body: string): string[] {
  return [renderHeader(section, style), ...body.split("\n")];
}

const propertyCaseArb = fc.record({
  eol: fc.constantFrom<Eol>("\n", "\r\n"),
  targetPresent: fc.boolean(),
  targetStyle: headerStyleArb,
  ownStyle: headerStyleArb,
  foreignStyle: headerStyleArb,
  root: rootArb,
  requestedBody: bodyArb,
  oldTargetBody: bodyArb,
  ownBody: bodyArb,
  foreignBody: foreignBodyArb,
}).map(({
  eol,
  targetPresent,
  targetStyle,
  ownStyle,
  foreignStyle,
  root,
  requestedBody,
  oldTargetBody,
  ownBody,
  foreignBody,
}) => {
  const beforeLines = [
    ...root,
    "",
    ...renderSection(OWN_SECTION, ownStyle, ownBody),
    "",
  ];
  const afterLines = [
    "",
    ...renderSection(FOREIGN_SECTION, foreignStyle, foreignBody),
    "",
  ];
  const targetLines = renderSection(TARGET, targetStyle, oldTargetBody);
  const lines = targetPresent
    ? [...beforeLines, ...targetLines, ...afterLines]
    : [...beforeLines, ...afterLines];

  return {
    eol,
    section: TARGET,
    body: requestedBody,
    existing: lines.join(eol),
    targetPresent,
    beforeLines,
    afterLines,
  } satisfies PropertyCase;
});

function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function expectedOnce(input: PropertyCase): string {
  const blockLines = [`[${input.section}]`, ...input.body.trim().split("\n")];
  if (!input.targetPresent) {
    const existing = normalizeEol(input.existing);
    return `${existing}\n${blockLines.join("\n")}\n`;
  }

  return [...input.beforeLines, ...blockLines, ...input.afterLines].join("\n");
}

describe("piloto property de upsertTomlSection", () => {
  it("aplica el cuerpo, conserva secciones ajenas y queda idempotente", () => {
    fc.assert(
      fc.property(propertyCaseArb, (input) => {
        const once = upsertTomlSection(input.existing, input.section, input.body);
        expect(normalizeEol(once)).toBe(expectedOnce(input));

        const twice = upsertTomlSection(once, input.section, input.body);
        expect(twice).toBe(once);
      }),
      { numRuns: 100, seed: 20260831 },
    );
  });
});
