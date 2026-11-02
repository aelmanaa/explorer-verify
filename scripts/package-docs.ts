// Copies the user docs into the core package for R-AX-2: `docs/user/` becomes `docs/`, and the
// root `llms.txt` becomes a packaged `llms.txt` whose links to user pages are relative. Links that
// leave `docs/user/` become GitHub URLs. The copies are build output and are gitignored. The
// package's `build` script runs it.
//
// Usage: node scripts/package-docs.ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_DIR, packageDocs } from "./agent-docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const written = packageDocs(root, path.join(root, PACKAGE_DIR));
process.stdout.write(`package docs: wrote ${written.length} files to ${PACKAGE_DIR}\n`);
