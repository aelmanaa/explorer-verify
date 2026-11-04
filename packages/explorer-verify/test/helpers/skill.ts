/**
 * Reads the packaged skill (`skills/explorer-verify/SKILL.md`, which the build copies from the
 * repository root) and runs its examples against the built package (R-AX-4). The examples run in
 * a temporary project whose `node_modules/explorer-verify` links to this package, so
 * `import ... from "explorer-verify"` resolves through the package's `exports` to `dist/`, as it
 * does for a user.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The core package folder. */
const PACKAGE_DIR: string = fileURLToPath(new URL("../../", import.meta.url));
/** The packaged skill: build output, copied from `skills/` at the repository root. */
export const SKILL_FILE: string = path.join(PACKAGE_DIR, "skills/explorer-verify/SKILL.md");
/** The preload that replaces `fetch` and speeds up long waits in an example run. */
const FETCH_PRELOAD = new URL("skill-fetch.ts", import.meta.url).href;
const require = createRequire(import.meta.url);
const BUILD_FORMATS = path.join(PACKAGE_DIR, "test/fixtures/build-formats");
/**
 * The fence languages a skill example may use: code that runs, and the output it prints. The CLI
 * package runs the `sh` blocks against its built bin.
 */
export const EXAMPLE_LANGUAGES: readonly string[] = ["ts", "text", "sh"];

const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const API_SPAN = /^([A-Za-z_$][\w$]*)(\(.*\)|\[[^\]]*\])?$/;
const MEMBER_PATH = /^(result|error)(\.[A-Za-z_$][\w$]*)+$/;
const EVENT_NAME = /^verify\.[a-z-]+$/;

/** One fenced code block. */
export interface CodeBlock {
  /** The info string's first word, such as `ts`. Empty when there is none. */
  readonly lang: string;
  /** The block's lines, joined with `\n`, with a final newline. */
  readonly code: string;
  /** The 1-based line of the opening fence. */
  readonly line: number;
}

/** A `ts` block of the skill and the `text` block that follows it, which holds its output. */
export interface Example {
  readonly line: number;
  readonly code: string;
  /** The documented stdout, or `undefined` when no `text` block follows. */
  readonly output: string | undefined;
}

/** An inline code span outside code blocks, with its 1-based line. */
export interface Span {
  readonly text: string;
  readonly line: number;
}

/** An API name in an inline code span, such as `verify()` or `VerifyResult`. */
export interface ApiName {
  readonly name: string;
  /** Whether the span calls it, as in `verify()` or `checkStatus(handle)`. */
  readonly call: boolean;
  readonly line: number;
}

/** The fenced code blocks of a Markdown text. Throws on a fence that is never closed. */
export function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open: { fence: string; lang: string; line: number; lines: string[] } | undefined;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (open === undefined) {
      const match = FENCE_OPEN.exec(line);
      if (match !== null) {
        open = { fence: String(match[1]), lang: String(match[2]), line: index + 1, lines: [] };
      }
    } else if (line.trimEnd() === open.fence) {
      blocks.push({ lang: open.lang, code: `${open.lines.join("\n")}\n`, line: open.line });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  if (open !== undefined) {
    throw new Error(`the code block at line ${String(open.line)} is never closed`);
  }
  return blocks;
}

/** The `ts` blocks of a Markdown text, each with the output block that follows it. */
export function examples(markdown: string): Example[] {
  const blocks = codeBlocks(markdown);
  return blocks.flatMap((block, index) => {
    if (block.lang !== "ts") {
      return [];
    }
    const next = blocks[index + 1];
    return [
      { line: block.line, code: block.code, output: next?.lang === "text" ? next.code : undefined },
    ];
  });
}

/** The inline code spans of a Markdown text, outside code blocks. */
export function inlineSpans(markdown: string): Span[] {
  const spans: Span[] = [];
  let fence: string | undefined;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (fence !== undefined) {
      if (line.trimEnd() === fence) {
        fence = undefined;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = String(open[1]);
      continue;
    }
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      spans.push({ text: String(span[1]), line: index + 1 });
    }
  }
  return spans;
}

/**
 * The API names in the inline code spans: a span that is one identifier followed by a call or an
 * index, such as `verify()`, `checkStatus(handle)` or `ERROR_EXIT_CODES[code]`, or one identifier
 * that starts with a capital letter, such as `VerifyResult`. Lower-case words without a call, such
 * as option and field names, are not API names.
 */
export function apiNames(markdown: string): ApiName[] {
  return inlineSpans(markdown).flatMap(({ text, line }) => {
    const match = API_SPAN.exec(text);
    if (match === null) {
      return [];
    }
    const name = String(match[1]);
    const call = match[2]?.startsWith("(") ?? false;
    return call || /^[A-Z]/.test(name) ? [{ name, call, line }] : [];
  });
}

/** The member paths on a result or an error in the inline code spans, such as `error.hint`. */
export function memberPaths(markdown: string): string[] {
  return [
    ...new Set(inlineSpans(markdown).flatMap(({ text }) => (MEMBER_PATH.test(text) ? [text] : []))),
  ];
}

