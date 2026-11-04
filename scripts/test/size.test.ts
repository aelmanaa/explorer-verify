// Tests the browser bundle helper (scripts/bundle.ts), the size budget rules
// (scripts/size-budget.ts) and the size check run as `pnpm run size` runs it (R-RUN-1, R-RUN-3).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { EMPTY_TABLE, bundleForBrowser, gzipSize } from "../bundle.ts";
import { compareSizes, formatReport, parseBudget } from "../size-budget.ts";
import type { BudgetEntry } from "../size-budget.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "size-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "verify",
    code: 'export { verify } from "explorer-verify";',
    measuredBytes: 100,
    ceilingBytes: 120,
    ...overrides,
  };
}

describe("bundleForBrowser (R-RUN-1)", () => {
  it("bundles a module and its imports into one minified ESM file", async () => {
    writeFileSync(path.join(dir, "lib.ts"), "export const answer: number = 40 + 2;\n");
    const code = await bundleForBrowser({
      contents: 'export { answer } from "./lib.ts";',
      resolveDir: dir,
    });
    assert.match(code, /export\s*\{/);
    assert.doesNotMatch(code, /: number/);
    assert.doesNotMatch(code, /\n\s+/, "minified");
  });

  it("bundles an entry file", async () => {
    const file = path.join(dir, "entry.ts");
    writeFileSync(file, "export const greeting = `hello`;\n");
    assert.match(await bundleForBrowser({ entry: file }), /hello/);
  });

  for (const specifier of ["node:fs", "fs", "node:crypto"]) {
    it(`fails the build on an import of the Node built-in "${specifier}"`, async () => {
      await assert.rejects(
        bundleForBrowser({ contents: `import "${specifier}";`, resolveDir: dir }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`Could not resolve "${specifier}"`));
          return true;
        },
      );
    });
  }
});

/** Writes a module that imports `routing/table.json`, which holds one row, and returns its importer. */
function withTable(): string {
  mkdirSync(path.join(dir, "routing"));
  writeFileSync(
    path.join(dir, "routing", "table.json"),
    JSON.stringify({ schemaVersion: 2, checked: "2026-11-03", chains: [{ chainId: 424242 }] }),
  );
  writeFileSync(
    path.join(dir, "routing", "resolve.ts"),
    'import table from "./table.json" with { type: "json" };\nexport const rows = table.chains;\n',
  );
  return 'export { rows } from "./routing/resolve.ts";';
}

describe("bundleForBrowser without the routing table (R-RUN-3)", () => {
  it("keeps the table's rows by default", async () => {
    const code = await bundleForBrowser({ contents: withTable(), resolveDir: dir });
    assert.match(code, /424242/);
  });

  it("replaces the table with an empty one when asked, so code and data are measured apart", async () => {
    const code = await bundleForBrowser(
      { contents: withTable(), resolveDir: dir },
      { withoutTable: true },
    );
    assert.doesNotMatch(code, /424242/);
    assert.match(code, /chains:\[\]/);
    assert.deepEqual(JSON.parse(EMPTY_TABLE), { schemaVersion: 2, checked: "", chains: [] });
  });
});

describe("bundleForBrowser with guarded imports (R-RUN-1)", () => {
  for (const code of [
    'export async function f() { try { await import("node:crypto"); } catch {} }',
    'export function f() { try { return require("fs"); } catch { return undefined; } }',
  ]) {
    it(`fails the build on a Node built-in inside try/catch: ${code}`, async () => {
      await assert.rejects(
        bundleForBrowser({ contents: code, resolveDir: dir }),
        /the bundle leaves imports unresolved: (node:crypto|fs)/,
      );
    });
  }
});

describe("gzipSize", () => {
  it("is the byte length of the default-level gzip of the text", () => {
    const text = "verify ".repeat(500);
    assert.equal(gzipSize(text), gzipSync(text, { level: 6 }).byteLength);
    assert.equal(gunzipSync(gzipSync(text)).toString(), text);
    assert.ok(gzipSize(text) < text.length);
  });
});

