// Tests the per-name size check (R-RUN-3): the budget rules (scripts/name-size.ts), the three
// builds (scripts/name-bundle.ts) on fixture packages, and scripts/check-names.ts as `pnpm run
// size` runs it. Everything is offline: the fixtures are small packages in a temporary folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  entryCode,
  measureEsbuild,
  measureFiles,
  measureRollup,
  staticClosure,
} from "../name-bundle.ts";
import type { NameTarget } from "../name-bundle.ts";
import {
  MODES,
  ceilingOf,
  checkLight,
  codeEntries,
  compareNames,
  exportTarget,
  formatModel,
  formatNameReport,
  parseNameBudget,
  rowFor,
  specifierOf,
} from "../name-size.ts";
import type { LightRule, Measure, MeasuredName, NameRow } from "../name-size.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(scripts, "..");

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "name-size-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function measure(gzipBytes: number, files = 1, minBytes = gzipBytes * 2): Measure {
  return { minBytes, gzipBytes, files };
}

function measuredName(entry: string, name: string, split: Measure = measure(100)): MeasuredName {
  return {
    entry,
    name,
    modes: { esbuildSplit: split, esbuildOneFile: measure(100), rollup: measure(100) },
  };
}

function budgetRow(entry: string, name: string, ceilingBytes = 120): Record<string, unknown> {
  const mode = { minBytes: 200, gzipBytes: 100, files: 1, ceilingBytes };
  return { entry, name, esbuildSplit: mode, esbuildOneFile: mode, rollup: mode };
}

function budget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packages: { "fixture-lib": "browser", "fixture-helper": "node" },
    light: {
      issue: "#1",
      subpaths: ["fixture-lib/light", "fixture-lib/handle"],
      maxFiles: 1,
      smallNames: ["light"],
      maxMinBytes: 1024,
    },
    model: [{ entry: "fixture-lib", name: "heavy" }],
    names: [],
    ...overrides,
  };
}

const LIGHT: LightRule = {
  issue: "#219",
  subpaths: ["pkg/handle"],
  maxFiles: 1,
  smallNames: ["formatHandle"],
  maxMinBytes: 1024,
};

describe("exportTarget", () => {
  it("follows a string, the import condition, then default, into nested conditions", () => {
    assert.equal(exportTarget("./a.js"), "./a.js");
    assert.equal(
      exportTarget({ types: "./a.d.ts", import: "./a.mjs", default: "./a.js" }),
      "./a.mjs",
    );
    assert.equal(exportTarget({ types: "./a.d.ts", default: "./a.js" }), "./a.js");
    assert.equal(exportTarget({ import: { types: "./a.d.ts", default: "./b.js" } }), "./b.js");
  });

  it("gives undefined when no condition applies", () => {
    assert.equal(exportTarget({ types: "./a.d.ts" }), undefined);
    assert.equal(exportTarget(["./a.js"]), undefined);
    assert.equal(exportTarget(null), undefined);
    assert.equal(exportTarget(3), undefined);
  });
});

describe("codeEntries", () => {
  it("keeps the entries that point at JavaScript and leaves out JSON and patterns", () => {
    assert.deepEqual(
      codeEntries({
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./server": "./dist/server.mjs",
          "./schema.json": "./schema/schema.json",
          "./features/*": "./dist/features/*.js",
          "./package.json": "./package.json",
        },
      }),
      [
        { subpath: ".", target: "./dist/index.js" },
        { subpath: "./server", target: "./dist/server.mjs" },
      ],
    );
  });

  it("reads a string or a condition object as the . entry", () => {
    assert.deepEqual(codeEntries({ exports: "./index.js" }), [
      { subpath: ".", target: "./index.js" },
    ]);
    assert.deepEqual(codeEntries({ exports: { default: "./index.cjs" } }), [
      { subpath: ".", target: "./index.cjs" },
    ]);
  });

  it("gives no entries without exports", () => {
    assert.deepEqual(codeEntries({ name: "a" }), []);
    assert.deepEqual(codeEntries(null), []);
    assert.deepEqual(codeEntries({ exports: 4 }), []);
  });
});

