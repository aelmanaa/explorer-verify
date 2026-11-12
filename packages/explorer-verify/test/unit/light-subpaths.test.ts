// The subpaths `explorer-verify/handle`, `explorer-verify/errors`, `explorer-verify/backends` and
// `explorer-verify/envelope` (decision 0055, R-RUN-1, R-RUN-2, R-AX-5, R-AX-7): what each exports,
// that none reaches the verification flow or a dynamic `import()`, and that the envelope left the
// main entry. scripts/check-names.ts measures the bundles (R-RUN-3).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as backends from "../../src/entries/backends.ts";
import * as envelope from "../../src/entries/envelope.ts";
import * as errors from "../../src/entries/errors.ts";
import * as handle from "../../src/entries/handle.ts";
import * as main from "../../src/index.ts";
import { createProject, removeProject, typeCheck } from "../helpers/skill.ts";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(PACKAGE, "src");

/** Each subpath, its source file, and the runtime names it exports. */
const SUBPATHS = [
  {
    subpath: "./handle",
    source: "entries/handle.ts",
    module: handle,
    names: ["formatHandle", "isHandleString", "parseHandle", "tryParseHandle"],
  },
  {
    subpath: "./errors",
    source: "entries/errors.ts",
    module: errors,
    names: ["ERROR_CODES", "ERROR_HINTS", "ExplorerVerifyError", "hintFor"],
  },
  {
    subpath: "./backends",
    source: "entries/backends.ts",
    module: backends,
    names: ["BACKEND_LABELS", "BACKEND_NAMES", "toBackendName"],
  },
  {
    subpath: "./envelope",
    source: "entries/envelope.ts",
    module: envelope,
    names: ["ERROR_EXIT_CODES", "exitCodeOf", "toEnvelope"],
  },
] as const;

/** A module's code without its comments, so a doc comment that names `import()` is not code. */
function codeOf(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

/** The relative specifiers a module imports or re-exports, side-effect imports included. */
function specifiersOf(text: string): string[] {
  return [
    ...codeOf(text).matchAll(/^(?:import|export)\s(?:[^;]*?from\s+)?"(\.{1,2}\/[^"]+)";/gms),
  ].map((match) => String(match[1]));
}

/** Whether a module's code calls a dynamic `import()`, with any spacing. */
function hasDynamicImport(text: string): boolean {
  return /\bimport\s*\(/.test(codeOf(text));
}

/** The relative imports of a module, resolved to files under src. */
function importsOf(file: string): string[] {
  return specifiersOf(readFileSync(file, "utf8")).map((specifier) =>
    path.resolve(path.dirname(file), specifier),
  );
}

/** Every source file a module reaches through its static imports, itself included. */
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file) || !file.endsWith(".ts")) {
      continue;
    }
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return seen;
}

describe("the light subpaths and the envelope subpath (decision 0055)", () => {
  for (const { subpath, source, module, names } of SUBPATHS) {
    it(`explorer-verify/${subpath.slice(2)} exports exactly ${names.join(", ")}`, () => {
      assert.deepEqual(Object.keys(module).toSorted(), [...names]);
    });

    it(`explorer-verify/${subpath.slice(2)} reaches no flow, client, routing or import() (R-RUN-2)`, () => {
      const files = [...reached(path.join(SRC, source))].map((file) =>
        path.relative(SRC, file).split(path.sep).join("/"),
      );
      const heavy = files.filter(
        (file) =>
          /^(?:core|clients|backends|routing|http|input|server)\//.test(file) ||
          (file.startsWith("flow/") &&
            !["flow/handle.ts", "flow/check-handle.ts", "flow/format-handle.ts"].includes(file)),
      );
      assert.deepEqual(heavy, []);
      const lazy = files.filter((file) =>
        hasDynamicImport(readFileSync(path.join(SRC, file), "utf8")),
      );
      assert.deepEqual(lazy, []);
    });
  }

  it("the walk follows side-effect imports and re-exports, and finds import() with any spacing", () => {
    const text = [
      "/** A dynamic `import()` named in a comment is not code. */",
      'import "./side-effect.ts";',
      'import { a } from "./a.ts";',
      'export type { B } from "../b.ts";',
      "export {",
      "  c,",
      '} from "./c.ts";',
      'import x from "explorer-verify";',
      "",
    ].join("\n");
    assert.deepEqual(specifiersOf(text), ["./side-effect.ts", "./a.ts", "../b.ts", "./c.ts"]);
    assert.equal(hasDynamicImport(text), false);
    assert.equal(hasDynamicImport('const m = await import ("./x.ts");'), true);
    assert.equal(hasDynamicImport("const m = await import(\n  name\n);"), true);
    assert.equal(hasDynamicImport("// import(x)\nconst y = 1;"), false);
  });

  it("package.json maps each subpath to its built entry, types first (R-RUN-1)", () => {
    const pkg: unknown = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    const exports: unknown = Reflect.get(Object(pkg), "exports");
    for (const { subpath, source } of SUBPATHS) {
      const built = `./dist/src/${source.replace(/\.ts$/, "")}`;
      assert.deepEqual(Reflect.get(Object(exports), subpath), {
        types: `${built}.d.ts`,
        default: `${built}.js`,
      });
    }
  });

  it("the handle, error and backend names are the main entry's own values, so instanceof holds", () => {
    for (const { module, subpath } of SUBPATHS.filter((one) => one.subpath !== "./envelope")) {
      for (const [name, value] of Object.entries(module)) {
        assert.equal(Reflect.get(main, name), value, `${subpath} ${name}`);
      }
    }
    const thrown: unknown = (() => {
      try {
        return handle.parseHandle("ev1:nowhere");
      } catch (error) {
        return error;
      }
    })();
    assert.ok(thrown instanceof errors.ExplorerVerifyError);
    assert.equal(thrown.code, "invalid-input");
  });

  it("the main entry no longer exports the envelope, its exit codes or exitCodeOf (R-AX-7)", () => {
    for (const name of SUBPATHS[3].names) {
      assert.equal(Object.hasOwn(main, name), false, name);
    }
  });

  it("the envelope subpath gives the CLI's exit code and envelope for an outcome (R-AX-5, R-AX-7)", () => {
    const failed = new errors.ExplorerVerifyError(
      { code: "missing-api-key", backend: "sourcify" },
      "No key.",
      {
        secrets: [],
      },
    );
    assert.equal(envelope.exitCodeOf(failed), 3);
    assert.equal(envelope.ERROR_EXIT_CODES["missing-api-key"], 3);
    assert.deepEqual(envelope.toEnvelope(failed), {
      schemaVersion: 1,
      ok: false,
      error: failed.toJSON(),
    });
  });
});

