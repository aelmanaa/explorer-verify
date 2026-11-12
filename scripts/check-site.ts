// Checks the built docs site (R-AX-10 and R-AX-17, decision 0015, test 3): the `docsUrl` of every
// error code, with the site base removed, maps to an HTML page in the build output with its `.md`
// copy next to it; every link in the site's `llms.txt` is a Markdown copy in the build; every HTML
// page other than the 404 page, the site-only pages of `site/pages/` (decision 0062) and the files
// of `site/static/` has a copy that `llms.txt` lists; and every other file under `docs/user/` is
// in the build. It also checks that every user page is in exactly one sidebar group and has a
// description, and what the site tells search engines (scripts/site-seo.ts): the sitemap, a
// unique title and description, one canonical link and the Open Graph tags on every page, the
// home page's JSON-LD and the search console tags and file. It reads the codes and their URLs
// from the built core package. Pull request CI runs it after `pnpm run site:build`. A path
// argument names another repository root, which the tests use.
//
// Usage: node scripts/check-site.ts [root]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CORE_ENTRY, packageVersion } from "./agent-docs.ts";
import { descriptionProblems } from "./site-descriptions.ts";
import {
  docsUrlsOf,
  sidebarProblems,
  SITE_OUT,
  siteAssets,
  siteDescription,
  sitePages,
  siteProblems,
  siteStaticFiles,
} from "./site-docs.ts";
import { readVerification, searchProblems } from "./site-seo.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ...process.argv.slice(2),
);
const core: unknown = await import(pathToFileURL(path.join(root, CORE_ENTRY)).href);
const urls = docsUrlsOf(core, CORE_ENTRY);
const version = packageVersion(root);
const staticFiles = siteStaticFiles(root);
const outDir = path.join(root, SITE_OUT);
const problems = [
  ...sidebarProblems(root),
  ...descriptionProblems(root),
  ...siteProblems(outDir, urls, {
    siteOnly: sitePages(root),
    assets: siteAssets(root),
    staticFiles,
  }),
  ...searchProblems(outDir, {
    version,
    siteDescription: siteDescription(version),
    verification: readVerification(root),
    staticFiles,
  }),
];
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `site: the docsUrl of ${urls.length} error codes, llms.txt, the Markdown copies, the sidebar, the sitemap and the search tags resolve in ${SITE_OUT}\n`,
);
