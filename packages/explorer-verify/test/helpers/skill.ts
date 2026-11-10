/**
 * Reads the packaged skill (`skills/explorer-verify/SKILL.md`, which the build copies from the
 * repository root) and runs its examples against the built package (R-AX-4). The user-docs test
 * runs the examples of `docs/user/` with the same helpers (R-AX-2, `user-docs.ts`). The examples
 * run in a temporary project whose `node_modules/explorer-verify` links to this package, so
 * `import ... from "explorer-verify"` resolves through the package's `exports` to `dist/`, as it
 * does for a user.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*([^\s`]*)([^`]*)$/;
/** A title in brackets at the end of an info string, after the language and any flags. */
const FENCE_TITLE = /^(.*?)\s*\[([^\]]+)\]\s*$/;
const API_SPAN = /^([A-Za-z_$][\w$]*)(\(.*\)|\[[^\]]*\])?$/;
const MEMBER_PATH = /^(result|error)(\.[A-Za-z_$][\w$]*)+$/;
const EVENT_NAME = /^verify\.[a-z-]+$/;

/** One fenced code block. */
export interface CodeBlock {
  /** The info string's first word, such as `ts`. Empty when there is none. */
  readonly lang: string;
  /** The other words of the info string, such as `no-run` in `ts no-run`. */
  readonly flags: readonly string[];
  /** The title in brackets at the end of the info string, such as `verify.ts` in `ts [verify.ts]`. */
  readonly title: string | undefined;
  /** The block's lines, joined with `\n`, with a final newline. */
  readonly code: string;
  /** The 1-based line of the opening fence. */
  readonly line: number;
}