describe("specifierOf and ceilingOf", () => {
  it("writes the specifier a user imports", () => {
    assert.equal(specifierOf("explorer-verify", "."), "explorer-verify");
    assert.equal(specifierOf("explorer-verify", "./server"), "explorer-verify/server");
  });

  it("sets the ceiling at the measured size plus 20%, rounded up (decision 0014)", () => {
    assert.equal(ceilingOf(100), 120);
    assert.equal(ceilingOf(101), 122);
  });
});

describe("parseNameBudget", () => {
  it("reads packages, the light rule, the model names and the rows", () => {
    const parsed = parseNameBudget(budget({ names: [budgetRow("fixture-lib", "light")] }));
    assert.deepEqual(
      [...parsed.packages],
      [
        ["fixture-lib", "browser"],
        ["fixture-helper", "node"],
      ],
    );
    assert.equal(parsed.light.maxFiles, 1);
    assert.deepEqual(parsed.light.subpaths, ["fixture-lib/light", "fixture-lib/handle"]);
    assert.deepEqual(parsed.model, [{ entry: "fixture-lib", name: "heavy" }]);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]?.modes.rollup.ceilingBytes, 120);
  });

  it("takes no model names when `model` is absent", () => {
    assert.deepEqual(parseNameBudget(budget({ model: undefined })).model, []);
  });

  const broken: readonly [string, Record<string, unknown>, RegExp][] = [
    ["packages missing", { packages: undefined }, /`packages` must map/],
    ["packages a list", { packages: [] }, /`packages` must map/],
    ["an unknown platform", { packages: { a: "deno" } }, /packages\.a must be browser or node/],
    ["no light rule", { light: undefined }, /light\.issue must be a non-empty string/],
    [
      "subpaths not a list",
      { light: { issue: "#1", subpaths: "a", maxFiles: 1, smallNames: [], maxMinBytes: 1 } },
      /light\.subpaths must be a list of strings/,
    ],
    [
      "an empty subpath",
      { light: { issue: "#1", subpaths: [""], maxFiles: 1, smallNames: [], maxMinBytes: 1 } },
      /light\.subpaths\[0\] must be a non-empty string/,
    ],
    [
      "a fractional file count",
      { light: { issue: "#1", subpaths: [], maxFiles: 1.5, smallNames: [], maxMinBytes: 1 } },
      /light\.maxFiles must be a non-negative integer/,
    ],
    ["model not a list", { model: {} }, /`model` must be a list/],
    ["a model item without a name", { model: [{ entry: "a" }] }, /model\[0\]\.name/],
    ["names missing", { names: undefined }, /`names` must be a list/],
    [
      "a repeated row",
      { names: [budgetRow("a", "b"), budgetRow("a", "b")] },
      /names\[1\] repeats b from a/,
    ],
    [
      "a negative size",
      {
        names: [
          {
            ...budgetRow("a", "b"),
            rollup: { minBytes: -1, gzipBytes: 1, files: 1, ceilingBytes: 1 },
          },
        ],
      },
      /names\[0\]\.rollup\.minBytes must be a non-negative integer/,
    ],
    [
      "a ceiling below the measured size",
      { names: [budgetRow("a", "b", 99)] },
      /names\[0\]\.esbuildSplit\.ceilingBytes is below gzipBytes/,
    ],
    [
      "a row without an entry",
      { names: [{ name: "b" }] },
      /names\[0\]\.entry must be a non-empty string/,
    ],
  ];
  for (const [what, overrides, message] of broken) {
    it(`rejects ${what}`, () => {
      assert.throws(() => parseNameBudget(budget(overrides)), message);
    });
  }
});

describe("rowFor", () => {
  it("writes each mode with its ceiling at plus 20%", () => {
    const row = rowFor(measuredName("pkg", "verify", measure(1000, 20, 3000)));
    assert.deepEqual(row.esbuildSplit, {
      minBytes: 3000,
      gzipBytes: 1000,
      files: 20,
      ceilingBytes: 1200,
    });
    assert.equal(row.entry, "pkg");
    assert.equal(row.name, "verify");
    assert.deepEqual(Object.keys(row), ["entry", "name", ...MODES]);
  });
});

