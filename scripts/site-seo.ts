// What the docs site tells search engines (R-AX-17, issues #366 and #367): the canonical URL of
// each page, its Open Graph and Twitter tags, the JSON-LD block of the home page, the search
// console verification tags and files, the `lastmod` of each sitemap URL, and the check of all of
// it on a built site. Used by site/.vitepress/config.ts, scripts/check-site.ts and
// scripts/smoke-site.ts.
//
// - Each page except the 404 page has one canonical link: the absolute URL under the site's base,
//   without `.html`, the same URL the sitemap lists. `og:url` repeats it.
// - Each page has its own title and its own description of 40 to 160 characters. A user page's
//   description is in `PAGE_DESCRIPTIONS` (scripts/site-descriptions.ts), because the pages in
//   `docs/user/` hold no frontmatter (decision 0015). An API page's description comes from its
//   TSDoc summary (site/api-reference.ts). The home page sets its own in its frontmatter.
// - The home page has a `SoftwareSourceCode` JSON-LD block, with the version, description,
//   license and repository read from the core package's manifest at build time.
// - `site/verification.json` holds the search console tokens. An empty value emits no tag. The
//   files in `site/static/` are copied to the site root as they are, such as the Google
//   verification file.
// - The sitemap's `lastmod` of a page is the date of the last commit that changed its source
//   other than its `Version:` line. A shallow clone, or a page with no history, gets none.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { listFiles, PACKAGE_DIR } from "./agent-docs.ts";
import { SITE_STATIC, SITE_URL } from "./site-docs.ts";

/** The site's name: the suffix of every title and `og:site_name`. */
export const SITE_NAME = "explorer-verify";
/** The suffix VitePress adds to every page title. */
export const TITLE_SUFFIX: string = ` | ${SITE_NAME}`;
/** The longest title before the suffix (the hardhat-kms convention; Google sets no limit). */
export const TITLE_MAX = 60;
/** The shortest page description. */
export const DESCRIPTION_MIN = 40;
/** The longest page description. */
export const DESCRIPTION_MAX = 160;
/** The search console tokens, relative to the repository root. */
export const VERIFICATION_FILE = "site/verification.json";

/**
 * The canonical URL of a page, from its path on the site (`guides/x.md`, `index.md` or
 * `api/x/index.md`): absolute, under the base, without `.md` or `.html`, and a folder's index as
 * the folder. VitePress builds the sitemap's URLs by the same rule.
 */
