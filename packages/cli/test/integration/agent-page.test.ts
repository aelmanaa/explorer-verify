// The agent page, docs/user/guides/using-from-an-agent.md, against the packages and the built bin
// (R-AX-3): its two lists, outward and safe, name every function the packages export and every
// command the CLI lists, and its command-line examples print what the page shows. The stderr line
// it quotes is tested in-process, in test/unit/agent-page.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { COMMANDS } from "../../src/commands.ts";
import { shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const PAGE_NAME = "using-from-an-agent.md";
const PAGE = readFileSync(
  new URL(`../../../../docs/user/guides/${PAGE_NAME}`, import.meta.url),
  "utf8",
);

/** The packages whose public functions the page must classify. */
const PACKAGES: readonly string[] = ["explorer-verify", "foundry", "hardhat", "cli"];

/** The fields of a JSON object; empty for any other value. */
function fields(value: unknown): Map<string, unknown> {
  return new Map(typeof value === "object" && value !== null ? Object.entries(value) : []);
}

/**
 * The file URL of each JavaScript entry point in a package's `exports` map: every subpath but the
 * JSON ones, at its `default` target. A new subpath joins the list without a change here.
 */
function entryPoints(dir: string): string[] {
  const base = new URL(`../../../${dir}/`, import.meta.url);
  const manifest: unknown = JSON.parse(readFileSync(new URL("package.json", base), "utf8"));
  return [...fields(fields(manifest).get("exports"))].flatMap(([subpath, target]) => {
    if (subpath.endsWith(".json")) {
      return [];
    }
    const file = typeof target === "string" ? target : fields(target).get("default");
    assert.equal(typeof file, "string", `${dir} exports ${subpath} with a default target`);
    return [new URL(String(file), base).href];
  });
}

/** The public entry points, from each package's `exports` map. */
const ENTRY_POINTS: readonly string[] = PACKAGES.flatMap((dir) => entryPoints(dir));

/** Whether `value` is a function that is not a class, such as `ExplorerVerifyError`. */
function isPlainFunction(value: unknown): boolean {
  return (
    typeof value === "function" && !/^class[\s{]/.test(Function.prototype.toString.call(value))
  );
}

/** Every function the entry points export, by name, sorted. */
async function exportedFunctions(): Promise<string[]> {
  const names = new Set<string>();
  for (const entry of ENTRY_POINTS) {
    const exports: Record<string, unknown> = { ...(await import(entry)) };
    for (const [name, value] of Object.entries(exports)) {
      if (isPlainFunction(value)) {
        names.add(name);
      }
    }
  }
  return [...names].toSorted();
}

/** The text of the H2 section `heading`, up to the next H2. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `${PAGE_NAME} has no "## ${heading}"`);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

/** Column `column` of each body row of the first table in `text`. */
function tableColumn(text: string, column: number): string[] {
  const rows = text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2);
  assert.ok(rows.length > 0, "a table");
  return rows.map((row) => String(row.split("|")[column + 1]).trim());
}

/** What a list of table cells names: functions as `name()`, and command lines. */
function named(cells: readonly string[]): { functions: string[]; commands: string[] } {
  const spans = cells.flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => String(m[1])));
  return {
    functions: spans.flatMap((span) => {
      const match = /^(\w+)\(\)$/.exec(span);
      return match ? [String(match[1])] : [];
    }),
    commands: spans.filter((span) => span.startsWith("explorer-verify ")),
  };
}

/** The command word of a command line, or `undefined` for `explorer-verify --version` and such. */
function commandWord(line: string): string | undefined {
  const word = line.split(" ")[1];
  return word === undefined || word.startsWith("-") ? undefined : word;
}

const outward = named(tableColumn(section(PAGE, "Submit is permanent"), 0));
const safe = named(tableColumn(section(PAGE, "Safe steps"), 1));

describe("the agent page's lists (R-AX-3)", () => {
  it("reads the entry points from the exports maps: the core's three and one per helper", () => {
    assert.equal(ENTRY_POINTS.length, 5);
    assert.ok(
      ENTRY_POINTS.some((url) => url.endsWith("/explorer-verify/dist/src/server/handler.js")),
    );
  });

  it("classifies every exported function once, as safe or outward", async () => {
    const listed = [...outward.functions, ...safe.functions];
    assert.deepEqual(
      outward.functions.filter((name) => safe.functions.includes(name)),
      [],
      "a function is either safe or outward",
    );
    assert.equal(new Set(listed).size, listed.length, "each function is listed once");
    assert.deepEqual(listed.toSorted(), await exportedFunctions());
  });

  it("lists the calls that submit as outward, and the read-only ones as safe", () => {
    assert.deepEqual(outward.functions.toSorted(), [
      "createVerifyHandler",
      "linkProxy",
      "verify",
      "verifyEach",
    ]);
    for (const name of ["dryRun", "checkStatus", "resolveInputFromBytecode"]) {
      assert.ok(safe.functions.includes(name), `${name}() is safe`);
    }
  });

  it("lists every command the CLI shows, verify as outward and only verify --dry-run as safe", () => {
    const visible = COMMANDS.filter((command) => command.hidden !== true).map(({ name }) => name);
    const words = [...outward.commands, ...safe.commands].map(commandWord);
    for (const name of visible) {
      assert.ok(words.includes(name), `the page lists explorer-verify ${name}`);
    }
    for (const word of words) {
      assert.ok(
        word === undefined || word === "help" || visible.includes(word),
        `explorer-verify ${String(word)} is a command the CLI shows`,
      );
    }
    assert.deepEqual(outward.commands, ["explorer-verify verify"]);
    const safeVerify = safe.commands.filter((line) => commandWord(line) === "verify");
    assert.ok(safeVerify.length > 0);
    assert.ok(safeVerify.every((line) => line.includes("--dry-run")));
  });
});

describe("the agent page's command-line examples (R-AX-3)", () => {
  const examples = shellExamples(PAGE, PAGE_NAME);

  it("has a dry run, a refused key flag and a status", () => {
    const lines = examples.map(({ args }) => args.join(" "));
    assert.ok(lines.some((line) => line.includes("--dry-run")));
    assert.ok(lines.some((line) => line.includes("--api-key ")));
    assert.ok(lines.some((line) => line.startsWith("status ")));
  });

  for (const example of examples) {
    it(`${PAGE_NAME} line ${String(example.line)}: explorer-verify ${example.args.join(" ")}`, async () => {
      // In a Foundry project, against the fake explorer: nothing reaches the network.
      const result = await runBin(example.args, { cwd: PROJECT, fake: {} });
      assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout, example.stdout);
    });
  }
});
