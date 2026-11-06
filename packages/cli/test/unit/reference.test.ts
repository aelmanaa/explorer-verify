// The CLI reference is generated from the CLI's help (R-AX-2): the committed page holds exactly
// what the generator writes, and a changed description that was not regenerated is caught.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CHAIN_NAMES } from "../../src/chains.ts";
import type { Command } from "../../src/command.ts";
import { COMMANDS } from "../../src/commands.ts";
import { helpResult, helpText } from "../../src/help.ts";
import { END_MARKER, referenceBlock, replaceBlock, START_MARKER } from "../../src/reference.ts";
import { WITH_SCRIPTED } from "../helpers/scripted-command.ts";

const PAGE = readFileSync(
  new URL("../../../../docs/user/reference/cli.md", import.meta.url),
  "utf8",
);

describe("CLI reference (R-AX-2)", () => {
  it("holds the generated part exactly as the generator writes it", () => {
    assert.equal(replaceBlock(PAGE, referenceBlock(COMMANDS)), PAGE);
  });

  it("differs when a flag's description changes and the page is not regenerated", () => {
    const [first] = COMMANDS;
    assert.ok(first);
    const changed: Command = {
      ...first,
      options: {
        ...first.options,
        polls: { type: "string", value: "<n>", description: "A new description." },
      },
    };
    const page = replaceBlock(PAGE, referenceBlock([changed]));
    assert.notEqual(page, PAGE);
    assert.match(page, /\| `--polls <n>` +\| A new description\. +\|/);
  });

  it("lists every command, every global option, every variable and every exit code", () => {
    const block = referenceBlock(COMMANDS);
    assert.ok(block.startsWith(`${START_MARKER}\n`));
    assert.ok(block.endsWith(`${END_MARKER}\n`));
    for (const text of [
      "### `verify`",
      "### `status`",
      "| `-h`, `--help` ",
      "| `--log-format <format>` ",
      "| `EXPLORER_VERIFY_LOG` ",
      "| 130  |",
      "- `explorer-verify --version --json`: ",
    ]) {
      assert.ok(block.includes(text), text);
    }
    assert.doesNotMatch(block, /Hidden commands/);
  });

  it("lists a hidden command in its own section", () => {
    const block = referenceBlock(WITH_SCRIPTED);
    assert.ok(block.includes("## Hidden commands\n"));
    assert.ok(block.includes("### `scripted`"));
  });

  it("writes a table of public commands, and escapes a pipe in a cell", () => {
    const visible: Command = {
      name: "verify",
      summary: "Verify a | contract.",
      usage: "<input>",
      examples: [{ args: "verify input.json", description: "Verify it." }],
      options: { file: { type: "string", multiple: true, description: "A file." } },
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

  it("lists every chain name --chain takes, with its ID (#225)", () => {
    const block = referenceBlock(COMMANDS);
    for (const [name, chainId] of CHAIN_NAMES) {
      assert.match(block, new RegExp(`^\\| \`${name}\` +\\| ${String(chainId)} +\\|$`, "m"), name);
    }
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