/** The event names in the inline code spans, such as `verify.submitted`. */
export function eventNames(markdown: string): string[] {
  return [
    ...new Set(inlineSpans(markdown).flatMap(({ text }) => (EVENT_NAME.test(text) ? [text] : []))),
  ];
}

/**
 * Checks API names against the runtime exports of the package. Returns the problems found and the
 * names left to check as type exports. A name that `globalThis` holds, such as `Request`, is a
 * platform name and passes.
 */
export function checkApiNames(
  names: readonly ApiName[],
  runtime: Readonly<Record<string, unknown>>,
): { problems: string[]; typeNames: string[] } {
  const problems: string[] = [];
  const typeNames = new Set<string>();
  for (const { name, call, line } of names) {
    const exported = Object.hasOwn(runtime, name);
    const value = exported ? runtime[name] : Reflect.get(globalThis, name);
    if (call) {
      if (typeof value !== "function") {
        problems.push(`line ${String(line)}: ${name}() is not a function the package exports`);
      }
    } else if (!exported && value === undefined) {
      typeNames.add(name);
    }
  }
  return { problems, typeNames: [...typeNames] };
}

/**
 * A module that compiles only when each name is a type the package exports, and each member path
 * names a field of `VerifyResult` (for `result.`) or `ExplorerVerifyError` (for `error.`). A path
 * on a union is valid when some member of the union has the field.
 */
export function typeNamesModule(
  typeNames: readonly string[],
  paths: readonly string[] = [],
): string {
  const lines = [
    `import type * as api from "explorer-verify";`,
    // Every key of every member of a union, and the type of a key on the members that have it.
    "type Keys<T> = T extends unknown ? keyof T : never;",
    "type At<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;",
    ...typeNames.map((name) => `export type Check${name} = api.${name};`),
  ];
  paths.forEach((member, index) => {
    const [root, ...keys] = member.split(".");
    let type = root === "result" ? "api.VerifyResult" : "api.ExplorerVerifyError";
    keys.forEach((key, depth) => {
      lines.push(`export const path${String(index)}_${String(depth)}: Keys<${type}> = "${key}";`);
      type = `At<${type}, "${key}">`;
    });
  });
  return `${lines.join("\n")}\n`;
}

/**
 * A new temporary project with the package linked as `node_modules/explorer-verify`, a
 * `tsconfig.json` for Node, and the files the examples read: a Foundry artifact at
 * `out/Greeter.sol/Greeter.json` and its sources under `src/`.
 */
export function createProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "explorer-verify-skill-"));
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(PACKAGE_DIR, path.join(dir, "node_modules/explorer-verify"), "dir");
  mkdirSync(path.join(dir, "out/Greeter.sol"), { recursive: true });
  copyFileSync(
    path.join(BUILD_FORMATS, "foundry-1.8.1/Greeter.json"),
    path.join(dir, "out/Greeter.sol/Greeter.json"),
  );
  mkdirSync(path.join(dir, "src"));
  for (const file of ["Base.sol", "Greeter.sol"]) {
    copyFileSync(path.join(BUILD_FORMATS, "sources", file), path.join(dir, "src", file));
  }
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  const typeRoots = path.join(path.dirname(require.resolve("@types/node/package.json")), "..");
  const tsconfig = {
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      typeRoots: [typeRoots],
      types: ["node"],
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["*.ts"],
  };
  writeFileSync(path.join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  return dir;
}

/** Removes a project made by {@link createProject}. */
export function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Writes each file of `files`, by name, into the project folder. */
export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
  }
}

/** Runs the repository's TypeScript on the project with extra arguments; returns its output. */
export function tsc(dir: string, ...args: string[]): string {
  const bin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc");
  const run = spawnSync(process.execPath, [bin, "-p", dir, "--pretty", "false", ...args], {
    encoding: "utf8",
  });
  return `${run.stdout}${run.stderr}`;
}

/**
 * Writes `files` into the project and type-checks every `.ts` file in it. Returns the compiler's
 * diagnostics; empty when the files compile.
 */
export function typeCheck(dir: string, files: Readonly<Record<string, string>>): string[] {
  writeFiles(dir, files);
  return tsc(dir)
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** The file URL that `import "explorer-verify"` resolves to from the project, as Node sees it. */
export function resolveInProject(dir: string): string {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'console.log(import.meta.resolve("explorer-verify"))'],
    { cwd: dir, encoding: "utf8" },
  );
  return run.stdout.trim();
}

/** What one example run printed and its exit code. */
export interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/**
 * Runs `file` of the project with Node, from the project folder, with `fetch` replaced by a fake
 * that answers from the named Sourcify fixtures in order (see `skill-fetch.ts`). A name ending in
 * `*` answers every request that matches its recording, until one does not.
 */
export function runExample(dir: string, file: string, fixtures: readonly string[]): Run {
  const run = spawnSync(process.execPath, ["--import", FETCH_PRELOAD, file], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SKILL_FIXTURES: JSON.stringify(fixtures) },
  });
  return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}
