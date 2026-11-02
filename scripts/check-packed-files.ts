// Fails when the packed tarball of the core package lacks `llms.txt` or a file under `docs/`, or
// when a relative link in a packaged page or the packaged `llms.txt` points outside the tarball
// (R-AX-2). It reads the file list from `npm pack --dry-run --json`. The package's `pkg:check`
// script runs it after the build. A path argument names another repository root, which the tests
// use.
//
// Usage: node scripts/check-packed-files.ts [root]
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  missingFromPack,
  PACKAGE_DIR,
  packagedDocFiles,
  packagedLinkProblems,
  packedFiles,
} from "./agent-docs.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const packageDir = path.join(root, PACKAGE_DIR);

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: packageDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const packed = packedFiles(output);
const required = packagedDocFiles(root);
const missing = missingFromPack(packed, required);
const problems = [
  ...missing.map(
    (file) =>
      `The packed tarball lacks ${file}. Run the build, and check \`files\` in ${PACKAGE_DIR}/package.json (R-AX-2)`,
  ),
  ...packagedLinkProblems(
    packageDir,
    packed.filter((file) => !missing.includes(file)),
  ),
];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `packed files: llms.txt and ${required.length - 1} docs files are in the tarball, and their links resolve\n`,
);