describe("compareNames (R-RUN-3)", () => {
  const rows: readonly NameRow[] = parseNameBudget(
    budget({ names: [budgetRow("pkg", "small"), budgetRow("pkg", "gone")] }),
  ).rows;

  it("passes a name within every ceiling and fails one over a ceiling", () => {
    const lines = compareNames(rows.slice(0, 1), [measuredName("pkg", "small", measure(121, 3))]);
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map(({ ok }) => ok),
      [false, true, true],
    );
    assert.equal(
      lines[0]?.text,
      "OVER small from pkg, esbuild split: 242 min / 121 gzip, 3 files (ceiling 120 gzip)",
    );
    assert.match(
      lines[2]?.text ?? "",
      /^ok {3}small from pkg, Rollup: 200 min \/ 100 gzip, 1 file \(/,
    );
  });

  it("fails a new export with no row", () => {
    const lines = compareNames(rows.slice(0, 1), [
      measuredName("pkg", "small"),
      measuredName("pkg", "added"),
    ]);
    const added = lines.find(({ text }) => text.startsWith("NONE"));
    assert.equal(added?.ok, false);
    assert.match(added?.text ?? "", /added from pkg: no row in name-budget\.json/);
    assert.match(added?.text ?? "", /--add-missing/);
  });

  it("fails a row whose name is no longer exported", () => {
    const lines = compareNames(rows, [measuredName("pkg", "small")]);
    const gone = lines.find(({ text }) => text.startsWith("GONE"));
    assert.equal(gone?.ok, false);
    assert.match(gone?.text ?? "", /gone from pkg: not exported any more/);
  });
});

describe("checkLight", () => {
  it("is pending, and never fails, while a light subpath is not exported", () => {
    const lines = checkLight(
      LIGHT,
      ["pkg"],
      [
        measuredName("pkg", "formatHandle", measure(4778, 20, 12705)),
        measuredName("pkg", "verify"),
      ],
    );
    assert.ok(lines.every(({ ok }) => ok));
    assert.deepEqual(
      lines.map(({ text }) => text),
      [
        "PEND light rule for pkg/handle: not in exports yet (#219); it applies once the subpath exists",
        "PEND formatHandle from pkg today, esbuild split: 12705 min / 4778 gzip, 20 files",
      ],
    );
  });

  it("passes a light name in one file and under the byte limit", () => {
    const lines = checkLight(
      LIGHT,
      ["pkg", "pkg/handle"],
      [
        measuredName("pkg/handle", "formatHandle", measure(120, 1, 130)),
        measuredName("pkg/handle", "parseHandle", measure(5000, 1, 14000)),
      ],
    );
    assert.ok(
      lines.every(({ ok }) => ok),
      lines.map(({ text }) => text).join("\n"),
    );
    assert.equal(lines.length, 3, "a size limit only for the small names");
    assert.equal(
      lines[0]?.text,
      "ok   light formatHandle from pkg/handle: 1 file under esbuild split (at most 1)",
    );
  });

  it("fails a light name that emits more files or crosses the byte limit", () => {
    const split = measure(4778, 20, 12705);
    const lines = checkLight(
      LIGHT,
      ["pkg/handle"],
      [measuredName("pkg/handle", "formatHandle", split)],
    );
    assert.deepEqual(
      lines.map(({ ok, text }) => [ok, text]),
      [
        [
          false,
          "OVER light formatHandle from pkg/handle: 20 files under esbuild split (at most 1)",
        ],
        [false, "OVER light formatHandle from pkg/handle: 12705 bytes min at most (under 1024)"],
      ],
    );
  });
});

describe("formatModel and formatNameReport", () => {
  it("shows the model beside each build without failing", () => {
    const [line] = formatModel([{ modelBytes: 90, measured: measuredName("pkg", "verify") }]);
    assert.deepEqual(line, {
      text: "info verify from pkg, gzip: size-budget.json model 90; esbuild split 100, esbuild one file 100, Rollup 100",
      ok: true,
    });
  });

  it("ends with what to do only when a line fails", () => {
    assert.equal(formatNameReport([{ text: "ok   a", ok: true }]), "ok   a\n");
    assert.match(
      formatNameReport([{ text: "OVER a", ok: false }]),
      /^OVER a\nThe per-name check failed\. .*decisions 0008 and 0014\)\.\n$/,
    );
  });
});