export function canonicalUrl(page: string): string {
  return `${SITE_URL}${page.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
}

/** The search console tokens: each is the `content` of its meta tag, empty for none. */
export interface Verification {
  /** Google Search Console, `<meta name="google-site-verification">`. */
  google: string;
  /** Bing Webmaster Tools, `<meta name="msvalidate.01">`. */
  bing: string;
  /** The Google verification file in `site/static/`, served at the site root, or empty. */
  googleFile: string;
}

/** A token is letters, digits, `_` and `-`; a file name adds `.`. */
const TOKEN = /^[\w-]*$/;
const FILE_NAME = /^(?:[\w-]+\.html)?$/;

/**
 * The search console tokens in `site/verification.json`. Throws when the file is missing, a field
 * is not a string, or a value holds a character a token or file name never has.
 */
export function readVerification(root: string): Verification {
  const parsed: unknown = JSON.parse(readFileSync(path.join(root, VERIFICATION_FILE), "utf8"));
  const read = (name: keyof Verification, pattern: RegExp): string => {
    const value: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, name) : undefined;
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error(`${VERIFICATION_FILE}: ${name} must be a token string, empty for none`);
    }
    return value;
  };
  return {
    google: read("google", TOKEN),
    bing: read("bing", TOKEN),
    googleFile: read("googleFile", FILE_NAME),
  };
}

/** The exact content of a Google verification file, as Google serves it for download. */
export function googleFileContent(file: string): string {
  return `google-site-verification: ${file}\n`;
}

/** The verification files the site serves, by path, with their exact content. */
export function verificationFiles(verification: Verification): Record<string, string> {
  const { googleFile } = verification;
  return googleFile === "" ? {} : { [googleFile]: googleFileContent(googleFile) };
}

/** The home page's search console meta tags, by `name`, with their token; empty for none. */
export function verificationTags(verification: Verification): Record<string, string> {
  return { "google-site-verification": verification.google, "msvalidate.01": verification.bing };
}

/** The facts of the core package that the home page's JSON-LD carries. */
export interface PackageFacts {
  name: string;
  version: string;
  description: string;
  license: string;
  /** The repository on GitHub, as an `https` URL without `git+` or `.git`. */
  repository: string;
}

/** A string field of a parsed JSON value, or a nested one by path. */
function stringAt(value: unknown, ...keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    current =
      typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return typeof current === "string" ? current : undefined;
}

/** The core package's facts, from its `package.json`. Throws when one is missing. */
export function packageFacts(root: string): PackageFacts {
  const file = path.posix.join(PACKAGE_DIR, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const fact = (...keys: string[]): string => {
    const value = stringAt(manifest, ...keys);
    if (value === undefined) {
      throw new Error(`${file} has no ${keys.join(".")}`);
    }
    return value;
  };
  return {
    name: fact("name"),
    version: fact("version"),
    description: fact("description"),
    license: fact("license"),
    repository: fact("repository", "url")
      .replace(/^git\+/, "")
      .replace(/\.git$/, ""),
  };
}

/** The home page's JSON-LD: a schema.org `SoftwareSourceCode`, no rating or offer. */
export function softwareSourceCode(facts: PackageFacts): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: facts.name,
    description: facts.description,
    url: SITE_URL,
    codeRepository: facts.repository,
    programmingLanguage: "TypeScript",
    runtimePlatform: ["Node.js", "Web browsers", "Edge runtimes"],
    license: `https://spdx.org/licenses/${facts.license}.html`,
    version: facts.version,
  };
}

/** A head tag as VitePress takes it: the tag, its attributes and, for a script, its content. */
export type HeadTag = [string, Record<string, string>] | [string, Record<string, string>, string];

/** What `searchHead` needs to know about one page. */
export interface HeadInput {
  /** The page's path on the site, such as `guides/x.md`; `404.md` for the 404 page. */
  page: string;
  /** The page's `<title>`. */
  title: string;
  /** The page's meta description. */
  description: string;
  facts: PackageFacts;
  verification: Verification;
}

/**
 * The head tags of one page: the canonical link, Open Graph and Twitter tags, and, on the home
 * page, the JSON-LD block and the search console tags whose value is set. The 404 page gets none.
 */
export function searchHead({
  page,
  title,
  description,
  facts,
  verification,
}: HeadInput): HeadTag[] {
  if (page === "404.md") {
    return [];
  }
  const url = canonicalUrl(page);
  const tags: HeadTag[] = [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: SITE_NAME }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:url", content: url }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ];
  if (page === "index.md") {
    if (verification.google !== "") {
      tags.push(["meta", { name: "google-site-verification", content: verification.google }]);
    }
    if (verification.bing !== "") {
      tags.push(["meta", { name: "msvalidate.01", content: verification.bing }]);
    }
    // An escaped `<` cannot close the script early, and JSON.parse reads the escape back as `<`.
    const json = JSON.stringify(softwareSourceCode(facts)).replaceAll("<", "\\u003c");
    tags.push(["script", { type: "application/ld+json" }, json]);
  }
  return tags;
}

/** A changed line that only sets the page's version, which every release rewrites. */
const VERSION_LINE = /^[+-]Version: explorer-verify /;