describe("parseBudget", () => {
  it("reads every entry in file order", () => {
    const entries = parseBudget({
      entries: [entry(), entry({ name: "index", code: 'export * from "explorer-verify";' })],
    });
    assert.deepEqual(
      entries.map(({ name }) => name),
      ["verify", "index"],
    );
    assert.deepEqual(entries[0], {
      name: "verify",
      code: 'export { verify } from "explorer-verify";',
      measuredBytes: 100,
      ceilingBytes: 120,
      withoutTable: false,
    });
  });

  it("reads withoutTable, false when absent (R-RUN-3)", () => {
    const [entry0, entry1] = parseBudget({
      entries: [entry({ withoutTable: true }), entry({ name: "routing table" })],
    });
    assert.equal(entry0?.withoutTable, true);
    assert.equal(entry1?.withoutTable, false);
  });

  const bad: [string, unknown, RegExp][] = [
    ["a file that is not an object", 5, /`entries` must be a non-empty list/],
    ["a file without entries", {}, /`entries` must be a non-empty list/],
    ["an empty list", { entries: [] }, /`entries` must be a non-empty list/],
    ["an entry that is not an object", { entries: [null] }, /entries\[0\]\.name/],
    ["a blank name", { entries: [entry({ name: " " })] }, /entries\[0\]\.name/],
    ["a missing code", { entries: [entry({ code: undefined })] }, /entries\[0\]\.code/],
    ["a fractional size", { entries: [entry({ measuredBytes: 1.5 })] }, /measuredBytes/],
    ["a zero ceiling", { entries: [entry({ ceilingBytes: 0 })] }, /ceilingBytes must be/],
    ["a size given as text", { entries: [entry({ ceilingBytes: "120" })] }, /ceilingBytes/],
    [
      "a ceiling below the measured size",
      { entries: [entry({ ceilingBytes: 99 })] },
      /ceilingBytes is below measuredBytes/,
    ],
    [
      "a withoutTable that is not a boolean",
      { entries: [entry({ withoutTable: "yes" })] },
      /entries\[0\]\.withoutTable must be true or false/,
    ],
    [
      "a repeated name",
      { entries: [entry(), entry()] },
      /entries\[1\]\.name "verify" appears twice/,
    ],
  ];
  for (const [label, parsed, message] of bad) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseBudget(parsed), message);
    });
  }
});

describe("compareSizes and formatReport (R-RUN-3)", () => {
  const entries: BudgetEntry[] = [
    { name: "verify", code: "x", measuredBytes: 100, ceilingBytes: 120, withoutTable: true },
    { name: "index", code: "y", measuredBytes: 200, ceilingBytes: 240, withoutTable: false },
  ];

  it("accepts a size equal to the ceiling and reports no failure", () => {
    const lines = compareSizes(
      entries,
      new Map([
        ["verify", 120],
        ["index", 10],
      ]),
    );
    assert.deepEqual(
      lines.map(({ ok }) => ok),
      [true, true],
    );
    assert.equal(
      formatReport(lines),
      "ok   verify: 120 bytes (ceiling 120)\nok   index: 10 bytes (ceiling 240)\n",
    );
  });

  it("fails a size one byte over the ceiling and says how to fix it", () => {
    const lines = compareSizes(
      entries,
      new Map([
        ["verify", 121],
        ["index", 200],
      ]),
    );
    assert.deepEqual(
      lines.map(({ ok }) => ok),
      [false, true],
    );
    const report = formatReport(lines);
    assert.match(report, /^OVER verify: 121 bytes \(ceiling 120\)$/m);
    assert.match(report, /Over the ceiling: verify\. .*raise the ceiling in size-budget\.json/);
  });

  it("throws when an entry was not measured", () => {
    assert.throws(
      () => compareSizes(entries, new Map([["verify", 1]])),
      /no measured size for index/,
    );
  });
});

/** Runs check-size.ts on `budget`, written to a file in the test folder. */
function run(budget: unknown): { status: number | null; stdout: string; stderr: string } {
  const file = path.join(dir, "budget.json");
  writeFileSync(file, JSON.stringify(budget));
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(scripts, "check-size.ts"), file],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("check-size.ts", () => {
  // The code needs no build: it imports nothing from the package.
  const code = "export const values = [1, 2, 3].map((value) => value * 2);";

  it("exits 0 when every entry is within its ceiling", () => {
    const result = run({ entries: [entry({ name: "small", code, ceilingBytes: 10_000 })] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ok {3}small: \d+ bytes \(ceiling 10000\)$/m);
  });

  it("exits 1 when an entry is over its ceiling", () => {
    const result = run({
      entries: [entry({ name: "small", code, measuredBytes: 1, ceilingBytes: 1 })],
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^OVER small: \d+ bytes \(ceiling 1\)$/m);
  });

  it("exits non-zero with a usage line when no budget file is given", () => {
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", path.join(scripts, "check-size.ts")],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: node scripts\/check-size\.ts <budget\.json>/);
  });

  it("fails when an entry imports a Node built-in (R-RUN-1)", () => {
    const result = run({ entries: [entry({ code: 'export * from "node:fs";' })] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not resolve "node:fs"/);
  });
});
