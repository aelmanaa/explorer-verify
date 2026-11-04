// The docs site (R-AX-17, decision 0015): the user docs built with VitePress, plus `llms.txt` and a
// Markdown copy of each page, served on GitHub Pages. Used by the VitePress config in
// site/.vitepress/config.ts, scripts/site-copies.ts, scripts/check-site.ts and
// scripts/smoke-site.ts.
//
// The site is the third link target of the docs, after GitHub and the npm package:
// - A page keeps its path under `docs/user/`, except `README.md`, which becomes `index.md`.
// - A link inside `docs/user/` stays relative. A link to the root `llms.txt` points to the site's
//   `llms.txt`. Any other link into the repository points to the file on GitHub at the version's
//   tag, because the site is built from that tag.
// - The site's `llms.txt` is the root one with only the user pages, each linked as its Markdown
//   copy on the site, plus a line that names the version and a section that lists the pages of
//   the API reference.
// - The API reference (scripts/site-api.ts) is generated into `site/api/` and served under `api/`.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  errorCodesOf,
  headings,
  isExternalOrFragment,
  listFiles,
  markdownLinks,
  RAW_MAIN,
  resolveLink,
  rewriteLinks,
  splitTarget,
  USER_DOCS,
} from "./agent-docs.ts";
import { API_OUT, API_SITE_DIR, apiPages } from "./site-api.ts";
import type { ApiPage } from "./site-api.ts";

/** The address of the docs site. Every `docsUrl` starts with it before 1.0. */
export const SITE_URL = "https://aelmanaa.github.io/explorer-verify/";
/** The path the site is served under, VitePress's `base`. */
export const SITE_BASE = "/explorer-verify/";
/** The folder of the VitePress config, relative to the repository root. */
export const SITE_ROOT = "site";
/** The folder of the built site, relative to the repository root. */
export const SITE_OUT = "site/dist";
/** The prefix of a link to a file of this repository on GitHub, before the git ref. */
export const GITHUB_BLOB = "https://github.com/aelmanaa/explorer-verify/blob/";
/** The URL of the docs of one published version on jsDelivr, with `<version>` to fill in. */
const JSDELIVR_LLMS = "https://cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt";

/** The path on the site of a page under `docs/user/`: `README.md` becomes `index.md`. */
export function sitePath(page: string): string {
  return path.posix.basename(page) === "README.md"
    ? path.posix.join(path.posix.dirname(page), "index.md")
    : page;
}

/**
 * The VitePress `rewrites` map, from each page's path under the repository root, VitePress's
 * `srcDir`, to its path on the site: a page under `docs/user/` goes to the site root (`README.md`
 * as `index.md`), and a page of the API reference in `site/api/` goes under `api/`. Throws when
 * two pages would get the same path.
 */
export function siteRewrites(root: string): Record<string, string> {
  const rewrites: Record<string, string> = {};
  const sources = new Map<string, string>();
  const add = (source: string, target: string): void => {
    const other = sources.get(target);
    if (other !== undefined) {
      throw new Error(`${other} and ${source} would both be ${target}`);
    }
    sources.set(target, source);
    rewrites[source] = target;
  };
  for (const file of listFiles(root, USER_DOCS, ".md")) {
    add(file, sitePath(path.posix.relative(USER_DOCS, file)));
  }
  for (const { page } of apiPages(path.join(root, API_OUT))) {
    add(path.posix.join(API_OUT, page), path.posix.join(API_SITE_DIR, page));
  }
  return rewrites;
}

/**
 * The VitePress `srcExclude` patterns. VitePress reads the pages from the repository root, so it
 * sees both `docs/user/` and the generated `site/api/`; these patterns hide every other Markdown
 * file: each top-level file, and each folder that holds neither of the two. Hidden entries are
 * left out, because VitePress skips them already.
 */
export function siteSourceExcludes(root: string): string[] {
  const kept = [USER_DOCS, API_OUT];
  const excludes: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      .toSorted((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const relative = path.posix.join(directory, entry.name);
      if (!entry.directory) {
        if (entry.name.endsWith(".md")) {
          excludes.push(relative);
        }
      } else if (kept.some((folder) => folder.startsWith(`${relative}/`))) {
        visit(relative);
      } else if (!kept.includes(relative)) {
        excludes.push(`${relative}/**`);
      }
    }
  };
  visit(".");
  return excludes;
}

/**
 * Rewrites the relative links of a user page for the site. `file` is the page's repository path,
 * under `docs/user/`, and `version` the version the site is built from.
 */
