// The CLI reference is generated from the CLI's help (R-AX-2): the committed page holds exactly
// what the generator writes, and a changed description that was not regenerated is caught.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CHAIN_NAMES } from "../../src/chains.ts";
import type { Command } from "../../src/command.ts";
import { COMMANDS } from "../../src/commands.ts";
import { helpResult, helpText } from "../../src/help.ts";
import {
  END_MARKER,
  foldUsage,
  outputBlock,
  referenceBlock,
  replaceBlock,
  START_MARKER,
  USAGE_WIDTH,
} from "../../src/reference.ts";
import { WITH_SCRIPTED } from "../helpers/scripted-command.ts";

const PAGE = readFileSync(
  new URL("../../../../docs/user/reference/cli.md", import.meta.url),
  "utf8",
);
const OUTPUT_PAGE = readFileSync(
  new URL("../../../../docs/user/reference/cli-output.md", import.meta.url),
  "utf8",
);

describe("CLI reference (R-AX-2)", () => {
  it("holds the generated part exactly as the generator writes it", () => {
    assert.equal(replaceBlock(PAGE, referenceBlock(COMMANDS)), PAGE);
    assert.equal(replaceBlock(OUTPUT_PAGE, outputBlock(COMMANDS)), OUTPUT_PAGE);
  });

  it("differs when a flag's description changes and the page is not regenerated", () => {
    const [first] = COMMANDS;
    assert.ok(first);
    const changed: Command = {
      ...first,
      options: {
        ...first.options,
        polls: {
          type: "string",
          value: "<n>",
          description: "A new description.",
        },
      },
    };
    const page = replaceBlock(PAGE, referenceBlock([changed]));
    assert.notEqual(page, PAGE);
    assert.match(page, /\| `--polls <n>` +\| A new description\. +\|/);
  });

  it("lists every command, every global option, every variable and every exit code", () => {
    const block = referenceBlock(COMMANDS);
    const output = outputBlock(COMMANDS);
    for (const each of [block, output]) {
      assert.ok(each.startsWith(`${START_MARKER}\n`));
      assert.ok(each.endsWith(`${END_MARKER}\n`));
    }
    for (const text of [
      "| `-h`, `--help` ",
      "| `--log-format <format>` ",
      "| `EXPLORER_VERIFY_LOG` ",
      "| 130  |",
    ]) {
      assert.ok(output.includes(text), text);
      assert.ok(!block.includes(text), text);
    }
    for (const text of [
      "### `verify`",
      "### `status`",
      "Usage:\n\n```text\nexplorer-verify verify <address>",
      "```\n\n| Option ",
    ]) {
      assert.ok(block.includes(text), text);
    }
    assert.doesNotMatch(block, /Hidden commands/);
    // The examples are written on the page, with their output, not generated.
    assert.doesNotMatch(block, /^## Examples$|^Examples:$/m);
  });

  it("folds every line of its code blocks to the usage width", () => {
    const fences = [...referenceBlock(COMMANDS).matchAll(/^```text\n([\s\S]*?)\n```$/gm)];
    assert.ok(fences.length >= 3);
    for (const [, body] of fences) {
      for (const line of String(body).split("\n")) {
        assert.ok(line.length <= USAGE_WIDTH, line);
      }
    }
  });

  it("lists a hidden command in its own section", () => {
    const block = referenceBlock(WITH_SCRIPTED);
    assert.ok(block.includes("## Hidden commands\n"));
    assert.ok(block.includes("### `scripted`"));
    // A hidden command keeps its summary; a public one has it in the table of commands.
    assert.doesNotMatch(block, /### `scripted`\n\nUsage:/);
    assert.match(block, /### `verify`\n\nUsage:/);
  });

  it("writes a table of public commands, and escapes a pipe in a cell", () => {
    const visible: Command = {
      name: "verify",
      summary: "Verify a | contract.",
      usage: "<input>",
      examples: [{ args: "verify input.json", description: "Verify it." }],
      options: {
        file: { type: "string", multiple: true, description: "A file." },
      },
      maxPositionals: 1,
      run: async () => await Promise.reject(new Error("must not run")),
    };
    const block = referenceBlock([visible]);
    assert.match(block, /^\| Command +\| What it does +\|$/m);
    assert.match(block, /^\| `verify` +\| Verify a \\\| contract\. +\|$/m);
    assert.match(block, /^```text\nexplorer-verify verify <input> \[options\]\n```$/m);
    assert.doesNotMatch(block, /Hidden commands/);
    assert.doesNotMatch(block, /no public commands yet/);
    assert.match(block, /^\| `--file <value>` \| A file\. Repeatable\. \|$/m);
  });

  it("says so when no command is public, in the reference and in the help", () => {
    assert.match(referenceBlock([]), /^This version has no public commands yet\.$/m);
    assert.match(helpText(helpResult([])), /^ {2}This version has no public commands yet\.$/m);
  });

  it("lists every chain name --chain takes, with its ID, one row per ID (#225)", () => {
    const block = referenceBlock(COMMANDS);
    const ids = new Set(CHAIN_NAMES.values());
    assert.match(block, new RegExp(`<summary>The names of ${String(ids.size)} chains</summary>`));
    for (const [name, chainId] of CHAIN_NAMES) {
      const row = new RegExp(
        `^\\| (?:\`[a-z-]+\`, )*\`${name}\`(?:, \`[a-z-]+\`)* +\\| ${String(chainId)} +\\|$`,
        "m",
      );
      assert.match(block, row, name);
    }
    assert.match(block, /^\| `mainnet`, `ethereum` +\| 1 +\|$/m);
    assert.equal(block.slice(block.indexOf("<summary>")).match(/^\| `/gm)?.length, ids.size);
  });

  it("folds a long usage line before an option, a group or a part in brackets", () => {
    const usage =
      "explorer-verify verify <address> --chain <chain> --input <file>... (--backend <name> | --dry-run) [options]";
    assert.deepEqual(foldUsage(usage), [
      "explorer-verify verify <address> --chain <chain> --input <file>...",
      "  (--backend <name> | --dry-run) [options]",
    ]);
    assert.deepEqual(foldUsage("explorer-verify status <handle> [options]"), [
      "explorer-verify status <handle> [options]",
    ]);
    assert.deepEqual(foldUsage(`a ${"b".repeat(USAGE_WIDTH)} [c]`), [
      `a ${"b".repeat(USAGE_WIDTH)}`,
      "  [c]",
    ]);
    // A line may end exactly at the width.
    const exact = `${"x".repeat(USAGE_WIDTH - 4)} [y]`;
    assert.deepEqual(foldUsage(exact), [exact]);
    assert.deepEqual(foldUsage(`${exact} --z`), [exact, "  --z"]);
  });

  it("replaces only the part between the markers", () => {
    const page = `# Title\n\nBefore.\n\n${START_MARKER}\nold\n${END_MARKER}\n\nAfter.\n`;
    assert.equal(
      replaceBlock(page, `${START_MARKER}\nnew\n${END_MARKER}\n`),
      `# Title\n\nBefore.\n\n${START_MARKER}\nnew\n${END_MARKER}\n\nAfter.\n`,
    );
    assert.equal(replaceBlock(`${START_MARKER}\n${END_MARKER}`, "block\n"), "block\n");
  });

  it("refuses a page without each marker exactly once, start first", () => {
    for (const page of [
      "no markers",
      `${START_MARKER}\nonly the start`,
      `${END_MARKER}\n${START_MARKER}\n`,
      `${START_MARKER}\n${START_MARKER}\n${END_MARKER}\n`,
      `${START_MARKER}\n${END_MARKER}\n${END_MARKER}\n`,
    ]) {
      assert.throws(() => replaceBlock(page, "x"), /each marker of the generated part once/);
    }
  });
});