/**
 * The last significant change of each file, from the output of
 * `git log --format=%x00%cI -p -U0 --no-renames`, newest commit first: the commit date of the
 * newest commit whose diff of the file changes a line other than its `Version:` line. A file
 * whose every change is a version line is left out.
 */
export function lastModifiedFromLog(log: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const entry of log.split("\0").slice(1)) {
    const [date = "", ...lines] = entry.split("\n");
    let file: string | undefined;
    const significant = new Set<string>();
    for (const line of lines) {
      const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
      if (header !== null) {
        file = header[1];
        continue;
      }
      if (
        file === undefined ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        !/^[+-]/.test(line) ||
        VERSION_LINE.test(line)
      ) {
        continue;
      }
      significant.add(file);
    }
    for (const changed of significant) {
      if (!dates.has(changed)) {
        dates.set(changed, date.trim());
      }
    }
  }
  return dates;
}

/** Runs git in `root`; undefined when git fails. */
function gitOutput(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * The last significant change of each file under `paths`, by its path from the repository root
 * (`lastModifiedFromLog`). Undefined when `root` is not a git checkout or is a shallow clone, where
 * the history is cut and every date would be the clone's: the sitemap then has no `lastmod`.
 */
export function gitLastModified(
  root: string,
  paths: readonly string[],
): Map<string, string> | undefined {
  if (gitOutput(root, ["rev-parse", "--is-shallow-repository"])?.trim() !== "false") {
    return undefined;
  }
  const log = gitOutput(root, [
    "log",
    "--first-parent",
    "--format=%x00%cI",
    "-p",
    "-U0",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    "--",
    ...paths,
  ]);
  return log === undefined ? undefined : lastModifiedFromLog(log);
}

/** The text of an HTML attribute or element with the common entities decoded. */
function decode(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The attributes of one HTML tag, by name. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    found.set(String(match[1]), decode(String(match[2])));
  }
  return found;
}

/** What the check reads from the head of one built page. */
export interface PageHead {
  titles: string[];
  descriptions: string[];
  canonicals: string[];
  /** The `content` of each meta tag, by its `name` or `property`. */
  meta: Map<string, string[]>;
  /** The content of each `application/ld+json` script. */
  jsonLd: string[];
}

