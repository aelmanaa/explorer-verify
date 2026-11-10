// The parser of the command-line examples in the docs (test/helpers/shell-examples.ts): the
// `npx @explorer-verify/cli` prefix, `\` line continuations and titled fences.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blocks, PROGRAMS, shellExamples } from "../helpers/shell-examples.ts";

/** A page with one `sh` block holding `command`, and its output block. */
function page(command: string, fence = "```sh"): string {
  return [
    "Run it:",
    "",
    fence,
    "# exit code 0",
    command,
    "```",
    "",
    "```text",
    "{}",
    "```",
    "",
  ].join("\n");
}

describe("shellExamples", () => {
  it("accepts the installed bin and the npx prefix", () => {
    assert.deepEqual(PROGRAMS, ["explorer-verify", "npx @explorer-verify/cli"]);
    for (const program of PROGRAMS) {
      const [example] = shellExamples(page(`${program} status ev1:x --json`), "x.md");
      assert.deepEqual(example, {
        line: 3,
        args: ["status", "ev1:x", "--json"],
        exitCode: 0,
        stdout: "{}\n",
      });
    }
  });

  it("joins a command split over lines with a backslash", () => {
    const command = [
      "npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \\",
      "  --chain 11155111 --foundry . \\",
      "  --backend sourcify --dry-run --json",
    ].join("\n");
    const [example] = shellExamples(page(command), "x.md");
    assert.deepEqual(example?.args, [
      "verify",
      "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
      "--chain",
      "11155111",
      "--foundry",
      ".",
      "--backend",
      "sourcify",
      "--dry-run",
      "--json",
    ]);
  });

  it("reads a titled sh block", () => {
    const [example] = shellExamples(page("explorer-verify status h", "```sh [status.sh]"), "x.md");
    assert.deepEqual(example?.args, ["status", "h"]);
    assert.deepEqual(
      blocks("```ts no-run [verify.ts]\na();\n```\n").map(({ lang, line }) => ({ lang, line })),
      [{ lang: "ts", line: 1 }],
    );
  });

  it("fails another program, a second command and shell syntax", () => {
    assert.throws(
      () => shellExamples(page("npx explorer-verify status h"), "x.md"),
      /x\.md line 3: starts with/,
    );
    assert.throws(
      () => shellExamples(page("explorer-verify status h\nexplorer-verify status i"), "x.md"),
      /one command line/,
    );
    assert.throws(
      () => shellExamples(page('explorer-verify status "$HANDLE"'), "x.md"),
      /plain arguments only/,
    );
  });
});
