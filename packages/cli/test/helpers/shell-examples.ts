// The command-line examples of a Markdown page, for the tests that run them against the built bin
// (R-AX-3, R-AX-4): each `sh` block holds one `explorer-verify` or `npx @explorer-verify/cli`
// command and nothing else, so a reader copies only the command. The line "It exits N and
// prints:" follows the block, then a `text` block holds what the command prints on stdout
// (issue #379). A command may continue over several lines, each but the last ending in `\`.
import assert from "node:assert/strict";

/** One fenced block of a Markdown text. */
export interface FencedBlock {
  readonly lang: string;
  readonly code: string;
  /** The 1-based line of the opening fence. */
  readonly line: number;
  /** The text between the previous block, or the start of the page, and this block, trimmed. */
  readonly before: string;
}

/** The line between a command's `sh` block and its `text` block. */
const EXIT_LINE: RegExp = /^It exits (\d+) and prints:$/;

/** One command-line example. */
export interface ShellExample {
  readonly line: number;
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
}

/** The ways a command may start: the installed bin, or the package through npx. */
export const PROGRAMS: readonly string[] = ["explorer-verify", "npx @explorer-verify/cli"];

/**
 * The fenced blocks of a Markdown text, with their language and 1-based opening line. Flags and a
 * title in brackets after the language, as in `sh [verify.sh]`, are allowed and dropped.
 *
 * @param markdown - The text.
 * @returns The blocks, in order.
 */
export function blocks(markdown: string): FencedBlock[] {
  const found: FencedBlock[] = [];
  const pattern = /^```(\w*)[^\n`]*\n([\s\S]*?)^```$/gm;
  let end = 0;
  for (const match of markdown.matchAll(pattern)) {
    const line = markdown.slice(0, match.index).split("\n").length;
    const before = markdown.slice(end, match.index).trim();
    found.push({ lang: String(match[1]), code: String(match[2]), line, before });
    end = match.index + match[0].length;
  }
  return found;
}

/**
 * The `sh` examples of a page, each with the `text` block that follows it. Fails an assertion
 * that names `file` and the line when an example breaks the format.
 *
 * @param markdown - The page.
 * @param file - The page's name, for the messages.
 * @returns The examples, in order.
 */
export function shellExamples(markdown: string, file: string): ShellExample[] {
  const all = blocks(markdown);
  return all.flatMap((block, index) => {
    if (block.lang !== "sh") {
      return [];
    }
    const where = `${file} line ${String(block.line)}`;
    const lines = block.code
      .replace(/[ \t]*\\\n[ \t]*/g, " ")
      .split("\n")
      .filter((text) => text !== "");
    const next = all[index + 1];
    assert.equal(lines.length, 1, `${where}: one command line, and no comment`);
    assert.equal(next?.lang, "text", `${where}: a text block follows`);
    const exit = EXIT_LINE.exec(next.before);
    assert.ok(exit, `${where}: "It exits N and prints:" between the command and its output`);
    const command = String(lines[0]);
    const program = PROGRAMS.find((name) => command.startsWith(`${name} `));
    assert.ok(program, `${where}: starts with ${PROGRAMS.join(" or ")}`);
    const args = command.slice(program.length + 1).split(" ");
    // No quoting or shell syntax: the arguments are split on single spaces.
    assert.ok(
      args.every((arg) => arg !== "" && !/["'`$|;&<>\\]/.test(arg)),
      `${where}: plain arguments only`,
    );
    return [{ line: block.line, args, exitCode: Number(exit[1]), stdout: next?.code ?? "" }];
  });
}
