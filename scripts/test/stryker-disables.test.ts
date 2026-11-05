// Tests the rules for the Stryker comments in shipped code and their table in testing.md
// (scripts/stryker-disables.ts), which scripts/check-stryker-disables.ts applies.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  END,
  START,
  formatInventory,
  formatTable,
  parseDisables,
  readTable,
  section,
  tableRows,
  withTable,
} from "../stryker-disables.ts";

const FILE = "packages/explorer-verify/src/a.ts";

describe("parseDisables", () => {
  it("reads a next-line comment with its mutators and reason", () => {
    const text = [
      "const a = 1;",
      "  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent. Because.",
      "  if (a) {}",
    ].join("\n");
    assert.deepEqual(parseDisables(FILE, text), {
      disables: [
        {
          file: FILE,
          line: 2,
          mutators: ["ConditionalExpression", "BlockStatement"],
          reason: "equivalent. Because.",
        },
      ],
      problems: [],
    });
  });

  it("refuses every other form", () => {
    const lines = [
      "// Stryker disable ConditionalExpression: lasts to the end of the file",
      "// Stryker restore ConditionalExpression",
      "// Stryker disable next-line all: names no mutator",
      "// Stryker disable next-line ConditionalExpression",
      "// Stryker disable next-line ConditionalExpression:",
      "/* Stryker disable next-line ConditionalExpression: a block comment */",
      "// Stryker disable next-line Conditional: an unknown mutator",
    ];
    const { disables, problems } = parseDisables(FILE, lines.join("\n"));
    assert.deepEqual(disables, []);
    assert.equal(problems.length, lines.length);
    assert.match(problems[0] ?? "", /a\.ts:1: write it as/);
    assert.match(problems[2] ?? "", /a\.ts:3: unknown mutator all/);
    assert.match(problems[6] ?? "", /a\.ts:7: unknown mutator Conditional/);
  });

  it("ignores lines that do not mention a Stryker disable or restore", () => {
    assert.deepEqual(parseDisables(FILE, "// Stryker runs the tests\nconst a = 1;\r\n"), {
      disables: [],
      problems: [],
    });
  });
});

describe("the inventory and the table", () => {
  const disables = parseDisables(
    FILE,
    "// Stryker disable next-line Regex,StringLiteral: equivalent. a | b.",
  ).disables;

  it("prints file:line, the mutators and the reason", () => {
    assert.equal(formatInventory(disables), `${FILE}:1  Regex,StringLiteral  equivalent. a | b.\n`);
  });

  it("lists file, mutators and reason, escaping a pipe, without line numbers", () => {
    const rows = tableRows(disables);
    assert.deepEqual(rows, [
      [`\`${FILE}\``, "Regex, StringLiteral", String.raw`equivalent. a \| b.`],
    ]);
    assert.deepEqual(readTable(formatTable(rows)), rows);
  });

  it("reads a padded table as the formatter writes it", () => {
    const padded = [
      "| File  | Mutators | Why |",
      "| ----- | -------- | --- |",
      "| `x`   | Regex    | y   |",
    ].join("\n");
    assert.deepEqual(readTable(padded), [["`x`", "Regex", "y"]]);
  });

  it("replaces only the text between the markers", () => {
    const doc = `before\n${START}\nold\n${END}\nafter\n`;
    const written = withTable(doc, tableRows(disables));
    assert.ok(written.startsWith(`before\n${START}\n\n| File |`));
    assert.ok(written.endsWith(`\n\n${END}\nafter\n`));
    assert.deepEqual(readTable(section(written) ?? ""), tableRows(disables));
  });

  it("finds no section when a marker is missing or out of order", () => {
    assert.equal(section("no markers"), undefined);
    assert.equal(section(`${END}\n${START}`), undefined);
    assert.throws(() => withTable("no markers", []), /has no/);
  });
});