describe("name-bundle helpers", () => {
  it("re-exports the one name", () => {
    assert.equal(entryCode({ specifier: "pkg/sub", name: "x" }), 'export { x } from "pkg/sub";\n');
  });

  it("walks static imports once, entries first, through cycles", () => {
    const imports = new Map([
      ["a.js", ["c.js"]],
      ["b.js", ["c.js"]],
      ["c.js", ["a.js"]],
    ]);
    assert.deepEqual(staticClosure(["a.js", "b.js"], imports), ["a.js", "c.js", "b.js"]);
  });

  it("sums the initial files and counts every file", () => {
    const files = new Map([
      ["entry.js", "export const a = 1;"],
      ["lazy.js", "export const b = 2;"],
    ]);
    const result = measureFiles(files, ["entry.js"]);
    assert.equal(result.minBytes, 19);
    assert.equal(result.files, 2);
    assert.ok(result.gzipBytes > 0);
    assert.throws(() => measureFiles(files, ["missing.js"]), /the build has no file missing\.js/);
  });
});

/** Writes `files` below the temporary folder. */
function write(files: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
}

/**
 * Writes the fixture repository: `fixture-lib`, whose barrel holds a light name beside a function
 * that loads a client with a dynamic `import()`, as explorer-verify's main entry does; a Node helper
 * that keeps fixture-lib external; a package with only a JSON export; and a folder with no
 * package.json.
 */
function writeFixture(): void {
  const lib = "packages/lib";
  write({
    [`${lib}/package.json`]: JSON.stringify({
      name: "fixture-lib",
      type: "module",
      sideEffects: false,
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./light": "./light.js",
        "./data.json": "./data.json",
        "./package.json": "./package.json",
      },
    }),
    [`${lib}/index.js`]:
      'export { light } from "./light.js";\nexport { heavy } from "./heavy.js";\nexport { table } from "./table.js";\n',
    [`${lib}/light.js`]:
      'import { tag } from "./shared.js";\nexport const light = (value) => tag(value);\n',
    [`${lib}/shared.js`]:
      "export const tag = (value) => `<${String(value)} with a shared helper long enough to measure>`;\n",
    [`${lib}/heavy.js`]:
      'export const heavy = async (value) => (await import("./client.js")).run(value);\n',
    [`${lib}/client.js`]:
      'import { tag } from "./shared.js";\nexport const run = (value) => `${tag(value)} from the client`;\n',
    [`${lib}/table.js`]:
      'import data from "./data.json" with { type: "json" };\nexport const table = () => data.rows.length;\n',
    [`${lib}/data.json`]: '{ "rows": [1, 2, 3] }\n',
    "packages/helper/package.json": JSON.stringify({
      name: "fixture-helper",
      type: "module",
      exports: { ".": "./index.js" },
      dependencies: { "fixture-dep": "1.0.0" },
      peerDependencies: { "fixture-lib": "*" },
    }),
    "packages/helper/index.js":
      'import path from "node:path";\nimport { light } from "fixture-lib";\nexport const helper = (file) => light(path.basename(file));\n',
    "packages/schemas/package.json": JSON.stringify({
      name: "fixture-schemas",
      exports: { "./x.schema.json": "./x.json" },
    }),
    "packages/empty/README.md": "No package here.\n",
  });
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(path.join(root, lib), path.join(root, "node_modules/fixture-lib"), "dir");
}

function target(overrides: Partial<NameTarget> = {}): NameTarget {
  const packageDir = path.join(root, "packages/lib");
  const manifest: unknown = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  return {
    packageDir,
    packageName: "fixture-lib",
    exports: Reflect.get(Object(manifest), "exports"),
    sideEffectFree: true,
    specifier: "fixture-lib",
    name: "light",
    platform: "browser",
    external: [],
    ...overrides,
  };
}

