// Fails when the packed tarball of the core package lacks `llms.txt`, a file under `docs/` (R-AX-2),
// the page of an error code (R-AX-10) or a file under `skills/` (R-AX-4), or when a relative link
// in a packaged page, a skill or the packaged `llms.txt` points outside the tarball. It reads the
// file list from `npm pack --dry-run --json`, and the error codes from the built package. The
// package's `pkg:check` script runs it after the build. A path argument names another repository
// root, which the tests use.
//
// With `--release`, it also fails when a code of the built package is missing from
// released-error-codes.json, or when the built errors module still points `docsUrl` at the
// default branch on GitHub (R-AX-10, decision 0015). The release workflow runs it with the flag.
// Pull request CI does not: a new code is not released until the version step records it.
//
// Usage: node scripts/check-packed-files.ts [--release] [root]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CORE_ENTRY,
  CORE_ERRORS,
  errorCodesOf,
  errorPageFiles,
  missingFromPack,
  PACKAGE_DIR,
  packagedDocFiles,
  SKILLS,
  packagedLinkProblems,
  packedFiles,
  UNRELEASABLE_DOCS_URL,
} from "./agent-docs.ts";
import { parseReleased, RELEASED_CODES, unreleasedCodes } from "./released-codes.ts";

const args = process.argv.slice(2);
const release = args.includes("--release");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...args.filter((arg) => !arg.startsWith("--")),
);
const packageDir = path.join(root, PACKAGE_DIR);

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: packageDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const packed = packedFiles(output);
const core: unknown = await import(pathToFileURL(path.join(root, CORE_ENTRY)).href);
const codes = errorCodesOf(core);
const errorPages = errorPageFiles(codes);
const required = [...new Set([...packagedDocFiles(root), ...errorPages])];
const missing = missingFromPack(packed, required);

/** The requirement a required file comes from. */
function requirement(file: string): string {
  if (file.startsWith(`${SKILLS}/`)) {
    return "R-AX-4";
  }
  return errorPages.includes(file) ? "R-AX-10" : "R-AX-2";
}

const problems = [
  ...missing.map(
    (file) =>
      `The packed tarball lacks ${file}. Run the build, and check \`files\` in ${PACKAGE_DIR}/package.json (${requirement(file)})`,
  ),
  ...packagedLinkProblems(
    packageDir,
    packed.filter((file) => !missing.includes(file)),
  ),
  ...(release ? releaseProblems() : []),
];

/** What stops a release: unlisted codes, and a `docsUrl` on the default branch (R-AX-10). */
function releaseProblems(): string[] {
  const released = parseReleased(readFileSync(path.join(root, RELEASED_CODES), "utf8"));
  const found = unreleasedCodes(released, codes).map(
    (code) => `${RELEASED_CODES} does not list ${code}; run pnpm run version-packages (R-AX-10)`,
  );
  if (readFileSync(path.join(root, CORE_ERRORS), "utf8").includes(UNRELEASABLE_DOCS_URL)) {
    found.push(
      `${CORE_ERRORS} holds ${UNRELEASABLE_DOCS_URL}: docsUrl must point at the docs site before a release (R-AX-10, decision 0015)`,
    );
  }
  return found;
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
const skills = required.filter((file) => file.startsWith(`${SKILLS}/`)).length;
process.stdout.write(
  `packed files: llms.txt, ${required.length - 1 - skills} docs files (the pages of ${errorPages.length} error codes among them) and ${skills} skill files are in the tarball, and their links resolve${release ? "; every code is released and docsUrl points at the docs site" : ""}\n`,
);
