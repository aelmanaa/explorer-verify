// Checks the Stryker comments that mark equivalent mutants in packages/*/src (rules in
// scripts/stryker-disables.ts), prints them with file and line, and checks that the table in
// docs/contributor/testing.md lists each one, so skipped mutants are visible outside the source.
//
// Usage: node scripts/check-stryker-disables.ts [--write]
// `--write` rewrites the table in testing.md; run `pnpm run format` after it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  formatInventory,
  parseDisables,
  readTable,
  section,
  tableRows,
  withTable,
} from "./stryker-disables.ts";
import type { Disable } from "./stryker-disables.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "docs/contributor/testing.md";

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.[cm]?[jt]s$/.test(entry.name) ? [relative] : [];
  });
}

const files = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    try {
      return sourceFiles(path.posix.join("packages", entry.name, "src"));
    } catch {
      return [];
    }
  })
  .toSorted();

const disables: Disable[] = [];
const problems: string[] = [];
for (const file of files) {
  const parsed = parseDisables(file, readFileSync(path.join(root, file), "utf8"));
  disables.push(...parsed.disables);
  problems.push(...parsed.problems);
}

const rows = tableRows(disables);
const doc = readFileSync(path.join(root, DOC), "utf8");
if (process.argv.includes("--write")) {
  writeFileSync(path.join(root, DOC), withTable(doc, rows));
} else {
  const listed = section(doc);
  if (listed === undefined) {
    problems.push(`${DOC}: the stryker-disables section is missing`);
  } else if (!isDeepStrictEqual(readTable(listed), rows)) {
    problems.push(
      `${DOC}: the table of Stryker comments does not match the source; run \`node scripts/check-stryker-disables.ts --write\`, then \`pnpm run format\``,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(formatInventory(disables));
process.stdout.write(
  `stryker disables: ${String(files.length)} files checked, ${String(disables.length)} comments, each listed in ${DOC}\n`,
);
