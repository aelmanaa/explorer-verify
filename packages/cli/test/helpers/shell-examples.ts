// The command-line examples of a Markdown page, for the tests that run them against the built bin
// (R-AX-3, R-AX-4): each `sh` block holds one `explorer-verify` command line and a
// `# exit code N` comment, and the `text` block after it holds what the command prints on stdout.
import assert from "node:assert/strict";

/** One fenced block of a Markdown text. */
export interface FencedBlock {
  readonly lang: string;
  readonly code: string;
  /** The 1-based line of the opening fence. */
  readonly line: number;
}

/** One command-line example. */
export interface ShellExample {
  readonly line: number;
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * The fenced blocks of a Markdown text, with their language and 1-based opening line.
 *
 * @param markdown - The text.
 * @returns The blocks, in order.
 */
export function blocks(markdown: string): FencedBlock[] {
  const found: FencedBlock[] = [];
  const pattern = /^```(\w*)\n([\s\S]*?)^```$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const line = markdown.slice(0, match.index).split("\n").length;
    found.push({ lang: String(match[1]), code: String(match[2]), line });
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
    const lines = block.code.split("\n").filter((text) => text !== "");
    const commands = lines.filter((text) => !text.startsWith("#"));
    const exit = lines.map((text) => /^# exit code (\d+)$/.exec(text)).find((match) => match);
    const next = all[index + 1];
    assert.equal(commands.length, 1, `${where}: one command line`);
    assert.ok(exit, `${where}: a "# exit code N" comment`);
    assert.equal(next?.lang, "text", `${where}: a text block follows`);
    const [program, ...args] = String(commands[0]).split(" ");
    assert.equal(program, "explorer-verify", where);
    // No quoting or shell syntax: the arguments are split on single spaces.
    assert.ok(
      args.every((arg) => arg !== "" && !/["'`$|;&<>\\]/.test(arg)),
      `${where}: plain arguments only`,
    );
    return [{ line: block.line, args, exitCode: Number(exit[1]), stdout: next?.code ?? "" }];
  });
}
