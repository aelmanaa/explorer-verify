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

import {
  EMPTY_TABLE,
  bundleApart,
  bundleChunks,
  bundleForBrowser,
  filesSize,
  gzipSize,
} from "../bundle.ts";
import {
  compareChunks,
  compareSizes,
  formatReport,
  parseBudget,
  parseChunks,
} from "../size-budget.ts";
import type { BudgetEntry, ChunkBudget } from "../size-budget.ts";

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
      oneFile: false,
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
    {
      name: "verify",
      code: "x",
      measuredBytes: 100,
      ceilingBytes: 120,
      withoutTable: true,
      oneFile: false,
    },
    {
      name: "index",
      code: "y",
      measuredBytes: 200,
      ceilingBytes: 240,
      withoutTable: false,
      oneFile: true,
    },
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

// --- dynamic imports (decision 0031) --------------------------------------------------------------

/**
 * Writes an entry that loads two clients with a dynamic `import()`, as the flow engine does. Both
 * clients import `shared.ts`, which the entry imports too, and `common.ts`, which it does not.
 */
function withClients(): string {
  mkdirSync(path.join(dir, "clients"));
  writeFileSync(path.join(dir, "shared.ts"), 'export const SHARED = "shared-code-in-the-entry";\n');
  writeFileSync(
    path.join(dir, "clients", "common.ts"),
    'export const COMMON = "common-code-of-the-clients";\n',
  );
  for (const name of ["alpha", "beta"]) {
    writeFileSync(
      path.join(dir, "clients", `${name}.ts`),
      'import { SHARED } from "../shared.ts";\nimport { COMMON } from "./common.ts";\n' +
        `export const client = [SHARED, COMMON, "${name}-client-code"];\n`,
    );
  }
  return (
    'import { SHARED } from "./shared.ts";\n' +
    "export const loaders = {\n" +
    '  alpha: async () => (await import("./clients/alpha.ts")).client,\n' +
    '  beta: async () => (await import("./clients/beta.ts")).client,\n' +
    "};\n" +
    "export const shared = SHARED;\n"
  );
}

