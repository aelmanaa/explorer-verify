// Fails when the packed tarball of the core package lacks `llms.txt` or a user page under `docs/`
// (R-AX-2). It reads the file list from `npm pack --dry-run --json`. The package's `pkg:check`
// script runs it after the build.
//
// Usage: node scripts/check-packed-files.ts
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { missingFromPack, PACKAGE_DIR, packagedDocFiles, packedFiles } from "./agent-docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: path.join(root, PACKAGE_DIR),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const required = packagedDocFiles(root);
const missing = missingFromPack(packedFiles(output), required);
if (missing.length > 0) {
  process.stderr.write(
    `The packed tarball lacks: ${missing.join(", ")}. Run the build, and check \`files\` in ${PACKAGE_DIR}/package.json (R-AX-2)\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `packed files: llms.txt and ${required.length - 1} user pages are in the tarball\n`,
);