export function rewriteForSite(file: string, text: string, version: string): string {
  const here = path.posix.dirname(path.posix.relative(USER_DOCS, file));
  return rewriteLinks(text, (target) => {
    if (isExternalOrFragment(target)) {
      return target;
    }
    const { file: linked } = splitTarget(target);
    const rest = target.slice(linked.length);
    const relative = resolveLink(file, linked);
    if (relative.startsWith(`${USER_DOCS}/`)) {
      const page = path.posix.relative(USER_DOCS, relative);
      const moved = sitePath(page);
      return moved === page ? target : `${path.posix.relative(here, moved)}${rest}`;
    }
    if (relative === "llms.txt") {
      return `${path.posix.relative(here, "llms.txt")}${rest}`;
    }
    return `${GITHUB_BLOB}v${version}/${relative}${rest}`;
  });
}

/** The H2 section of the site's `llms.txt` that lists the pages of the API reference. */
export const API_SECTION = "## API reference";

/**
 * The site's `llms.txt`, from the root one: links to user pages point to their Markdown copies on
 * the site, list items that link anything else are dropped, and so are sections left empty. A
 * line after the summary names the version and where the docs of other versions are. When `api`
 * lists pages of the API reference, a last section links their Markdown copies.
 */
export function siteLlmsTxt(text: string, version: string, api: readonly ApiPage[] = []): string {
  const userDocs = `${RAW_MAIN}${USER_DOCS}/`;
  const kept: string[] = [];
  let dropping = false;
  for (const line of text.split("\n")) {
    if (dropping && /^\s+\S/.test(line)) {
      continue;
    }
    dropping = false;
    if (/^\s*[-*] /.test(line)) {
      const targets = markdownLinks(line).map(({ target }) => target);
      if (targets.length === 0 || !targets.every((target) => target.startsWith(userDocs))) {
        dropping = true;
        continue;
      }
      kept.push(
        line.replaceAll(
          new RegExp(`${userDocs.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^)>\\s]+)`, "g"),
          (_whole, page: string) => `${SITE_URL}${sitePath(page)}`,
        ),
      );
      continue;
    }
    kept.push(line);
  }
  const summary = kept.findIndex((line) => line.startsWith("> "));
  if (summary === -1) {
    throw new Error("llms.txt has no summary blockquote");
  }
  kept.splice(
    summary + 1,
    0,
    "",
    `${siteVersionText(version)} Each link is the Markdown copy of a page; drop \`.md\` for the HTML page. The npm package ships the docs of the installed version under \`docs/\`, and jsDelivr serves those of any published version: ${JSDELIVR_LLMS}.`,
  );
  const lines = dropEmptySections(kept);
  if (api.length > 0) {
    lines.push(
      API_SECTION,
      "",
      "Generated from the TSDoc of each package entry point. The `.d.ts` files in the npm packages carry the same comments.",
      "",
      ...api.map(
        ({ page, title }) =>
          `- [${title}](${SITE_URL}${API_SITE_DIR}/${page}): ${page === "index.md" ? "the list of entry points" : `the exports of \`${title}\``}`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

/** The sentence of the site's `llms.txt` that names the version; the smoke check looks for it. */
function siteVersionText(version: string): string {
  return `This site holds the docs of explorer-verify ${version}.`;
}

/** The lines without each H2 section that holds no list item. */
function dropEmptySections(lines: readonly string[]): string[] {
  const result: string[] = [];
  let section: string[] | undefined;
  const flush = (): void => {
    if (section !== undefined && section.some((line) => /^\s*[-*] /.test(line))) {
      result.push(...section);
    }
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      section = [line];
    } else if (section === undefined) {
      result.push(line);
    } else {
      section.push(line);
    }
  }
  flush();
  while (result.at(-1) === "") {
    result.pop();
  }
  return [...result, ""];
}

/** One group of the site's sidebar. */
export interface SidebarGroup {
  text: string;
  collapsed: boolean;
  items: { text: string; link: string }[];
}

/** The groups of the sidebar, by the first folder under `docs/user/`. */
const GROUPS: readonly { folder: string; text: string; collapsed: boolean }[] = [
  { folder: "tutorials", text: "Tutorials", collapsed: false },
  { folder: "guides", text: "Guides", collapsed: false },
  { folder: "reference/errors", text: "Errors", collapsed: true },
  { folder: "reference", text: "Reference", collapsed: false },
  { folder: "explanation", text: "Explanation", collapsed: false },
];

/** The site link of a page path: no `.md`, and a folder index as the folder. */
function siteLink(page: string): string {
  const link = `/${sitePath(page).replace(/\.md$/, "")}`;
  return link.endsWith("/index") ? link.slice(0, -"index".length) : link;
}

/**
 * The sidebar: one group per folder that has pages, in Diátaxis order, each page under its first
 * heading. The error codes form their own group, after the folder index.
 */
export function siteSidebar(root: string): SidebarGroup[] {
  const pages = listFiles(root, USER_DOCS, ".md").map((file) =>
    path.posix.relative(USER_DOCS, file),
  );
  const groups: SidebarGroup[] = [];
  for (const group of GROUPS) {
    const items = pages
      .filter(
        (page) =>
          page.startsWith(`${group.folder}/`) &&
          !GROUPS.some(
            (other) =>
              other.folder.length > group.folder.length && page.startsWith(`${other.folder}/`),
          ),
      )
      .map((page) => ({
        text: headings(readFileSync(path.join(root, USER_DOCS, page), "utf8"))[0] ?? page,
        link: siteLink(page),
      }))
      .toSorted((a, b) => Number(b.link.endsWith("/")) - Number(a.link.endsWith("/")));
    if (items.length > 0) {
      groups.push({ text: group.text, collapsed: group.collapsed, items });
    }
  }
  const api = apiPages(path.join(root, API_OUT));
  if (api.length > 0) {
    groups.push({
      text: "API reference",
      collapsed: false,
      items: api.map(({ page, title }) => ({
        text: title,
        link: siteLink(path.posix.join(API_SITE_DIR, page)),
      })),
    });
  }
  return groups;
}

/**
 * Writes the Markdown copy of every user page next to its HTML in `outDir`, with its links
 * rewritten for the site, copies every other file under `docs/user/` as is, copies each page of
 * the API reference to `api/`, its links being relative already, and writes the site's
 * `llms.txt`. Returns the paths written, relative to `outDir`.
 */
export function writeSiteCopies(root: string, outDir: string, version: string): string[] {
  const written: string[] = [];
  for (const file of listFiles(root, USER_DOCS)) {
    const page = path.posix.relative(USER_DOCS, file);
    const destination = sitePath(page);
    mkdirSync(path.join(outDir, path.posix.dirname(destination)), { recursive: true });
    if (file.endsWith(".md")) {
      writeFileSync(
        path.join(outDir, destination),
        rewriteForSite(file, readFileSync(path.join(root, file), "utf8"), version),
      );
    } else {
      copyFileSync(path.join(root, file), path.join(outDir, destination));
    }
    written.push(destination);
  }
  const api = apiPages(path.join(root, API_OUT));
  for (const { page } of api) {
    const destination = path.posix.join(API_SITE_DIR, page);
    mkdirSync(path.join(outDir, path.posix.dirname(destination)), { recursive: true });
    copyFileSync(path.join(root, API_OUT, page), path.join(outDir, destination));
    written.push(destination);
  }
  writeFileSync(
    path.join(outDir, "llms.txt"),
    siteLlmsTxt(readFileSync(path.join(root, "llms.txt"), "utf8"), version, api),
  );
  written.push("llms.txt");
  return written;
}

/** A handle in its one-line form, for the codes whose details need one. */
const PROBE_HANDLE =
  "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000";

/** The export `name` of a loaded module, or undefined. */
function exportOf(module: unknown, name: string): unknown {
  return typeof module === "object" && module !== null ? Reflect.get(module, name) : undefined;
}

/**
 * The `docsUrl` of every code a loaded core module exports, read from an `ExplorerVerifyError` it
 * builds for the code. The details hold the fields some codes need (an empty `issues` list and a
 * handle), and the error keeps only the fields its code declares. Throws when the module lacks
 * `ERROR_CODES`, `ExplorerVerifyError` or `parseHandle`.
 */
export function docsUrlsOf(module: unknown, from: string): string[] {
  const ExplorerVerifyError = exportOf(module, "ExplorerVerifyError");
  const parseHandle = exportOf(module, "parseHandle");
  if (typeof ExplorerVerifyError !== "function" || typeof parseHandle !== "function") {
    throw new Error(`${from} exports no ExplorerVerifyError or parseHandle; run the build`);
  }
  const codes = errorCodesOf(module, from);
  const handle: unknown = Reflect.apply(parseHandle, undefined, [PROBE_HANDLE]);
  return codes.map((code) => {
    const error: unknown = Reflect.construct(ExplorerVerifyError, [
      { code, issues: [], handle },
      "docs URL probe",
      { secrets: [] },
    ]);
    const url: unknown =
      typeof error === "object" && error !== null ? Reflect.get(error, "docsUrl") : undefined;
    if (typeof url !== "string") {
      throw new Error(`${from}: the error for ${code} has no docsUrl`);
    }
    return url;
  });
}

/** The path under the site of a site URL, or undefined for a URL elsewhere. */
function sitePathOf(url: string, site: string): string | undefined {
  if (!url.startsWith(site)) {
    return undefined;
  }
  const rest = url.slice(site.length).replace(/[?#].*$/, "");
  return rest === "" || rest.endsWith("/") ? `${rest}index` : rest;
}

/**
 * Problems with a built site in `outDir` (decision 0015, test 3): each `docsUrl` must map to an
 * HTML page with its Markdown copy next to it; each link in the site's `llms.txt` must be a
 * Markdown copy in the build; and each HTML page other than `404.html` must have a Markdown copy
 * that `llms.txt` lists.
 */
export function siteProblems(outDir: string, docsUrls: readonly string[]): string[] {
  const problems: string[] = [];
  for (const url of docsUrls) {
    const page = sitePathOf(url, SITE_URL);
    if (page === undefined) {
      problems.push(`docsUrl ${url} is not on the docs site ${SITE_URL} (R-AX-10)`);
      continue;
    }
    for (const file of [`${page}.html`, `${page}.md`]) {
      if (!existsSync(path.join(outDir, file))) {
        problems.push(`docsUrl ${url}: the built site has no ${file} (R-AX-10)`);
      }
    }
  }
  const llms = path.join(outDir, "llms.txt");
  if (!existsSync(llms)) {
    return [
      ...problems,
      "the built site has no llms.txt; run node scripts/site-copies.ts (R-AX-17)",
    ];
  }
  const listed = new Set<string>();
  for (const { line, target } of markdownLinks(readFileSync(llms, "utf8"))) {
    const page = sitePathOf(target, SITE_URL);
    if (page === undefined || !page.endsWith(".md")) {
      problems.push(
        `llms.txt:${line}: link ${target} is not a Markdown copy on the site (R-AX-17)`,
      );
    } else if (existsSync(path.join(outDir, page))) {
      listed.add(page);
    } else {
      problems.push(`llms.txt:${line}: link ${target} names ${page}, which is not built (R-AX-17)`);
    }
  }
  for (const html of listFiles(outDir, ".", ".html")) {
    const file = path.posix.normalize(html);
    if (file === "404.html") {
      continue;
    }
    const copy = file.replace(/\.html$/, ".md");
    if (!existsSync(path.join(outDir, copy))) {
      problems.push(`${file} has no Markdown copy ${copy} (R-AX-17)`);
    } else if (!listed.has(copy)) {
      problems.push(`llms.txt does not list ${copy} (R-AX-17)`);
    }
  }
  return problems;
}

/** The `fetch` the smoke check calls; `globalThis.fetch` fits. */
export type Fetch = (
  url: string,
  init: { redirect: "follow"; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** How long the smoke check waits for one response, body included, in milliseconds. */
export const SMOKE_TIMEOUT_MS = 10_000;

/** The URL on the site at `site` of a URL on the docs site; other URLs stay. */
function onSite(url: string, site: string): string {
  return url.startsWith(SITE_URL) ? `${site}${url.slice(SITE_URL.length)}` : url;
}

/** Fetches `url` and returns its body when the status is 200, or the problem. */
async function get(fetchUrl: Fetch, url: string): Promise<{ body: string } | { problem: string }> {
  try {
    const response = await fetchUrl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    });
    return response.status === 200
      ? { body: await response.text() }
      : { problem: `${url}: status ${response.status}` };
  } catch (error) {
    return { problem: `${url}: ${String(error)}` };
  }
}

/**
 * Problems with the deployed site at `site` (decision 0015, test 4): each `docsUrl` with the base
 * swapped for `site`, its `.md` copy, the site's `llms.txt` and each link in it must return 200
 * within `SMOKE_TIMEOUT_MS`, and the `llms.txt` must name `version`, so an older deploy fails.
 */
export async function smokeProblems(
  site: string,
  version: string,
  docsUrls: readonly string[],
  fetchUrl: Fetch,
): Promise<string[]> {
  const problems: string[] = [];
  const urls = docsUrls.flatMap((url) => [onSite(url, site), `${onSite(url, site)}.md`]);
  const llmsUrl = `${site}llms.txt`;
  const llms = await get(fetchUrl, llmsUrl);
  if ("problem" in llms) {
    problems.push(llms.problem);
  } else {
    // The sentence opens its line, and a space or the line end follows it, so `1.2` does not match
    // a site that names `1.2.3`.
    const sentence = siteVersionText(version);
    if (
      !llms.body.split("\n").some((line) => line === sentence || line.startsWith(`${sentence} `))
    ) {
      problems.push(`${llmsUrl}: does not say "${siteVersionText(version)}"`);
    }
    urls.push(...markdownLinks(llms.body).map(({ target }) => onSite(target, site)));
  }
  for (const url of new Set(urls)) {
    const result = await get(fetchUrl, url);
    if ("problem" in result) {
      problems.push(result.problem);
    }
  }
  return problems;
}