/** Writes `a/client.ts` and `b/client.ts` and returns an entry that loads both. */
function twoNamedClient(): string {
  mkdirSync(path.join(dir, "a"));
  mkdirSync(path.join(dir, "b"));
  writeFileSync(path.join(dir, "a", "client.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "b", "client.ts"), "export const b = 2;\n");
  return 'export const load = [() => import("./a/client.ts"), () => import("./b/client.ts")];';
}

describe("bundleForBrowser with dynamic imports", () => {
  it("inlines each dynamic import into the one file", async () => {
    const code = await bundleForBrowser({ contents: withClients(), resolveDir: dir });
    assert.match(code, /alpha-client-code/);
    assert.match(code, /beta-client-code/);
  });
});

describe("bundleChunks (decision 0031)", () => {
  it("puts each dynamically imported module in a chunk of its own", async () => {
    const bundle = await bundleChunks({ contents: withClients(), resolveDir: dir });
    assert.equal(bundle.entry, "entry.js");
    assert.ok(bundle.entryFiles.includes("entry.js"));
    assert.deepEqual([...bundle.dynamic.keys()].toSorted(), ["alpha", "beta"]);
    const entryCode = bundle.entryFiles.map((file) => bundle.files.get(file)).join("");
    assert.doesNotMatch(entryCode, /alpha-client-code|beta-client-code|common-code/);
    assert.match(entryCode, /shared-code-in-the-entry/);
    for (const name of ["alpha", "beta"]) {
      const files = bundle.dynamic.get(name) ?? [];
      const [own] = files;
      assert.match(own ?? "", new RegExp(`^${name}-\\w+\\.js$`));
      assert.match(bundle.files.get(own ?? "") ?? "", new RegExp(`${name}-client-code`));
      const added = files.map((file) => bundle.files.get(file)).join("");
      assert.match(added, /common-code-of-the-clients/);
      assert.ok(files.every((file) => !bundle.entryFiles.includes(file)));
    }
    assert.ok(filesSize(bundle, bundle.entryFiles) > 0);
  });

  it("bundles an entry file with no dynamic import into one file", async () => {
    const file = path.join(dir, "entry.ts");
    writeFileSync(file, "export const greeting = `hello`;\n");
    const bundle = await bundleChunks({ entry: file });
    assert.deepEqual(bundle.entryFiles, ["entry.js"]);
    assert.equal(bundle.dynamic.size, 0);
    assert.equal(filesSize(bundle, ["entry.js"]), gzipSize(bundle.files.get("entry.js") ?? ""));
  });

  it("refuses two dynamically imported modules with the same file name", async () => {
    await assert.rejects(
      bundleChunks({ contents: twoNamedClient(), resolveDir: dir }),
      /two dynamically imported modules are named client/,
    );
  });

  it("filesSize refuses a file the bundle does not have", async () => {
    const bundle = await bundleChunks({ contents: "export const x = 1;", resolveDir: dir });
    assert.throws(() => filesSize(bundle, ["missing.js"]), /the bundle has no file missing\.js/);
  });
});

describe("bundleApart (decision 0031)", () => {
  it("measures the entry without its dynamic imports, and each one without the entry's modules", async () => {
    const apart = await bundleApart({ contents: withClients(), resolveDir: dir });
    assert.match(apart.entry, /shared-code-in-the-entry/);
    assert.doesNotMatch(apart.entry, /alpha-client-code|beta-client-code|common-code/);
    assert.deepEqual([...apart.chunks.keys()], ["alpha", "beta"]);
    for (const [name, code] of apart.chunks) {
      assert.match(code, new RegExp(`${name}-client-code`));
      assert.match(code, /common-code-of-the-clients/);
      assert.doesNotMatch(code, /shared-code-in-the-entry/, "the entry holds it already");
    }
  });

  it("measures an entry file the same way", async () => {
    const file = path.join(dir, "entry.ts");
    writeFileSync(file, withClients());
    const apart = await bundleApart({ entry: file });
    assert.deepEqual([...apart.chunks.keys()], ["alpha", "beta"]);
  });

  it("counts no chunk for a dynamic import that tree-shaking removes", async () => {
    const contents = withClients().replace("export const loaders", "const loaders");
    const apart = await bundleApart({ contents, resolveDir: dir });
    assert.equal(apart.chunks.size, 0);
  });

  it("keeps the routing table's rows out of the chunks too", async () => {
    withTable();
    writeFileSync(
      path.join(dir, "client.ts"),
      'import { rows } from "./routing/resolve.ts";\nexport const client = rows;\n',
    );
    const contents = 'export const load = () => import("./client.ts");';
    const kept = await bundleApart({ contents, resolveDir: dir });
    assert.match(kept.chunks.get("client") ?? "", /424242/);
    const without = await bundleApart({ contents, resolveDir: dir }, { withoutTable: true });
    assert.doesNotMatch(without.chunks.get("client") ?? "", /424242/);
  });

  it("still fails on a Node built-in behind a dynamic import (R-RUN-1)", async () => {
    await assert.rejects(
      bundleApart({
        contents: 'export async function f() { try { await import("node:crypto"); } catch {} }',
        resolveDir: dir,
      }),
      /the bundle leaves imports unresolved: node:crypto/,
    );
  });

  it("refuses a dynamically loaded module that loads another one", async () => {
    writeFileSync(path.join(dir, "inner.ts"), "export const inner = 1;\n");
    writeFileSync(path.join(dir, "outer.ts"), 'export const load = () => import("./inner.ts");\n');
    await assert.rejects(
      bundleApart({ contents: 'export const load = () => import("./outer.ts");', resolveDir: dir }),
      /outer loads more modules with a dynamic import\(\), which is not measured/,
    );
  });

  it("refuses two dynamically imported modules with the same file name", async () => {
    await assert.rejects(
      bundleApart({ contents: twoNamedClient(), resolveDir: dir }),
      /two dynamically imported modules are named client/,
    );
  });
});

/** A `chunks` item of size-budget.json, with `overrides` applied. */
function chunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "sourcify", measuredBytes: 100, ceilingBytes: 120, ...overrides };
}

describe("parseChunks (decision 0031)", () => {
  it("reads every chunk in file order, and none when the file has no chunks", () => {
    assert.deepEqual(parseChunks({ chunks: [chunk(), chunk({ name: "etherscan" })] }), [
      { name: "sourcify", measuredBytes: 100, ceilingBytes: 120 },
      { name: "etherscan", measuredBytes: 100, ceilingBytes: 120 },
    ]);
    assert.deepEqual(parseChunks({ entries: [] }), []);
    assert.deepEqual(parseChunks(null), []);
  });

  const bad: [string, unknown, RegExp][] = [
    ["chunks that are not a list", { chunks: {} }, /`chunks` must be a list/],
    ["a chunk that is not an object", { chunks: [5] }, /chunks\[0\]\.name/],
    ["a zero size", { chunks: [chunk({ measuredBytes: 0 })] }, /chunks\[0\]\.measuredBytes/],
    [
      "a ceiling below the measured size",
      { chunks: [chunk({ ceilingBytes: 99 })] },
      /chunks\[0\]\.ceilingBytes is below measuredBytes/,
    ],
    [
      "a repeated name",
      { chunks: [chunk(), chunk()] },
      /chunks\[1\]\.name "sourcify" appears twice/,
    ],
  ];
  for (const [label, parsed, message] of bad) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseChunks(parsed), message);
    });
  }
});

