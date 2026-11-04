// Writes the generated part of the CLI reference, docs/user/reference/cli.md, from the CLI's
// command table and help (R-AX-2). With `--check`, it writes nothing and fails when the committed
// page differs, so a changed flag or description that was not regenerated fails `pnpm run check`.
// A path argument names another repository root, which the tests use.
//
// Usage: node scripts/generate-cli-reference.ts [--check] [root]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../packages/cli/src/commands.ts";
import { referenceBlock, replaceBlock } from "../packages/cli/src/reference.ts";

/** The CLI reference, from the repository root. */
const CLI_REFERENCE = "docs/user/reference/cli.md";

const args = process.argv.slice(2);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...args.filter((arg) => !arg.startsWith("--")),
);
const file = path.join(root, CLI_REFERENCE);
const page = readFileSync(file, "utf8");
const generated = replaceBlock(page, referenceBlock(COMMANDS));

if (args.includes("--check")) {
  if (generated !== page) {
    process.stderr.write(
      `cli reference: ${CLI_REFERENCE} differs from the CLI's help. Run node scripts/generate-cli-reference.ts and commit the result.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`cli reference: ${CLI_REFERENCE} matches the CLI's help\n`);
} else {
  writeFileSync(file, generated);
  process.stdout.write(`cli reference: ${CLI_REFERENCE} written\n`);
}
