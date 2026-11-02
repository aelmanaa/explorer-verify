// Copies the user docs into the core package for R-AX-2: every file under `docs/user/` goes to
// `docs/`, and the root `llms.txt` becomes a packaged `llms.txt` whose links to user pages are
// relative. In the pages, links that leave `docs/user/` become raw GitHub URLs. The copies are
// build output and are gitignored. The package's `build` script runs it. A path argument names
// another repository root, which the tests use.
//
// Usage: node scripts/package-docs.ts [root]
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_DIR, packageDocs } from "./agent-docs.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const written = packageDocs(root, path.join(root, PACKAGE_DIR));
process.stdout.write(`package docs: wrote ${written.length} files to ${PACKAGE_DIR}\n`);