/** A `ts` block of the skill and the `text` block that follows it, which holds its output. */
export interface Example {
  readonly line: number;
  /** The words after `ts` in the info string, without the title. */
  readonly flags: readonly string[];
  /** The title in brackets, such as `verify.ts` in `ts [verify.ts]`, or `undefined`. */
  readonly title: string | undefined;
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
  let open:
    | {
        fence: string;
        lang: string;
        flags: string[];
        title: string | undefined;
        line: number;
        lines: string[];
      }
    | undefined;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (open === undefined) {
      const match = FENCE_OPEN.exec(line);
      if (match !== null) {
        const titled = FENCE_TITLE.exec(String(match[3]));
        const flags = (titled === null ? String(match[3]) : String(titled[1]))
          .split(/\s+/)
          .filter((word) => word !== "");
        open = {
          fence: String(match[1]),
          lang: String(match[2]),
          flags,
          title: titled === null ? undefined : String(titled[2]),
          line: index + 1,
          lines: [],
        };
      }
    } else if (line.trimEnd() === open.fence) {
      blocks.push({
        lang: open.lang,
        flags: open.flags,
        title: open.title,
        code: `${open.lines.join("\n")}\n`,
        line: open.line,
      });
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
      {
        line: block.line,
        flags: block.flags,
        title: block.title,
        code: block.code,
        output: next?.lang === "text" ? next.code : undefined,
      },
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
 * The entries whose names the skill may use: the main entry, and `explorer-verify/envelope`, where
 * `toEnvelope()`, `exitCodeOf()` and their types live (decision 0055).
 */
export const SKILL_ENTRIES: readonly string[] = ["explorer-verify", "explorer-verify/envelope"];

/**
 * The module that {@link typeNamesModule} reads the types from: every type of
 * {@link SKILL_ENTRIES}. Write it into the project next to that module.
 */
export const API_SURFACE: Readonly<Record<string, string>> = {
  "api-surface.ts": SKILL_ENTRIES.map((entry) => `export type * from "${entry}";\n`).join(""),
};

/**
 * A module that compiles only when each name is a type the package exports from one of
 * {@link SKILL_ENTRIES}, and each member path names a field of `VerifyResult` (for `result.`) or
 * `ExplorerVerifyError` (for `error.`). A path on a union is valid when some member of the union
 * has the field. Write {@link API_SURFACE} into the same project.
 */
export function typeNamesModule(
  typeNames: readonly string[],
  paths: readonly string[] = [],
): string {
  const lines = [
    `import type * as api from "./api-surface.js";`,
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

/** What {@link createProject} changes in the default project. */
export interface ProjectOptions {
  /**
   * Other workspace packages to link into `node_modules`, by package name, each to its folder
   * under `packages/`, such as `{ "@explorer-verify/foundry": "foundry" }`. Each must be built.
   */
  readonly workspacePackages?: Readonly<Record<string, string>>;
  /** Type-check with the DOM library too, for examples that use browser globals. */
  readonly dom?: boolean;
  /** Leave out the Foundry artifact and its sources, for a project that brings its own files. */
  readonly bare?: boolean;
}

/**
 * A new temporary project with the package linked as `node_modules/explorer-verify`, a
 * `tsconfig.json` for Node, and the files the examples read: a Foundry artifact at
 * `out/Greeter.sol/Greeter.json` and its sources under `src/`.
 */
export function createProject(options: ProjectOptions = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "explorer-verify-skill-"));
  mkdirSync(path.join(dir, "node_modules/@explorer-verify"), { recursive: true });
  symlinkSync(PACKAGE_DIR, path.join(dir, "node_modules/explorer-verify"), "dir");
  for (const [name, folder] of Object.entries(options.workspacePackages ?? {})) {
    symlinkSync(path.join(PACKAGE_DIR, "..", folder), path.join(dir, "node_modules", name), "dir");
  }
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  writeTsconfig(dir, options.dom === true);
  if (options.bare === true) {
    return dir;
  }
  mkdirSync(path.join(dir, "out/Greeter.sol"), { recursive: true });
  copyFileSync(
    path.join(BUILD_FORMATS, "foundry-1.8.1/Greeter.json"),
    path.join(dir, "out/Greeter.sol/Greeter.json"),
  );
  mkdirSync(path.join(dir, "src"));
  for (const file of ["Base.sol", "Greeter.sol"]) {
    copyFileSync(path.join(BUILD_FORMATS, "sources", file), path.join(dir, "src", file));
  }
  return dir;
}

/** Writes the project's `tsconfig.json`: strict, for Node, each `.ts` file a module. */
function writeTsconfig(dir: string, dom: boolean): void {
  const typeRoots = path.join(path.dirname(require.resolve("@types/node/package.json")), "..");
  const tsconfig = {
    compilerOptions: {
      target: "ES2023",
      lib: dom ? ["ES2023", "DOM"] : ["ES2023"],
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
      resolveJsonModule: true,
      moduleDetection: "force",
      noEmit: true,
    },
    include: ["*.ts"],
  };
  writeFileSync(path.join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
}

/** Removes a project made by {@link createProject}. */
export function removeProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes each file of `files`, by name, into the project folder, with its parent folders. Each
 * file is written next to its place under a temporary name, then renamed into place, so a process
 * that reads it at the same time sees the old text or the new text, never an empty or partial
 * file.
 */
export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, file);
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

/**
 * The file URL that `import "explorer-verify"`, or another of its entries, resolves to from the
 * project, as Node sees it.
 */
export function resolveInProject(dir: string, specifier = "explorer-verify"): string {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
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
 * `*` answers every request that matches its recording, until one does not. Each module URL in
 * `preloads` loads after the fake, with `--import`.
 */
export function runExample(
  dir: string,
  file: string,
  fixtures: readonly string[],
  preloads: readonly string[] = [],
): Run {
  const run = spawnSync(process.execPath, exampleArgs(file, preloads), {
    cwd: dir,
    encoding: "utf8",
    env: exampleEnv(fixtures),
  });
  return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}

/**
 * {@link runExample} without blocking, so runs in separate processes can overlap. `env` adds
 * variables for the run, such as one a preload reads.
 */
export async function startExample(
  dir: string,
  file: string,
  fixtures: readonly string[],
  preloads: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): Promise<Run> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, exampleArgs(file, preloads), {
      cwd: dir,
      env: exampleEnv(fixtures, env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ stdout, stderr, status });
    });
  });
}

function exampleArgs(file: string, preloads: readonly string[]): string[] {
  return [...[FETCH_PRELOAD, ...preloads].flatMap((url) => ["--import", url]), file];
}

function exampleEnv(
  fixtures: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  // Examples promise plain output. A terminal or package manager may force inspect colors even
  // through a pipe; remove that override rather than stripping output and hiding regressions.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    SKILL_FIXTURES: JSON.stringify(fixtures),
    NO_COLOR: "1",
  };
  delete env["FORCE_COLOR"];
  return env;
}
