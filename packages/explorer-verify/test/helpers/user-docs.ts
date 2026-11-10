/**
 * Reads the `ts` examples of the user docs (`docs/user/`) and prepares the projects they run in
 * (R-AX-2). It reuses the skill helpers (`skill.ts`): the same code-block reader, temporary
 * project, type-check and run with recorded Sourcify answers.
 *
 * Two info-string flags change what the test does with a block:
 *
 * - `ts no-run`: the block is type-checked but not run;
 * - `ts fragment`: the block is neither type-checked nor run, such as a function signature.
 *
 * A flagged block needs its reason in an HTML comment on the nearest non-blank line before it:
 * `<!-- no-run: the reason -->` or `<!-- fragment: the reason -->`. A title in brackets may follow
 * the language and the flag, as in `ts [verify.ts]` or `ts no-run [verify.ts]`.
 *
 * A page with the line `<!-- docs-style: legacy -->` has not been rewritten to the style guide
 * (`docs/contributor/docs-style.md`) yet. Its examples may use `input` and `built` without
 * defining them. On every other page an example defines all it uses but the keys, the deployer
 * address and the request.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildVerifyInput } from "explorer-verify";

import { createProject, examples, writeFiles } from "./skill.ts";

/** The user docs folder of the repository. */
export const USER_DOCS_DIR: string = fileURLToPath(
  new URL("../../../../docs/user/", import.meta.url),
);
/** The preload that defines the names in {@link DOC_GLOBALS} for a run. */
export const DOCS_PRELOAD: string = new URL("docs-globals.ts", import.meta.url).href;
/** The flags an info string may carry after `ts`, with what each one does. */
export const DOC_FLAGS: Readonly<Record<string, string>> = {
  "no-run": "type-checked, not run",
  fragment: "neither type-checked nor run",
};
/**
 * The names an example may use without defining them, with their types. The test declares them
 * for the type-check, and `docs-globals.ts` defines them for a run.
 */
export const DOC_GLOBALS: Readonly<Record<string, string>> = {
  input: "api.VerifyInput",
  apiKey: "string",
  etherscanKey: "string",
  explorerKey: "string",
  blockscoutKey: "string",
  deployerAddress: "string",
  built: "api.BuiltVerifyInput",
  request: "Request",
};
/** The names of {@link DOC_GLOBALS} that only an example on a legacy page may use. */
export const LEGACY_GLOBALS: readonly string[] = ["input", "built"];
/** The line that marks a page not yet rewritten to the style guide. */
export const LEGACY_MARKER = "<!-- docs-style: legacy -->";

const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const BUILD_FORMATS = path.join(PACKAGES_DIR, "explorer-verify/test/fixtures/build-formats");
const WORKSPACE_PACKAGES = {
  "@explorer-verify/foundry": "foundry",
  "@explorer-verify/hardhat": "hardhat",
};

/** One `ts` block of a user page. */
export interface DocExample {
  /** The page, relative to `docs/user/`, with `/` separators. */
  readonly page: string;
  /** The index of the block among the page's `ts` blocks, from 0. */
  readonly index: number;
  /** The 1-based line of the opening fence. */
  readonly line: number;
  readonly flags: readonly string[];
  /** The title in brackets after the language and the flag, or `undefined`. */
  readonly title: string | undefined;
  /** Whether the page holds the legacy marker, so the block may use {@link LEGACY_GLOBALS}. */
  readonly legacy: boolean;
  readonly code: string;
  /** The `text` block after it, which holds its output, or `undefined`. */
  readonly output: string | undefined;
}

/** The Markdown pages under `docs/user/`, relative to it, sorted, with `/` separators. */
export function userDocPages(dir: string = USER_DOCS_DIR): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.split(path.sep).join("/"))
    .toSorted();
}

/**
 * The `ts` blocks of one page, and the problems with them: an unknown flag, more than one flag, a
 * flag without its reason comment, an output block after a block that does not run, and code the
 * test would skip because its fence is indented or names another language.
 */