/** Reads the head of a built HTML page. */
export function readHead(html: string): PageHead {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
  const meta = new Map<string, string[]>();
  const canonicals: string[] = [];
  for (const [tag] of head.matchAll(/<meta\s(?:[^>"]|"[^"]*")*>/g)) {
    const attrs = attributes(tag);
    const key = attrs.get("name") ?? attrs.get("property");
    if (key !== undefined) {
      meta.set(key, [...(meta.get(key) ?? []), attrs.get("content") ?? ""]);
    }
  }
  for (const [tag] of head.matchAll(/<link\s(?:[^>"]|"[^"]*")*>/g)) {
    const attrs = attributes(tag);
    if (attrs.get("rel") === "canonical") {
      canonicals.push(attrs.get("href") ?? "");
    }
  }
  return {
    titles: [...head.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((match) =>
      decode(String(match[1])),
    ),
    descriptions: meta.get("description") ?? [],
    canonicals,
    meta,
    jsonLd: [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
      (match) => String(match[1]),
    ),
  };
}

/** The `<loc>` URLs of a sitemap. */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => decode(String(match[1])));
}

/** The built HTML file of a URL on the site: `index.html` for a folder, `<path>.html` otherwise. */
function builtFileOf(url: string): string {
  const rest = url.slice(SITE_URL.length);
  return rest === "" || rest.endsWith("/") ? `${rest}index.html` : `${rest}.html`;
}

/** What `searchProblems` checks a built site against. */
export interface SearchExpectations {
  /** The core package's version, which the home page's JSON-LD must name. */
  version: string;
  /** The site-level description, which only the home page may use. */
  siteDescription: string;
  verification: Verification;
  /** The files of `site/static/`, which are no pages, by their path on the site. */
  staticFiles?: readonly string[];
}

/** Each value of `values` that more than one page has, with those pages. */
function duplicates(values: ReadonlyMap<string, string>): Map<string, string[]> {
  const pages = new Map<string, string[]>();
  for (const [page, value] of values) {
    pages.set(value, [...(pages.get(value) ?? []), page]);
  }
  return new Map([...pages].filter(([, list]) => list.length > 1));
}

/**
 * Problems with what a built site in `outDir` tells search engines (R-AX-17, issues #366 and
 * #367). The sitemap must exist and list every page other than `404.html` and the static files,
 * by an absolute URL under the site that names a built page and does not end in `.html`. Each
 * page needs exactly one title, unique, at most `TITLE_MAX` characters before the suffix; one
 * description, unique, `DESCRIPTION_MIN` to `DESCRIPTION_MAX` characters and not the site's own
 * (home page aside); exactly one canonical link equal to its sitemap URL; and `og:title`,
 * `og:description` and an `og:url` equal to the canonical. The home page needs a parsable
 * `SoftwareSourceCode` JSON-LD block naming `version`, and the search console tags whose token is
 * set. The Google verification file must be built with its exact content. A `robots.txt` fails:
 * crawlers read it at the host root only.
 */
export function searchProblems(outDir: string, expected: SearchExpectations): string[] {
  const problems: string[] = [];
  const staticFiles = expected.staticFiles ?? [];
  if (existsSync(path.join(outDir, "robots.txt"))) {
    problems.push(
      "the built site has robots.txt; crawlers read it only at the host root, so submit the sitemap in each console instead (R-AX-17)",
    );
  }
  const pages = listFiles(outDir, ".", ".html")
    .map((file) => path.posix.normalize(file))
    .filter((file) => file !== "404.html" && !staticFiles.includes(file))
    .toSorted();

  const sitemap = path.join(outDir, "sitemap.xml");
  const listed = new Map<string, string>();
  if (existsSync(sitemap)) {
    for (const url of sitemapUrls(readFileSync(sitemap, "utf8"))) {
      if (!url.startsWith(SITE_URL)) {
        problems.push(
          `sitemap.xml lists ${url}, which is not an absolute URL under ${SITE_URL} (R-AX-17)`,
        );
      } else if (url.endsWith(".html")) {
        problems.push(`sitemap.xml lists ${url}, which ends in .html (R-AX-17)`);
      } else if (pages.includes(builtFileOf(url))) {
        listed.set(builtFileOf(url), url);
      } else {
        problems.push(`sitemap.xml lists ${url}, which is not a built page (R-AX-17)`);
      }
    }
  } else {
    problems.push(
      "the built site has no sitemap.xml; set sitemap.hostname in the site config (R-AX-17)",
    );
  }

  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const page of pages) {
    const head = readHead(readFileSync(path.join(outDir, page), "utf8"));
    const url = listed.get(page);
    if (url === undefined && existsSync(sitemap)) {
      problems.push(`${page}: sitemap.xml does not list it (R-AX-17)`);
    }
    const [title] = head.titles;
    if (head.titles.length !== 1 || title === undefined || title === "") {
      problems.push(`${page}: has ${head.titles.length} titles; give it one (R-AX-17)`);
    } else {
      titles.set(page, title);
      const bare = title.endsWith(TITLE_SUFFIX) ? title.slice(0, -TITLE_SUFFIX.length) : title;
      if (bare.length > TITLE_MAX) {
        problems.push(
          `${page}: the title "${bare}" is longer than ${TITLE_MAX} characters (R-AX-17)`,
        );
      }
    }
    const [description] = head.descriptions;
    if (head.descriptions.length !== 1 || description === undefined || description === "") {
      problems.push(`${page}: has ${head.descriptions.length} descriptions; give it one (R-AX-17)`);
    } else {
      descriptions.set(page, description);
      if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
        problems.push(
          `${page}: the description has ${description.length} characters; keep it between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} (R-AX-17)`,
        );
      }
      if (page !== "index.html" && description === expected.siteDescription) {
        problems.push(
          `${page}: the description is the site's own; give the page its own (R-AX-17)`,
        );
      }
    }
    const [canonical] = head.canonicals;
    if (head.canonicals.length !== 1 || canonical === undefined) {
      problems.push(
        `${page}: has ${head.canonicals.length} canonical links; give it one (R-AX-17)`,
      );
    } else if (url !== undefined && canonical !== url) {
      problems.push(
        `${page}: the canonical link ${canonical} is not its sitemap URL ${url} (R-AX-17)`,
      );
    }
    for (const property of ["og:title", "og:description", "og:url"]) {
      if ((head.meta.get(property) ?? []).length !== 1) {
        problems.push(`${page}: needs one ${property} tag (R-AX-17)`);
      }
    }
    const [ogUrl] = head.meta.get("og:url") ?? [];
    if (ogUrl !== undefined && canonical !== undefined && ogUrl !== canonical) {
      problems.push(`${page}: og:url ${ogUrl} is not its canonical URL ${canonical} (R-AX-17)`);
    }
    if (page === "index.html") {
      problems.push(...homeProblems(head, expected));
    }
  }
  if (!pages.includes("index.html")) {
    problems.push("the built site has no index.html (R-AX-17)");
  }
  for (const [title, list] of duplicates(titles)) {
    problems.push(`${list.join(", ")}: share the title "${title}"; give each its own (R-AX-17)`);
  }
  for (const [description, list] of duplicates(descriptions)) {
    problems.push(
      `${list.join(", ")}: share the description "${description}"; give each its own (R-AX-17)`,
    );
  }
  const { googleFile } = expected.verification;
  if (googleFile !== "") {
    const file = path.join(outDir, googleFile);
    if (!existsSync(file)) {
      problems.push(
        `the built site has no ${googleFile}, the Google verification file; keep it in ${SITE_STATIC}/ (R-AX-17)`,
      );
    } else if (readFileSync(file, "utf8").trimEnd() !== googleFileContent(googleFile).trimEnd()) {
      problems.push(
        `${googleFile}: the content is not "${googleFileContent(googleFile).trimEnd()}" (R-AX-17)`,
      );
    }
  }
  return problems;
}

/** Problems with the home page's JSON-LD and search console tags. */
function homeProblems(head: PageHead, expected: SearchExpectations): string[] {
  const problems: string[] = [];
  const [json] = head.jsonLd;
  if (head.jsonLd.length !== 1 || json === undefined) {
    problems.push(`index.html: has ${head.jsonLd.length} JSON-LD blocks; give it one (R-AX-17)`);
  } else {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      problems.push("index.html: the JSON-LD block is not JSON (R-AX-17)");
    }
    if (data !== undefined) {
      if (stringAt(data, "@type") !== "SoftwareSourceCode") {
        problems.push("index.html: the JSON-LD block is not a SoftwareSourceCode (R-AX-17)");
      }
      const version = stringAt(data, "version");
      if (version !== expected.version) {
        problems.push(
          `index.html: the JSON-LD names version ${String(version)}, not the core package's ${expected.version} (R-AX-17)`,
        );
      }
    }
  }
  for (const [name, token] of Object.entries(verificationTags(expected.verification))) {
    const found = head.meta.get(name) ?? [];
    if (token !== "" && (found.length !== 1 || found[0] !== token)) {
      problems.push(
        `index.html: needs <meta name="${name}"> with the token in ${VERIFICATION_FILE} (R-AX-17)`,
      );
    } else if (token === "" && found.length > 0) {
      problems.push(
        `index.html: has <meta name="${name}"> but ${VERIFICATION_FILE} sets none (R-AX-17)`,
      );
    }
  }
  return problems;
}
