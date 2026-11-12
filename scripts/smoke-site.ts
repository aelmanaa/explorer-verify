// Checks the deployed docs site over HTTPS (R-AX-10 and R-AX-17, decision 0015, test 4): the
// `docsUrl` of every error code and its `.md` copy, the site's `llms.txt` and every link in it
// return 200, each within 10 seconds, and the site's `llms.txt` names the version of the core
// package, so a site still serving an older version fails. Every file under `docs/user/` that is
// not a page, such as the sample verify request, must return 200, and a JSON file must parse as
// JSON. `sitemap.xml` must return 200 and list the home page, the Google verification file that
// `site/verification.json` names must return 200 with its exact content, and the home page must
// hold each search console meta tag whose token is set (issue #366). It reads the codes and their
// URLs from the built core package. The deploy workflow runs it
// on the version's tag after the deploy, so a failure fails the workflow and stops a caller that
// waits on it.
//
// A new deployment can take a short time to reach every edge, so the check runs up to `--attempts`
// times (default 5), `--delay` seconds apart (default 15), and fails with the problems of the last
// attempt. `--url` names another site to check instead of the docs site; the tests use it with a
// local server. A path argument names another repository root.
//
// Usage: node scripts/smoke-site.ts [--url <site>] [--attempts <n>] [--delay <seconds>] [root]
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CORE_ENTRY, packageVersion } from "./agent-docs.ts";
import { docsUrlsOf, siteAssets, SITE_URL, smokeProblems } from "./site-docs.ts";
import { readVerification, verificationFiles, verificationTags } from "./site-seo.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: SITE_URL },
    attempts: { type: "string", default: "5" },
    delay: { type: "string", default: "15" },
  },
});
const attempts = Number(values.attempts);
const delay = Number(values.delay);
if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delay) || delay < 0) {
  process.stderr.write("--attempts must be a positive integer and --delay a number of seconds\n");
  process.exit(2);
}
const site = values.url.endsWith("/") ? values.url : `${values.url}/`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ...positionals);
const core: unknown = await import(pathToFileURL(path.join(root, CORE_ENTRY)).href);
const urls = docsUrlsOf(core, CORE_ENTRY);
const version = packageVersion(root);
const assets = siteAssets(root);
const verification = readVerification(root);
const search = {
  files: verificationFiles(verification),
  homeMeta: verificationTags(verification),
};

let problems: string[] = [];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  problems = await smokeProblems(site, version, urls, fetch, assets, search);
  if (problems.length === 0) {
    break;
  }
  if (attempt < attempts) {
    process.stderr.write(
      `site smoke: attempt ${attempt} of ${attempts} found ${problems.length} problems; trying again in ${delay} s\n`,
    );
    await sleep(delay * 1000);
  }
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `site smoke: ${site} serves the page and Markdown copy of ${urls.length} error codes, ${assets.length} other files, llms.txt, every page it lists and the sitemap\n`,
);
