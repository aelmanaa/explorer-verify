// Checks the built docs site (R-AX-10 and R-AX-17, decision 0015, test 3): the `docsUrl` of every
// error code, with the site base removed, maps to an HTML page in the build output with its `.md`
// copy next to it; every link in the site's `llms.txt` is a Markdown copy in the build; every HTML
// page other than the 404 page and the site-only pages of `site/pages/` (decision 0062) has a copy
// that `llms.txt` lists; and every other file under `docs/user/` is in the build. It also checks
// that every user page is in exactly one sidebar group. It reads the codes and their URLs from the
// built core package. Pull request CI runs it after `pnpm run site:build`. A path argument names
// another repository root, which the tests use.
//
// Usage: node scripts/check-site.ts [root]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CORE_ENTRY } from "./agent-docs.ts";
import {
  docsUrlsOf,
  sidebarProblems,
  SITE_OUT,
  siteAssets,
  sitePages,
  siteProblems,
} from "./site-docs.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const core: unknown = await import(pathToFileURL(path.join(root, CORE_ENTRY)).href);
const urls = docsUrlsOf(core, CORE_ENTRY);
const problems = [
  ...sidebarProblems(root),
  ...siteProblems(path.join(root, SITE_OUT), urls, {
    siteOnly: sitePages(root),
    assets: siteAssets(root),
  }),
];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `site: the docsUrl of ${urls.length} error codes, llms.txt, the Markdown copies and the sidebar resolve in ${SITE_OUT}\n`,
);