describe("measureEsbuild and measureRollup", () => {
  beforeEach(writeFixture);

  it("reproduces the esbuild split floor: a light name from a barrel with import() loads a shared chunk", async () => {
    const split = await measureEsbuild(target(), true);
    const oneFile = await measureEsbuild(target(), false);
    const rollup = await measureRollup(target());
    assert.ok(split.files > 1, `esbuild split emits ${String(split.files)} files`);
    assert.equal(oneFile.files, 1);
    assert.equal(rollup.files, 1, "Rollup drops the unused import()");
  });

  it("keeps a light name in one file when it comes from its own subpath", async () => {
    const split = await measureEsbuild(target({ specifier: "fixture-lib/light" }), true);
    assert.equal(split.files, 1);
  });

  it("counts the chunk a dynamic import() loads as a file, not as initial load", async () => {
    const state = {};
    const rollup = await measureRollup(target({ name: "heavy" }), state);
    assert.equal(rollup.files, 2);
    const again = await measureRollup(target({ name: "heavy" }), state);
    assert.deepEqual(again, rollup, "a cached build measures the same");
  });

  it("loads JSON in the Rollup build", async () => {
    const rollup = await measureRollup(target({ name: "table" }));
    assert.equal(rollup.files, 1);
    assert.ok(rollup.minBytes > 0);
  });

  it("leaves externals and Node built-ins out of a Node build", async () => {
    const helper = target({
      packageDir: path.join(root, "packages/helper"),
      packageName: "fixture-helper",
      exports: { ".": "./index.js" },
      sideEffectFree: false,
      name: "helper",
      specifier: "fixture-helper",
      platform: "node",
      external: ["fixture-lib"],
    });
    const rollup = await measureRollup(helper);
    const split = await measureEsbuild(helper, true);
    assert.equal(rollup.files, 1);
    assert.equal(split.files, 1);
    assert.ok(split.minBytes < 200, `only the helper's own code: ${String(split.minBytes)} bytes`);
  });

  it("rejects a subpath the package does not export and a package it cannot resolve", async () => {
    await assert.rejects(
      measureRollup(target({ specifier: "fixture-lib/missing" })),
      /fixture-lib does not export \.\/missing/,
    );
    await assert.rejects(
      measureRollup(target({ specifier: "other-package" })),
      /cannot resolve other-package in the Rollup build of light/,
    );
  });
});

/** Runs check-names.ts against the fixture repository with `contents` as the budget. */
function run(
  contents: unknown,
  ...extra: string[]
): { status: number | null; stdout: string; stderr: string; file: string } {
  const file = path.join(root, "name-budget.json");
  writeFileSync(file, JSON.stringify(contents));
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(scripts, "check-names.ts"),
      file,
      "--root",
      root,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, file };
}

