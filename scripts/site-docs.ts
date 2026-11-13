// The docs site (R-AX-17, decision 0015): the user docs built with VitePress, plus `llms.txt` and a
// Markdown copy of each page, served on GitHub Pages. Used by the VitePress config in
// site/.vitepress/config.ts, scripts/site-copies.ts, scripts/check-site.ts and
// scripts/smoke-site.ts.
//
// The site is the third link target of the docs, after GitHub and the npm package:
// - A page keeps its path under `docs/user/`, except `README.md`, which becomes `index.md`. When
//   the site has its own home page, `site/pages/index.md`, the top `README.md` becomes
//   `overview.md` instead. Any other file under `docs/user/`, such as an image or a JSON sample,
//   is served as it is, at the same path.
// - A link inside `docs/user/` stays relative. A link to the root `llms.txt` points to the site's
//   `llms.txt`. Any other link into the repository points to the file on GitHub at the version's
//   tag, because the site is built from that tag.
// - The HTML pages drop the `Version:` and `Agents:` lines of the page header, and the nav shows
//   the version. The Markdown copies keep both lines.
// - The site's `llms.txt` is the root one with only the user pages and the skill, each linked as
//   its Markdown copy on the site, plus a line that names the version and a section that lists the
//   pages of the API reference.
// - The API reference (scripts/site-api.ts) is generated into `site/api/` and served under `api/`.
// - A Markdown file in `site/pages/` is a site-only page, served at its path (decision 0062). It
//   may use frontmatter and Vue, and it has no Markdown copy.
// - The sidebar is one curated list of groups and pages (`SIDEBAR`). A page that does not exist
//   yet is skipped, and `sidebarProblems` reports a user page that is in no group or in two.
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
import { API_OUT, API_SITE_DIR, apiPages, isApiEntryPage } from "./site-api.ts";
import type { ApiPage } from "./site-api.ts";

/** The address of the docs site. Every `docsUrl` starts with it before 1.0. */
export const SITE_URL = "https://aelmanaa.github.io/explorer-verify/";
/** The site-level description: the home page's, and the fallback no other page may keep. */
export function siteDescription(version: string): string {
  return `Verify deployed contract source on block explorers. Docs of explorer-verify ${version}.`;
}
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

/** The folder of the site-only pages, relative to the repository root (decision 0062). */
export const SITE_PAGES = "site/pages";
/**
 * The folder whose files the build copies to the site root byte for byte, such as the Google
 * Search Console verification file. They are no pages: no layout, no link rewrite, no Markdown
 * copy and no sitemap entry.
 */
export const SITE_STATIC = "site/static";
/** The site path of `docs/user/README.md` when the site has its own home page. */
export const OVERVIEW = "overview.md";
/** The agent skill. The site serves a Markdown copy at the same path, and its `llms.txt` links it. */
export const SITE_SKILL = "skills/explorer-verify/SKILL.md";

/** The site-only pages: the Markdown files under `site/pages/`, relative to that folder. */
export function sitePages(root: string): string[] {
  return listFiles(root, SITE_PAGES, ".md").map((file) => path.posix.relative(SITE_PAGES, file));
}

/** The files of `site/static/`, by their path on the site. */
export function siteStaticFiles(root: string): string[] {
  return listFiles(root, SITE_STATIC).map((file) => path.posix.relative(SITE_STATIC, file));
}

/** Whether the site has its own home page, `site/pages/index.md`. */
export function hasSiteHome(root: string): boolean {
  return existsSync(path.join(root, SITE_PAGES, "index.md"));
}

/**
 * The files under `docs/user/` that are not pages, such as images and JSON samples, by their path
 * on the site, which is their path under `docs/user/`. The site serves each as it is.
 */
export function siteAssets(root: string): string[] {
  return listFiles(root, USER_DOCS)
    .filter((file) => !file.endsWith(".md"))
    .map((file) => path.posix.relative(USER_DOCS, file));
}

