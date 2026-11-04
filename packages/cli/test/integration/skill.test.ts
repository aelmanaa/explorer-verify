// The skill's command-line examples run against the built bin (R-AX-4): each `sh` block of
// skills/explorer-verify/SKILL.md holds one `explorer-verify` command line and a `# exit code N`
// comment, and the `text` block after it holds what the command prints on stdout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { runBin } from "../helpers/spawn-bin.ts";

const SKILL = readFileSync(
  new URL("../../../../skills/explorer-verify/SKILL.md", import.meta.url),
  "utf8",
);

/** One command-line example of the skill. */
interface ShellExample {
  readonly line: number;
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
}

/** The fenced blocks of a Markdown text, with their language and 1-based opening line. */
function blocks(markdown: string): { lang: string; code: string; line: number }[] {
  const found: { lang: string; code: string; line: number }[] = [];
  const pattern = /^```(\w*)\n([\s\S]*?)^```$/gm;
  for (const match of markdown.matchAll(pattern)) {
    const line = markdown.slice(0, match.index).split("\n").length;
    found.push({ lang: String(match[1]), code: String(match[2]), line });
  }
  return found;
}

/** The `sh` examples, each with the `text` block that follows it. */
function shellExamples(markdown: string): ShellExample[] {
  const all = blocks(markdown);
  return all.flatMap((block, index) => {
    if (block.lang !== "sh") {
      return [];
    }
    const lines = block.code.split("\n").filter((text) => text !== "");
    const commands = lines.filter((text) => !text.startsWith("#"));
    const exit = lines.map((text) => /^# exit code (\d+)$/.exec(text)).find((match) => match);
    const next = all[index + 1];
    assert.equal(commands.length, 1, `SKILL.md line ${String(block.line)}: one command line`);
    assert.ok(exit, `SKILL.md line ${String(block.line)}: a "# exit code N" comment`);
    assert.equal(next?.lang, "text", `SKILL.md line ${String(block.line)}: a text block follows`);
    const [program, ...args] = String(commands[0]).split(" ");
    assert.equal(program, "explorer-verify", `SKILL.md line ${String(block.line)}`);
    // No quoting or shell syntax: the arguments are split on single spaces.
    assert.ok(
      args.every((arg) => arg !== "" && !/["'`$|;&<>\\]/.test(arg)),
      `SKILL.md line ${String(block.line)}: plain arguments only`,
    );
    return [{ line: block.line, args, exitCode: Number(exit[1]), stdout: next?.code ?? "" }];
  });
}

describe("the skill's command-line examples (R-AX-4)", () => {
  const examples = shellExamples(SKILL);

  it("has at least one", () => {
    assert.ok(examples.length > 0);
  });

  for (const example of examples) {
    it(`SKILL.md line ${String(example.line)}: explorer-verify ${example.args.join(" ")}`, async () => {
      const result = await runBin(example.args);
      assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout, example.stdout);
    });
  }
});