describe("compareChunks (decision 0031)", () => {
  const chunks: ChunkBudget[] = [{ name: "sourcify", measuredBytes: 100, ceilingBytes: 120 }];

  it("counts a chunk at its largest size over the entries", () => {
    const sizes = new Map([
      [
        "sourcify",
        new Map([
          ["verify", 110],
          ["index", 121],
        ]),
      ],
    ]);
    assert.deepEqual(compareChunks(chunks, sizes), [
      { name: "chunk sourcify", bytes: 121, ceilingBytes: 120, ok: false },
    ]);
    assert.deepEqual(compareChunks(chunks, new Map([["sourcify", new Map([["verify", 120]])]])), [
      { name: "chunk sourcify", bytes: 120, ceilingBytes: 120, ok: true },
    ]);
  });

  it("fails a chunk that an entry loads and that has no ceiling", () => {
    const sizes = new Map([
      ["sourcify", new Map([["verify", 1]])],
      ["etherscan", new Map([["verify", 1]])],
    ]);
    assert.throws(
      () => compareChunks(chunks, sizes),
      /entries load etherscan with a dynamic import\(\), and size-budget\.json sets no ceiling/,
    );
  });

  it("fails a ceiling for a chunk that no entry loads", () => {
    assert.throws(() => compareChunks(chunks, new Map()), /no entry loads the chunk sourcify/);
    assert.throws(
      () => compareChunks(chunks, new Map([["sourcify", new Map()]])),
      /no entry loads the chunk sourcify: remove it/,
    );
  });
});

/**
 * The code of a size entry that re-exports {@link withClients}'s entry by its path: check-size.ts
 * resolves the code from the package folder.
 */
function clientsEntry(): string {
  const file = path.join(dir, "entry.ts");
  writeFileSync(file, withClients());
  return `export * from ${JSON.stringify(file)};`;
}

describe("check-size.ts with chunks (decision 0031)", () => {
  it("reports the entry without its clients, then each client chunk", () => {
    const result = run({
      entries: [entry({ name: "with clients", code: clientsEntry(), ceilingBytes: 10_000 })],
      chunks: [
        { name: "alpha", measuredBytes: 1, ceilingBytes: 10_000 },
        { name: "beta", measuredBytes: 1, ceilingBytes: 10_000 },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ok {3}with clients: \d+ bytes \(ceiling 10000\)$/m);
    assert.match(result.stdout, /^ok {3}chunk alpha: \d+ bytes \(ceiling 10000\)$/m);
    assert.match(result.stdout, /^ok {3}chunk beta: \d+ bytes \(ceiling 10000\)$/m);
  });

  it("fails when a client chunk has no ceiling", () => {
    const result = run({
      entries: [entry({ name: "with clients", code: clientsEntry(), ceilingBytes: 10_000 })],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /entries load alpha, beta with a dynamic import\(\)/);
  });
});

describe("the one-file entry and static client imports (decision 0031)", () => {
  it("parseBudget reads oneFile, false when absent, and refuses a value that is not a boolean", () => {
    const [one, split] = parseBudget({
      entries: [entry({ oneFile: true }), entry({ name: "split" })],
    });
    assert.equal(one?.oneFile, true);
    assert.equal(split?.oneFile, false);
    assert.throws(
      () => parseBudget({ entries: [entry({ oneFile: "yes" })] }),
      /entries\[0\]\.oneFile must be true or false/,
    );
  });

  it("check-size.ts measures a oneFile entry with its clients inlined and reports no chunk", () => {
    const result = run({
      entries: [
        entry({ name: "one file", code: clientsEntry(), ceilingBytes: 10_000, oneFile: true }),
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ok {3}one file: \d+ bytes \(ceiling 10000\)$/m);
    assert.doesNotMatch(result.stdout, /chunk/);
  });

  it("bundleApart refuses an entry that also imports a client statically", async () => {
    const contents = `${withClients()}export { client } from "./clients/alpha.ts";\n`;
    await assert.rejects(
      bundleApart({ contents, resolveDir: dir }),
      /the entry imports alpha\.ts statically as well as with import\(\), so no chunk is split off/,
    );
  });
});