/**
 * The path on the site of a page under `docs/user/`: `README.md` becomes `index.md`. With `home`
 * set, the site has its own home page, and the top `README.md` becomes `overview.md`.
 */
export function sitePath(page: string, home = false): string {
  if (page === "README.md" && home) {
    return OVERVIEW;
  }
  return path.posix.basename(page) === "README.md"
    ? path.posix.join(path.posix.dirname(page), "index.md")
    : page;
}

/**
 * The VitePress `rewrites` map, from each page's path under the repository root, VitePress's
 * `srcDir`, to its path on the site: a page under `docs/user/` goes to the site root (`README.md`
 * as `index.md`, or as `overview.md` when the site has its own home page), a page of the API
 * reference in `site/api/` goes under `api/`, and a site-only page in `site/pages/` goes to its
 * path under that folder. Throws when two pages would get the same path.
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
  const home = hasSiteHome(root);
  for (const file of listFiles(root, USER_DOCS, ".md")) {
    add(file, sitePath(path.posix.relative(USER_DOCS, file), home));
  }
  for (const { page } of apiPages(path.join(root, API_OUT))) {
    add(path.posix.join(API_OUT, page), path.posix.join(API_SITE_DIR, page));
  }
  for (const page of sitePages(root)) {
    add(path.posix.join(SITE_PAGES, page), page);
  }
  return rewrites;
}

/**
 * The VitePress `srcExclude` patterns. VitePress reads the pages from the repository root, so it
 * sees `docs/user/`, the generated `site/api/` and the site-only `site/pages/`; these patterns
 * hide every other Markdown file: each top-level file, and each folder that holds none of the
 * three. Hidden entries are left out, because VitePress skips them already.
 */