export function docExamples(
  page: string,
  markdown: string,
): { examples: DocExample[]; problems: string[] } {
  const lines = markdown.split("\n");
  const legacy = lines.some((line) => line.trim() === LEGACY_MARKER);
  const problems: string[] = [];
  const found = examples(markdown).map((example, index) => {
    const where = `${page}:${String(example.line)}`;
    const unknown = example.flags.filter((flag) => !Object.hasOwn(DOC_FLAGS, flag));
    if (unknown.length > 0) {
      problems.push(
        `${where}: unknown flag ${unknown.join(", ")}; use ${Object.keys(DOC_FLAGS).join(" or ")}`,
      );
    } else if (example.flags.length > 1) {
      problems.push(`${where}: use one flag, not ${example.flags.join(" and ")}`);
    }
    const [flag] = example.flags;
    if (flag !== undefined && Object.hasOwn(DOC_FLAGS, flag)) {
      const before = lines
        .slice(0, example.line - 1)
        .findLast((line) => line.trim() !== "")
        ?.trim();
      const reason = new RegExp(`^<!-- ${flag}: \\S.* -->$`);
      if (before === undefined || !reason.test(before)) {
        problems.push(
          `${where}: a ${flag} block needs its reason on the line before it: <!-- ${flag}: why -->`,
        );
      }
      if (example.output !== undefined) {
        problems.push(`${where}: a ${flag} block has an output block that no run checks`);
      }
    }
    return { page, index, legacy, ...example };
  });
  return { examples: found, problems: [...untestedFences(page, lines), ...problems] };
}

/** Languages the test would skip if a fence named them instead of `ts`, in lower case. */
const CODE_LANGUAGES: ReadonlySet<string> = new Set([
  "ts",
  "typescript",
  "tsx",
  "mts",
  "cts",
  "js",
  "javascript",
  "jsx",
  "mjs",
  "cjs",
]);
const ANY_FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/**
 * Problems with fences the test would skip without a word: TypeScript or JavaScript code that is
 * indented, as in a list item, or whose language is not exactly `ts`. Only an unindented `ts`
 * fence is tested.
 */
function untestedFences(page: string, lines: readonly string[]): string[] {
  const problems: string[] = [];
  let open: string | undefined;
  for (const [index, line] of lines.entries()) {
    const match = ANY_FENCE.exec(line);
    if (match === null) {
      continue;
    }
    const fence = String(match[2]);
    if (open !== undefined) {
      if (line.trim() === open) {
        open = undefined;
      }
      continue;
    }
    open = fence;
    const indent = String(match[1]);
    const lang = String(match[3]);
    if (!CODE_LANGUAGES.has(lang.toLowerCase()) || (indent === "" && lang === "ts")) {
      continue;
    }
    const where = `${page}:${String(index + 1)}`;
    problems.push(
      indent === ""
        ? `${where}: a ${lang} block is not tested; use ts`
        : `${where}: an indented ${lang} block is not tested; move it out of the list, unindented, as ts`,
    );
  }
  return problems;
}

/** Whether the test type-checks a block. */
export const typeChecked = (example: DocExample): boolean => !example.flags.includes("fragment");

/** Whether the test runs a block. */
export const runs = (example: DocExample): boolean => example.flags.length === 0;

/** The file a block is written to in the project: its page and line, such as `guides__x--l12.ts`. */
export function exampleFile(example: DocExample): string {
  return `${example.page.replace(/\.md$/, "").replaceAll("/", "__")}--l${String(example.line)}.ts`;
}

/**
 * A module that declares {@link DOC_GLOBALS} for the type-check. With `legacy` false, it leaves
 * out {@link LEGACY_GLOBALS}, so an example that uses `input` without defining it fails.
 */
export function globalsModule(legacy = true): string {
  const declarations = Object.entries(DOC_GLOBALS)
    .filter(([name]) => legacy || !LEGACY_GLOBALS.includes(name))
    .map(([name, type]) => `  const ${name}: ${type};`);
  return [
    'import type * as api from "explorer-verify";',
    "declare global {",
    ...declarations,
    "}",
    "",
  ].join("\n");
}

/**
 * The files a run starts from: `core` has none, the others hold the build output a guide reads,
 * from the fixtures of the core, the Foundry helper and the Hardhat helper.
 * `without-explorer-verify` is `core` with no `explorer-verify` in `node_modules`.
 */
export type DocSetup =
  | "core"
  | "npm-package"
  | "foundry"
  | "foundry-multi"
  | "hardhat-3"
  | "hardhat-2"
  | "shipped-contracts"
  | "without-explorer-verify";

/**
 * The files a package ships to verify its Greeter, written as the guide "Verify contracts your
 * package ships" writes them: `compiler.input` and a manifest of `contractName` and
 * `compiler.version`, from the built `buildVerifyInput` (the package name resolves to `dist/`) on
 * the core's Foundry build fixture. That build holds `Greeter` and `Base` only, and is the build of
 * the Greeter deployed on Sepolia that the Sourcify fixtures recorded.
 * The type-check project holds them too, because the guide's example imports them.
 */
export function shippedContractFiles(): Record<string, string> {
  const built = buildVerifyInput([
    readFoundryFixture("build-info.json"),
    readFoundryFixture("Greeter.json"),
  ]);
  const manifest = { contract: built.contractName, compilerVersion: built.compiler.version };
  return {
    "verification/Greeter.input.json": JSON.stringify(built.compiler.input),
    "verification/Greeter.manifest.json": JSON.stringify(manifest),
  };
}

