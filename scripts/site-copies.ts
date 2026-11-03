// Writes the agent-readable files of the docs site into the VitePress build output (R-AX-17,
// decision 0015): a Markdown copy of each user page next to its HTML, with links rewritten for the
// site, and the site's `llms.txt`. `pnpm run site:build` runs it after `vitepress build`. The rules
// are in scripts/site-docs.ts. A path argument names another repository root, which the tests
// use.
//
// Usage: node scripts/site-copies.ts [root]
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageVersion } from "./agent-docs.ts";
import { SITE_OUT, writeSiteCopies } from "./site-docs.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const written = writeSiteCopies(root, path.join(root, SITE_OUT), packageVersion(root));
process.stdout.write(`site copies: wrote ${written.length} files to ${SITE_OUT}\n`);