export function siteSourceExcludes(root: string): string[] {
  const kept = [USER_DOCS, API_OUT, SITE_PAGES];
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
 * Rewrites the relative links of a user page, or of the skill, for the site. `file` is the
 * repository path of the page, under `docs/user/`, or `SITE_SKILL`; `version` is the version the
 * site is built from; and `home` says that the site has its own home page, which moves
 * `docs/user/README.md` to `overview.md`.
 */
export function rewriteForSite(file: string, text: string, version: string, home = false): string {
  const inDocs = file.startsWith(`${USER_DOCS}/`);
  const here = path.posix.dirname(inDocs ? path.posix.relative(USER_DOCS, file) : file);
  return rewriteLinks(text, (target) => {
    if (isExternalOrFragment(target)) {
      return target;
    }
    const { file: linked } = splitTarget(target);
    const rest = target.slice(linked.length);
    const relative = resolveLink(file, linked);
    if (relative.startsWith(`${USER_DOCS}/`)) {
      const page = path.posix.relative(USER_DOCS, relative);
      const moved = sitePath(page, home);
      return moved === page && inDocs ? target : `${path.posix.relative(here, moved)}${rest}`;
    }
    if (relative === "llms.txt") {
      return `${path.posix.relative(here, "llms.txt")}${rest}`;
    }
    return `${GITHUB_BLOB}v${version}/${relative}${rest}`;
  });
}

/** The header lines the HTML pages drop: the version line and the `llms.txt` line. */
const HEADER_LINE = /^(?:Version: explorer-verify |Agents: )/;

/**
 * A user page without the `Version:` and `Agents:` lines of its header, for the HTML site. Only
 * lines before the first H2 or code fence count, and the blank line after a dropped line goes
 * with it. The Markdown copies keep both lines.
 */
export function dropHeaderLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let header = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^(?:## |```|~~~)/.test(line)) {
      header = false;
    }
    if (header && HEADER_LINE.test(line)) {
      if (lines[index + 1] === "") {
        index += 1;
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * The title of a fenced code block, from its info string: `ts [verify.ts]` has the title
 * `verify.ts`. VitePress 1.6.4 reads the same brackets, but shows the title only inside a code
 * group, so the site config adds a title bar to a block outside one (`withCodeTitle`).
 */
export function codeTitleOf(info: string): string | undefined {
  const title = /\[(.*)\]/.exec(info)?.[1]?.trim();
  return title === undefined || title === "" ? undefined : title;
}

/**
 * Whether the token at `index` sits inside a VitePress code group, given the type of each token
 * of the page, as markdown-it names them.
 */
export function inCodeGroup(types: readonly string[], index: number): boolean {
  let depth = 0;
  for (const type of types.slice(0, index)) {
    if (type === "container_code-group_open") {
      depth += 1;
    } else if (type === "container_code-group_close") {
      depth -= 1;
    }
  }
  return depth > 0;
}

/**
 * The HTML of a rendered code block with a title bar above it. The title is HTML-escaped and
 * marked `v-pre`, so Vue shows `{{` in it as written.
 */
export function withCodeTitle(html: string, title: string): string {
  const escaped = title
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<div class="ev-code-title"><div class="ev-code-title-text" v-pre>${escaped}</div>${html}</div>`;
}

/** The H2 section of the site's `llms.txt` that lists the pages of the API reference. */
export const API_SECTION = "## API reference";

/**
 * The site's `llms.txt`, from the root one: links to user pages and to the skill point to their
 * Markdown copies on the site, list items that link anything else are dropped, and so are sections
 * left empty. A line after the summary names the version and where the docs of other versions
 * are. When `api` lists pages of the API reference, a last section links their Markdown copies:
 * the index and the page of each entry point, with the pages of its members nested under it.
 * With `home` set, the site has its own home page, and the user index is `overview.md`.
 */
export function siteLlmsTxt(
  text: string,
  version: string,
  api: readonly ApiPage[] = [],
  home = false,
): string {
  const userDocs = `${RAW_MAIN}${USER_DOCS}/`;
  const skill = `${RAW_MAIN}${SITE_SKILL}`;
  const copied = (target: string): boolean =>
    target.startsWith(userDocs) || target === skill || target.startsWith(`${skill}#`);
  const kept: string[] = [];
  let dropping = false;
  for (const line of text.split("\n")) {
    if (dropping && /^\s+\S/.test(line)) {
      continue;
    }
    dropping = false;
    if (/^\s*[-*] /.test(line)) {
      const targets = markdownLinks(line).map(({ target }) => target);
      if (targets.length === 0 || !targets.every(copied)) {
        dropping = true;
        continue;
      }
      kept.push(
        line
          .replaceAll(
            new RegExp(`${escapeRegExp(userDocs)}([^)>\\s]+)`, "g"),
            (_whole, page: string) => `${SITE_URL}${sitePath(page, home)}`,
          )
          .replaceAll(skill, `${SITE_URL}${SITE_SKILL}`),
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
      ...api.map(({ page, title }) => {
        const link = `[${title}](${SITE_URL}${API_SITE_DIR}/${page})`;
        if (page === "index.md") {
          return `- ${link}: the list of entry points`;
        }
        return isApiEntryPage(page) ? `- ${link}: the exports of \`${title}\`` : `  - ${link}`;
      }),
      "",
    );
  }
  return lines.join("\n");
}

/** `text` with every character a regular expression treats as special escaped. */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
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

/** One item of the site's sidebar: a page, or a group of items. */
export interface SidebarItem {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
}

/**
 * One entry of the curated sidebar: a page under `docs/user/` with its label, a group of entries,
 * or a group that lists every page of a folder, its `index.md` first, each under its first heading.
 */
export type SidebarEntry =
  | { readonly text: string; readonly page: string }
  | { readonly text: string; readonly collapsed: boolean; readonly items: readonly SidebarEntry[] }
  | { readonly text: string; readonly collapsed: boolean; readonly folder: string };

/** The text of the generated API reference group, the last group of the sidebar. */
export const API_GROUP = "API";

/**
 * The sidebar, in order (#307, audit finding F4). Each page is listed by its path under
 * `docs/user/`, with a short label. A page that does not exist yet is skipped, so a pull request
 * that adds a planned page needs no change here. A user page that is in no entry, or in two,
 * fails `sidebarProblems`.
 */
export const SIDEBAR: readonly SidebarEntry[] = [
  {
    text: "Get started",
    collapsed: false,
    items: [
      { text: "Overview", page: "README.md" },
      { text: "Which package", page: "start/which-package.md" },
      {
        text: "Quickstarts",
        collapsed: false,
        items: [
          { text: "All quickstarts", page: "start/README.md" },
          { text: "Browser dapp", page: "start/quickstart-browser.md" },
          { text: "Node.js", page: "start/quickstart-node.md" },
          { text: "CLI", page: "start/quickstart-cli.md" },
          { text: "Foundry", page: "start/quickstart-foundry.md" },
          { text: "Hardhat", page: "start/quickstart-hardhat.md" },
          { text: "SDK wrapper", page: "start/quickstart-sdk-wrapper.md" },
          { text: "AI agent", page: "start/quickstart-agent.md" },
        ],
      },
      { text: "Tutorial: verify from a dapp", page: "tutorials/verify-from-a-dapp.md" },
      { text: "Tutorial: deploy and verify", page: "tutorials/deploy-and-verify-from-a-dapp.md" },
    ],
  },
  {
    text: "Guides by setup",
    collapsed: false,
    items: [
      { text: "Node.js", page: "guides/verify-from-node.md" },
      { text: "Browser", page: "guides/verify-from-a-browser.md" },
      { text: "Edge function", page: "guides/verify-from-an-edge-function.md" },
      { text: "CI with the CLI", page: "guides/verify-from-ci-with-the-cli.md" },
      { text: "Foundry project", page: "guides/verify-from-a-foundry-project.md" },
      { text: "Hardhat project", page: "guides/verify-from-a-hardhat-project.md" },
      { text: "Server handler", page: "guides/run-the-server-handler.md" },
    ],
  },
  {
    text: "Guides by task",
    collapsed: false,
    items: [
      { text: "Proxy", page: "guides/verify-a-proxy.md" },
      { text: "From deployed bytecode", page: "guides/verify-from-deployed-bytecode.md" },
      { text: "From an npm package", page: "guides/verify-a-contract-from-an-npm-package.md" },
      {
        text: "Contracts your package ships",
        page: "guides/verify-contracts-your-package-ships.md",
      },
      {
        text: "A package that ships only sources",
        page: "guides/verify-contracts-from-a-package-that-ships-only-sources.md",
      },
    ],
  },
  {
    text: "Advanced",
    collapsed: false,
    items: [
      { text: "Wrap in your tool", page: "guides/wrap-explorer-verify-in-your-tool.md" },
      { text: "From an agent", page: "guides/using-from-an-agent.md" },
      { text: "Core entry", page: "reference/core.md" },
      { text: "Bundle size", page: "advanced/bundle-size.md" },
      { text: "Several explorers", page: "advanced/verify-on-several-explorers.md" },
      { text: "Abort and resume", page: "advanced/abort-and-resume.md" },
      { text: "Resume from a job queue", page: "advanced/resume-from-a-job-queue.md" },
      { text: "Logging and events", page: "reference/logging-and-events.md" },
    ],
  },
  {
    text: "Reference",
    collapsed: false,
    items: [
      { text: "verify()", page: "reference/verify.md" },
      { text: "checkStatus()", page: "reference/check-status.md" },
      { text: "CLI", page: "reference/cli.md" },
      { text: "CLI output", page: "reference/cli-output.md" },
      { text: "JSON output and exit codes", page: "reference/json-output.md" },
      { text: "API keys", page: "reference/api-keys.md" },
      { text: "Routing", page: "reference/routing.md" },
      { text: "Server handler", page: "reference/server-handler.md" },
      {
        text: "Explorers",
        collapsed: true,
        items: [
          { text: "Sourcify", page: "reference/sourcify.md" },
          { text: "Etherscan", page: "reference/etherscan.md" },
          { text: "Routescan", page: "reference/routescan.md" },
          { text: "Blockscout", page: "reference/blockscout.md" },
          { text: "Etherscan-compatible", page: "reference/etherscan-compatible.md" },
        ],
      },
      { text: "Errors", collapsed: true, folder: "reference/errors" },
    ],
  },
  {
    text: "Concepts",
    collapsed: false,
    items: [
      { text: "Match types", page: "explanation/match-types.md" },
      { text: "Etherscan plans", page: "explanation/etherscan-plans-and-attribution.md" },
      { text: "Glossary", page: "explanation/glossary.md" },
    ],
  },
];

/** The site link of a site path: no `.md`, and a folder index as the folder. */
function siteLink(sitePage: string): string {
  const link = `/${sitePage.replace(/\.md$/, "")}`;
  return link.endsWith("/index") ? link.slice(0, -"index".length) : link;
}

/** The pages under `docs/user/` that each entry lists, by their path under that folder. */
function entryPages(entry: SidebarEntry, pages: readonly string[]): string[] {
  if ("page" in entry) {
    return pages.includes(entry.page) ? [entry.page] : [];
  }
  if ("items" in entry) {
    return entry.items.flatMap((item) => entryPages(item, pages));
  }
  return pages
    .filter((page) => page.startsWith(`${entry.folder}/`))
    .toSorted((a, b) => Number(b.endsWith("/index.md")) - Number(a.endsWith("/index.md")));
}

/** The sidebar item of an entry, or undefined when none of its pages exists yet. */
function sidebarItem(
  root: string,
  entry: SidebarEntry,
  pages: readonly string[],
  home: boolean,
): SidebarItem | undefined {
  if ("page" in entry) {
    return pages.includes(entry.page)
      ? { text: entry.text, link: siteLink(sitePath(entry.page, home)) }
      : undefined;
  }
  const items =
    "items" in entry
      ? entry.items.flatMap((item) => sidebarItem(root, item, pages, home) ?? [])
      : entryPages(entry, pages).map((page) => ({
          text: headings(readFileSync(path.join(root, USER_DOCS, page), "utf8"))[0] ?? page,
          link: siteLink(sitePath(page, home)),
        }));
  return items.length > 0 ? { text: entry.text, collapsed: entry.collapsed, items } : undefined;
}

/**
 * The sidebar: the groups of `SIDEBAR` with the pages that exist, then the generated API
 * reference, collapsed, once `site/api/` holds pages: its index and the page of each entry point.
 * The page of an entry point links the pages of its members.
 */
export function siteSidebar(root: string): SidebarItem[] {
  const pages = listFiles(root, USER_DOCS, ".md").map((file) =>
    path.posix.relative(USER_DOCS, file),
  );
  const home = hasSiteHome(root);
  const groups = SIDEBAR.flatMap((entry) => sidebarItem(root, entry, pages, home) ?? []);
  const api = apiPages(path.join(root, API_OUT)).filter(({ page }) => isApiEntryPage(page));
  if (api.length > 0) {
    groups.push({
      text: API_GROUP,
      collapsed: true,
      items: api.map(({ page, title }) => ({
        text: title,
        link: siteLink(path.posix.join(API_SITE_DIR, page)),
      })),
    });
  }
  return groups;
}

/**
 * Problems with the sidebar: a user page that no entry of `entries`, by default `SIDEBAR`, lists,
 * or that two entries list. A page entry for a page that does not exist yet is no problem.
 */
export function sidebarProblems(
  root: string,
  entries: readonly SidebarEntry[] = SIDEBAR,
): string[] {
  const pages = listFiles(root, USER_DOCS, ".md").map((file) =>
    path.posix.relative(USER_DOCS, file),
  );
  const listed = entries.flatMap((entry) => entryPages(entry, pages));
  const problems: string[] = [];
  for (const page of pages) {
    const count = listed.filter((other) => other === page).length;
    if (count === 0) {
      problems.push(
        `${USER_DOCS}/${page} is in no sidebar group; add it to SIDEBAR in scripts/site-docs.ts`,
      );
    } else if (count > 1) {
      problems.push(`${USER_DOCS}/${page} is in ${count} sidebar entries; keep one`);
    }
  }
  return problems;
}

/** The first link of a sidebar item, depth first. */
function firstLink(item: SidebarItem): string | undefined {
  return item.link ?? item.items?.map(firstLink).find((link) => link !== undefined);
}

/** One item of the site's nav bar: a link, or a menu of links. */
export type NavItem =
  | { text: string; link: string }
  | { text: string; items: { text: string; link: string }[] };

/** The nav entries: their text, and the sidebar group whose first page each links. */
const NAV: readonly { text: string; group: string }[] = [
  { text: "Get started", group: "Get started" },
  { text: "Guides", group: "Guides by setup" },
  { text: "Reference", group: "Reference" },
  { text: "API", group: API_GROUP },
];

/**
 * The nav bar: Get started, Guides, Reference and API, each linking the first page of its sidebar
 * group and skipped while the group is empty, then a menu named after the version with the
 * changelog at the release tag and the package on npm.
 */
export function siteNav(sidebar: readonly SidebarItem[], version: string): NavItem[] {
  const nav: NavItem[] = NAV.flatMap(({ text, group }) => {
    const item = sidebar.find((candidate) => candidate.text === group);
    const link = item === undefined ? undefined : firstLink(item);
    return link === undefined ? [] : [{ text, link }];
  });
  nav.push({
    text: version,
    items: [
      {
        text: "Changelog",
        link: `${GITHUB_BLOB}v${version}/packages/explorer-verify/CHANGELOG.md`,
      },
      { text: "npm", link: `https://www.npmjs.com/package/explorer-verify/v/${version}` },
    ],
  });
  return nav;
}

/**
 * Writes the Markdown copy of every user page next to its HTML in `outDir`, with its links
 * rewritten for the site, copies every other file under `docs/user/` as is, writes the copy of the
 * skill, copies each page of the API reference to `api/`, its links being relative already, and
 * writes the site's `llms.txt`. It also copies each file of `site/static/` to the site root as it
 * is. Returns the paths written, relative to `outDir`.
 */
export function writeSiteCopies(root: string, outDir: string, version: string): string[] {
  const written: string[] = [];
  const home = hasSiteHome(root);
  const writeCopy = (file: string, destination: string): void => {
    mkdirSync(path.join(outDir, path.posix.dirname(destination)), { recursive: true });
    writeFileSync(
      path.join(outDir, destination),
      rewriteForSite(file, readFileSync(path.join(root, file), "utf8"), version, home),
    );
    written.push(destination);
  };
  for (const file of listFiles(root, USER_DOCS)) {
    const page = path.posix.relative(USER_DOCS, file);
    if (file.endsWith(".md")) {
      writeCopy(file, sitePath(page, home));
    } else {
      mkdirSync(path.join(outDir, path.posix.dirname(page)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(outDir, page));
      written.push(page);
    }
  }
  if (existsSync(path.join(root, SITE_SKILL))) {
    writeCopy(SITE_SKILL, SITE_SKILL);
  }
  const api = apiPages(path.join(root, API_OUT));
  for (const { page } of api) {
    const destination = path.posix.join(API_SITE_DIR, page);
    mkdirSync(path.join(outDir, path.posix.dirname(destination)), { recursive: true });
    copyFileSync(path.join(root, API_OUT, page), path.join(outDir, destination));
    written.push(destination);
  }
  for (const file of siteStaticFiles(root)) {
    mkdirSync(path.join(outDir, path.posix.dirname(file)), { recursive: true });
    copyFileSync(path.join(root, SITE_STATIC, file), path.join(outDir, file));
    written.push(file);
  }
  writeFileSync(
    path.join(outDir, "llms.txt"),
    siteLlmsTxt(readFileSync(path.join(root, "llms.txt"), "utf8"), version, api, home),
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
 * Markdown copy in the build; each HTML page other than `404.html` and the site-only pages must
 * have a Markdown copy that `llms.txt` lists; and each file of `assets` must be in the build.
 * `siteOnly` and `assets` are site paths, as `sitePages` and `siteAssets` give them. Each file of
 * `staticFiles`, a site path as `siteStaticFiles` gives it, must be in the build and is no page.
 */
export function siteProblems(
  outDir: string,
  docsUrls: readonly string[],
  {
    siteOnly = [],
    assets = [],
    staticFiles = [],
  }: {
    siteOnly?: readonly string[];
    assets?: readonly string[];
    staticFiles?: readonly string[];
  } = {},
): string[] {
  const problems: string[] = [];
  for (const asset of assets) {
    if (!existsSync(path.join(outDir, asset))) {
      problems.push(`the built site has no ${asset}, a file under ${USER_DOCS}/ (R-AX-17)`);
    }
  }
  for (const file of staticFiles) {
    if (!existsSync(path.join(outDir, file))) {
      problems.push(`the built site has no ${file}, a file under ${SITE_STATIC}/ (R-AX-17)`);
    }
  }
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
    const copy = file.replace(/\.html$/, ".md");
    if (file === "404.html" || siteOnly.includes(copy) || staticFiles.includes(file)) {
      continue;
    }
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
 * Each file of `assets`, a site path as `siteAssets` gives it, must return 200 too, and a `.json`
 * file must parse as JSON, so the site serves it as it is and not as a page. The sitemap must
 * return 200 and list the home page (R-AX-17). Each file of `search.files`, such as the Google
 * verification file, must return 200 with that content, and the home page must hold each meta tag
 * of `search.homeMeta` whose token is set.
 */
export async function smokeProblems(
  site: string,
  version: string,
  docsUrls: readonly string[],
  fetchUrl: Fetch,
  assets: readonly string[] = [],
  search: {
    files?: Readonly<Record<string, string>>;
    homeMeta?: Readonly<Record<string, string>>;
  } = {},
): Promise<string[]> {
  const problems: string[] = [];
  for (const asset of assets) {
    const url = `${site}${asset}`;
    const result = await get(fetchUrl, url);
    if ("problem" in result) {
      problems.push(result.problem);
    } else if (asset.endsWith(".json")) {
      try {
        JSON.parse(result.body);
      } catch {
        problems.push(`${url}: the body is not JSON`);
      }
    }
  }
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
  const sitemap = await get(fetchUrl, `${site}sitemap.xml`);
  if ("problem" in sitemap) {
    problems.push(sitemap.problem);
  } else if (!sitemap.body.includes(`<loc>${SITE_URL}</loc>`)) {
    problems.push(`${site}sitemap.xml: does not list ${SITE_URL}`);
  }
  for (const [file, content] of Object.entries(search.files ?? {})) {
    const result = await get(fetchUrl, `${site}${file}`);
    if ("problem" in result) {
      problems.push(result.problem);
    } else if (result.body.trimEnd() !== content.trimEnd()) {
      problems.push(`${site}${file}: the body is not "${content.trimEnd()}"`);
    }
  }
  const tags = Object.entries(search.homeMeta ?? {}).filter(([, token]) => token !== "");
  if (tags.length > 0) {
    const home = await get(fetchUrl, site);
    for (const [name, token] of tags) {
      if ("problem" in home) {
        problems.push(home.problem);
        break;
      }
      if (!home.body.includes(`<meta name="${name}" content="${token}">`)) {
        problems.push(`${site}: has no <meta name="${name}"> with the expected token`);
      }
    }
  }
  return problems;
}