/** A parsed file of the core's Foundry build fixture. */
function readFoundryFixture(file: string): unknown {
  return JSON.parse(readFileSync(path.join(BUILD_FORMATS, "foundry-1.8.1", file), "utf8"));
}

/** Copies a fixture file or folder into the project. */
function copy(dir: string, from: string, to: string): void {
  mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
  cpSync(from, path.join(dir, to), { recursive: true });
}

/**
 * Writes `node_modules/pino`: a stub with pino's object-first log methods, so the logging page's
 * pino example compiles and runs without the package. It prints nothing.
 */
function writePinoStub(dir: string): void {
  const pino = path.join(dir, "node_modules/pino");
  mkdirSync(pino);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "pino", type: "module", main: "index.js", types: "index.d.ts" })}\n`,
    "index.d.ts": [
      "type LogFn = (fields: object, message?: string) => void;",
      "export interface Logger { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn }",
      "export default function pino(): Logger;",
      "",
    ].join("\n"),
    "index.js": [
      "const ignore = () => {};",
      "export default function pino() {",
      "  return { debug: ignore, info: ignore, warn: ignore, error: ignore };",
      "}",
      "",
    ].join("\n"),
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(pino, name), text);
  }
}

/**
 * A new temporary project for user-docs examples: the core, the Foundry and Hardhat helpers and a
 * pino stub in `node_modules`, the DOM library for browser examples, the globals module, the
 * docs' sample request `greeter-sepolia.json` at the root, as a reader saves it next to the
 * example, and the files of `setup`. With `legacy` false, the globals module leaves out
 * {@link LEGACY_GLOBALS}.
 */
export function createDocsProject(setup: DocSetup, legacy = true): string {
  const dir = createProject({ bare: true, dom: true, workspacePackages: WORKSPACE_PACKAGES });
  writePinoStub(dir);
  writeFileSync(path.join(dir, "doc-globals.d.ts"), globalsModule(legacy));
  copy(dir, path.join(USER_DOCS_DIR, "start/greeter-sepolia.json"), "greeter-sepolia.json");
  const foundry = path.join(PACKAGES_DIR, "foundry/test/fixtures");
  const hardhat = path.join(PACKAGES_DIR, "hardhat/test/fixtures");
  switch (setup) {
    case "core":
      break;
    case "npm-package": {
      // A package that ships its build files: Hardhat 3 artifacts, and a Foundry artifact with
      // its sources.
      const sdk = "node_modules/some-sdk";
      mkdirSync(path.join(dir, sdk));
      writeFileSync(path.join(dir, sdk, "package.json"), '{ "name": "some-sdk" }\n');
      const hh3 = path.join(BUILD_FORMATS, "hardhat-3.21.2");
      copy(
        dir,
        path.join(hh3, "build-info.json"),
        `${sdk}/artifacts/build-info/solc-0_8_24-e2aa41ca9499e8400cb1090c69ef55b1cafafa86.json`,
      );
      copy(
        dir,
        path.join(hh3, "Greeter.json"),
        `${sdk}/artifacts/contracts/Greeter.sol/Greeter.json`,
      );
      copy(
        dir,
        path.join(BUILD_FORMATS, "foundry-1.8.1/Greeter.json"),
        `${sdk}/out/Greeter.sol/Greeter.json`,
      );
      copy(dir, path.join(BUILD_FORMATS, "sources"), `${sdk}/src`);
      break;
    }
    case "foundry":
      // A project built with `forge build --build-info`.
      copy(dir, path.join(foundry, "project/foundry.toml"), "foundry.toml");
      copy(dir, path.join(foundry, "project/src"), "src");
      copy(dir, path.join(foundry, "project/out-build-info"), "out");
      break;
    case "foundry-multi":
      copy(dir, path.join(foundry, "multi"), ".");
      break;
    case "hardhat-3":
      copy(dir, path.join(hardhat, "hardhat-3.21.2/artifacts"), "artifacts");
      break;
    case "hardhat-2":
      copy(dir, path.join(hardhat, "hardhat-2.29.1/artifacts"), "artifacts");
      break;
    case "shipped-contracts":
      // The verification files next to the package's own module, which imports them.
      writeFiles(dir, shippedContractFiles());
      break;
    case "without-explorer-verify":
      // A user of a wrapper that declares explorer-verify an optional peer and did not install it.
      // A symlink on most Node versions, a copied directory on others: remove either.
      rmSync(path.join(dir, "node_modules/explorer-verify"), { recursive: true, force: true });
      break;
  }
  return dir;
}