describe("check-names.ts (R-RUN-3)", () => {
  beforeEach(writeFixture);

  it("fails every exported name that has no row", () => {
    const result = run(budget());
    assert.equal(result.status, 1, result.stderr);
    for (const name of [
      "light from fixture-lib",
      "heavy from fixture-lib",
      "table from fixture-lib",
      "light from fixture-lib/light",
      "helper from fixture-helper",
    ]) {
      assert.match(result.stdout, new RegExp(`^NONE ${name}: no row`, "m"));
    }
    assert.doesNotMatch(result.stdout, /fixture-schemas/);
    assert.match(result.stdout, /The per-name check failed/);
  });

  it("adds the missing rows, then passes with the light rule and the model report", () => {
    const added = run(budget(), "--add-missing");
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /^Added 5 rows to name-budget\.json\.$/m);
    const written: unknown = JSON.parse(readFileSync(added.file, "utf8"));
    const rows = parseNameBudget(written).rows;
    assert.deepEqual(
      rows.map(({ entry, name }) => `${entry} ${name}`),
      [
        "fixture-helper helper",
        "fixture-lib heavy",
        "fixture-lib light",
        "fixture-lib table",
        "fixture-lib/light light",
      ],
    );
    const result = run(written);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^ok {3}light from fixture-lib\/light, esbuild split: /m);
    assert.match(
      result.stdout,
      /^ok {3}light light from fixture-lib\/light: 1 file under esbuild split/m,
    );
    assert.match(
      result.stdout,
      /^PEND light rule for fixture-lib\/handle: not in exports yet \(#1\)/m,
    );
    assert.match(
      result.stdout,
      /^info heavy from fixture-lib, gzip: size-budget\.json model \d+; esbuild split \d+/m,
    );
  });

  it("keeps existing rows when it adds missing ones", () => {
    const row = budgetRow("fixture-lib", "light", 9999);
    const added = run(budget({ names: [row] }), "--add-missing");
    assert.match(added.stdout, /^Added 4 rows/m);
    const written: unknown = JSON.parse(readFileSync(added.file, "utf8"));
    const rows: unknown = Reflect.get(Object(written), "names");
    assert.deepEqual(Array.isArray(rows) ? rows.at(0) : undefined, row);
  });

  it("fails a light name that a barrel with import() splits, as formatHandle was on 68867bc", () => {
    const written = run(budget(), "--add-missing");
    const parsed: unknown = JSON.parse(readFileSync(written.file, "utf8"));
    const result = run({
      ...Object(parsed),
      light: {
        issue: "#1",
        subpaths: ["fixture-lib"],
        maxFiles: 1,
        smallNames: [],
        maxMinBytes: 1024,
      },
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /^OVER light light from fixture-lib: [2-9] files under esbuild split \(at most 1\)$/m,
    );
  });

  it("fails a name over its ceiling and a row whose name is gone", () => {
    const tight = { minBytes: 1, gzipBytes: 1, files: 1, ceilingBytes: 1 };
    const result = run(
      budget({
        model: [],
        names: [
          {
            entry: "fixture-helper",
            name: "helper",
            esbuildSplit: tight,
            esbuildOneFile: tight,
            rollup: tight,
          },
          budgetRow("fixture-lib", "removed"),
        ],
      }),
      "--add-missing",
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^OVER helper from fixture-helper, esbuild split: /m);
    assert.match(result.stdout, /^GONE removed from fixture-lib: not exported any more/m);
  });

  it("fails a package with code entries and no platform", () => {
    const result = run(budget({ packages: { "fixture-lib": "browser" } }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /`packages` has no platform for fixture-helper/);
  });

  it("fails a model name that is not exported", () => {
    const result = run(budget({ model: [{ entry: "fixture-lib", name: "verify" }] }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /model names verify from fixture-lib, which is not exported/);
  });

  it("exits non-zero with a usage line without a budget file", () => {
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", path.join(scripts, "check-names.ts")],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: node scripts\/check-names\.ts <name-budget\.json>/);
  });
});

const coreDir = path.join(repository, "packages/explorer-verify");
const built = existsSync(path.join(coreDir, "dist/src/index.js"));

describe("the built package", () => {
  it(
    "fails the light rule for formatHandle from the main entry under esbuild split (#222)",
    { skip: built ? false : "needs `pnpm run build`" },
    async () => {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(coreDir, "package.json"), "utf8"),
      );
      const formatHandle: NameTarget = {
        packageDir: coreDir,
        packageName: "explorer-verify",
        exports: Reflect.get(Object(manifest), "exports"),
        sideEffectFree: true,
        specifier: "explorer-verify",
        name: "formatHandle",
        platform: "browser",
        external: [],
      };
      const [esbuildSplit, esbuildOneFile, rollup] = await Promise.all([
        measureEsbuild(formatHandle, true),
        measureEsbuild(formatHandle, false),
        measureRollup(formatHandle),
      ]);
      const lines = checkLight(
        { ...LIGHT, subpaths: ["explorer-verify"] },
        ["explorer-verify"],
        [
          {
            entry: "explorer-verify",
            name: "formatHandle",
            modes: { esbuildSplit, esbuildOneFile, rollup },
          },
        ],
      );
      assert.ok(lines.length > 0);
      assert.ok(
        lines.some(({ ok }) => !ok),
        lines.map(({ text }) => text).join("\n"),
      );
      assert.ok(rollup.minBytes < 1024, "Rollup tree-shakes it to a few hundred bytes");
    },
  );
});