/** A consumer of the built package that imports every name from its subpath. It must compile. */
const CONSUMER = `
import { BACKEND_NAMES, toBackendName } from "explorer-verify/backends";
import type { BackendName, KeyedBackendName } from "explorer-verify/backends";
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "explorer-verify/envelope";
import { ERROR_CODES, ERROR_HINTS, ExplorerVerifyError } from "explorer-verify/errors";
import type {
  AnyExplorerVerifyError,
  DetailsByCode,
  DetailsJsonOf,
  DetailsOf,
  ErrorCode,
  ErrorDetails,
  ErrorDetailsJson,
  ErrorJson,
  ErrorJsonFields,
  ExplorerVerifyErrorOptions,
  InputIssue,
  MetadataAttempt,
} from "explorer-verify/errors";
import { formatHandle, isHandleString, parseHandle, tryParseHandle } from "explorer-verify/handle";
import type { Handle, HandleString } from "explorer-verify/handle";

declare const outcome: VerifyOutcome;
declare const value: unknown;
export const code: ExitCode = exitCodeOf(outcome);
export const document: Envelope = toEnvelope(outcome, {} satisfies EnvelopeOptions);
export const exits: Readonly<Record<ErrorCode, ExitCode>> = ERROR_EXIT_CODES;
export const backend: BackendName | undefined = toBackendName(BACKEND_NAMES[0]);
export const keyed: KeyedBackendName = "etherscan-v2";
export const hint: string = ERROR_HINTS[ERROR_CODES[0]];
export const read: Handle | undefined = tryParseHandle(value);
export const line: HandleString | undefined = isHandleString(value) ? value : undefined;
export const again: HandleString = formatHandle(parseHandle(value));
export function narrow(error: unknown): string | undefined {
  if (error instanceof ExplorerVerifyError && error.code === "invalid-input") {
    const issues: readonly InputIssue[] = error.details.issues;
    return issues[0]?.field;
  }
  return undefined;
}
export type Shapes = [
  AnyExplorerVerifyError,
  DetailsByCode,
  DetailsOf<"network">,
  DetailsJsonOf<"network">,
  ErrorDetails,
  ErrorDetailsJson,
  ErrorJson,
  ErrorJsonFields,
  ExplorerVerifyErrorOptions,
  MetadataAttempt,
];
`;

/** Names that left the main entry. Each import must fail to compile. */
const MOVED = `
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify";
import type { Envelope, EnvelopeOptions, ExitCode, VerifyOutcome } from "explorer-verify";
export type Moved = [Envelope, EnvelopeOptions, ExitCode, VerifyOutcome];
export const moved = [ERROR_EXIT_CODES, exitCodeOf, toEnvelope];
`;

describe("the subpaths as a consumer sees them in the built package (decision 0055, R-DX-4)", () => {
  let dir = "";
  before(() => {
    dir = createProject({ bare: true });
  });
  after(() => {
    removeProject(dir);
  });

  it("compiles imports from each subpath, and refuses the moved names from the main entry", () => {
    const diagnostics = typeCheck(dir, { "consumer.ts": CONSUMER, "moved.ts": MOVED });
    const found = diagnostics.flatMap((text) => {
      const match = /(\w+)\.ts\((\d+),\d+\): error (TS\d+)/.exec(text);
      return match === null ? [] : [`${String(match[1])}:${String(match[2])}`];
    });
    assert.deepEqual([...new Set(found)], ["moved:2", "moved:3"], diagnostics.join("\n"));
  });

  it("gives the same values from a subpath and the main entry, so instanceof holds across them", () => {
    const script = [
      'const main = await import("explorer-verify");',
      'const errors = await import("explorer-verify/errors");',
      'const handle = await import("explorer-verify/handle");',
      'const backends = await import("explorer-verify/backends");',
      "console.log(JSON.stringify([",
      "  errors.ExplorerVerifyError === main.ExplorerVerifyError,",
      "  handle.parseHandle === main.parseHandle,",
      "  backends.BACKEND_NAMES === main.BACKEND_NAMES,",
      "]));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [true, true, true]);
  });
});
