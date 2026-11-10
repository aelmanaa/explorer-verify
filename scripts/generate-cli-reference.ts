// Writes the generated parts of the CLI reference, docs/user/reference/cli.md, and of the CLI
// output page, docs/user/reference/cli-output.md, from the CLI's command table and help (R-AX-2).
// With `--check`, it writes nothing and fails when a committed page differs, so a changed flag or
// description that was not regenerated fails `pnpm run check`. A path argument names another
// repository root, which the tests use.
//
// Usage: node scripts/generate-cli-reference.ts [--check] [root]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../packages/cli/src/commands.ts";
import { outputBlock, referenceBlock, replaceBlock } from "../packages/cli/src/reference.ts";

/** Each page, from the repository root, with its generated part. */
const PAGES: readonly (readonly [string, string])[] = [
  ["docs/user/reference/cli.md", referenceBlock(COMMANDS)],
  ["docs/user/reference/cli-output.md", outputBlock(COMMANDS)],
];

const args = process.argv.slice(2);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...args.filter((arg) => !arg.startsWith("--")),
);

let stale = false;
for (const [name, block] of PAGES) {
  const file = path.join(root, name);
  const page = readFileSync(file, "utf8");
  const generated = replaceBlock(page, block);
  if (!args.includes("--check")) {
    writeFileSync(file, generated);
    process.stdout.write(`cli reference: ${name} written\n`);
  } else if (generated === page) {
    process.stdout.write(`cli reference: ${name} matches the CLI's help\n`);
  } else {
    process.stderr.write(
      `cli reference: ${name} differs from the CLI's help. Run node scripts/generate-cli-reference.ts and commit the result.\n`,
    );
    stale = true;
  }
}
if (stale) {
  process.exit(1);
}
