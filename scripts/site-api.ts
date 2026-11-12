// The API reference of the docs site (R-AX-2, decision 0015): TypeDoc with typedoc-plugin-markdown
// writes a folder per package entry point into `site/api/`, with a page for the entry point and a
// page per exported member, which only the site build reads. It is never written to `docs/user/`, so the npm package does not ship it. The runner is
// site/api-reference.ts, which imports TypeDoc from the `site` workspace package, where TypeDoc
// gets the TypeScript 6 API. This module holds what does not need TypeDoc: the entry points, read
// from each package's `exports`, the module names, the pages and the checks on them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { braceProblems, headings, listFiles } from "./agent-docs.ts";

/** The folder TypeDoc writes the API reference to, relative to the repository root. */
export const API_OUT = "site/api";
/** The folder of the API reference on the site, under the site's base. */
export const API_SITE_DIR = "api";
/** The title of the reference's index page. */
export const API_TITLE = "API reference";

/**
 * The order of the groups on the page of an entry point: functions first, then classes, types and
 * constants. TypeDoc names the groups by kind.
 */
export const API_GROUP_ORDER = [
  "Functions",
  "Classes",
  "Interfaces",
  "Type Aliases",
  "Variables",
  "*",
] as const;

/**
 * The functions that lead the functions of an entry point, in this order: the calls of the
 * verification flow, which most readers come for. The other functions follow in name order.
 */
export const API_LEADING_FUNCTIONS = [
  "verify",
  "dryRun",
  "checkStatus",
  "verifyEach",
  "linkProxy",
] as const;

/**
 * `members` in the order of the page of an entry point: the names of `API_LEADING_FUNCTIONS` in
 * that list's order, then the others in their given order. The sort is stable, so TypeDoc's name
 * order stays for the rest.
 */
export function orderApiMembers<T extends { name: string }>(members: readonly T[]): T[] {
  const leading: readonly string[] = API_LEADING_FUNCTIONS;
  const rank = (name: string): number => {
    const index = leading.indexOf(name);
    return index === -1 ? leading.length : index;
  };
  return members.toSorted((a, b) => rank(a.name) - rank(b.name));
}

/**
 * Whether a source file, an absolute path, is part of the repository, so a source link to it at
 * the version's tag resolves. A file outside `root`, or under a `node_modules` folder, such as the
 * TypeScript or Node.js declarations of a member inherited from `Error`, is not.
 */
export function isRepositorySource(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes("node_modules")
  );
}

/** One documented entry point: the name a user imports and its source file. */
export interface ApiEntryPoint {
  /** The import specifier, such as `explorer-verify/server`. */
  name: string;
  /** The name of the package that exports it. */
  packageName: string;
  /** The source file, relative to the repository root. */
  source: string;
}

/** A field of a parsed JSON value, or undefined. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** Built declarations under `dist/`, whose source is the same path under the package. */
const DECLARATION = /^\.\/dist\/(.+)\.d\.ts$/;

/**
 * Every entry point of every package under `packages/` whose export has a `types` condition, with
 * the source the declarations are built from, in folder and export order. A package without such
 * an export, such as the CLI, has no API to document. Throws when a manifest has no name, or when
 * the source of a declaration is missing.
 */
export function apiEntryPoints(root: string): ApiEntryPoint[] {
  const folders = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const entryPoints: ApiEntryPoint[] = [];
  for (const folder of folders) {
    const manifestPath = path.posix.join("packages", folder, "package.json");
    if (!existsSync(path.join(root, manifestPath))) {
      continue;
    }
    const manifest: unknown = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
    const name = field(manifest, "name");
    if (typeof name !== "string") {
      throw new Error(`${manifestPath} has no name`);
    }
    const exports = field(manifest, "exports");
    if (typeof exports !== "object" || exports === null) {
      continue;
    }
    for (const [subpath, target] of Object.entries(exports)) {
      const types = field(target, "types");
      const built = typeof types === "string" ? DECLARATION.exec(types)?.[1] : undefined;
      if (built === undefined) {
        continue;
      }
      const source = path.posix.join("packages", folder, `${built}.ts`);
      if (!existsSync(path.join(root, source))) {
        throw new Error(`${manifestPath}: the export ${subpath} has no source ${source}`);
      }
      entryPoints.push({
        name: subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`,
        packageName: name,
        source,
      });
    }
  }
  return entryPoints;
}

/**
 * The file name, without `.md`, of the page of an entry point: the import specifier without its
 * `@scope/`, with each `/` as `-`. So `explorer-verify/server` is `explorer-verify-server`, next to
 * `explorer-verify`, and no page shares its name with a folder: a link to `api/explorer-verify`
 * must not resolve to a directory.
 */
export function apiPageName(name: string): string {
  return name.replace(/^@[^/]+\//, "").replaceAll("/", "-");
}

/** One page of the built API reference. */
export interface ApiPage {
  /** The path under `site/api/`, such as `explorer-verify-server.md`. */
  page: string;
  /** The page's first heading, or its path when it has none. */
  title: string;
}

/**
 * The segments of a page path, without `.md` and without a last `index`, so a folder's index sorts
 * as the folder: `explorer-verify/index.md` is `["explorer-verify"]`.
 */
function sortKey(page: string): string[] {
  const segments = page.replace(/\.md$/, "").split("/");
  return segments.at(-1) === "index" ? segments.slice(0, -1) : segments;
}

/** Compares two page paths segment by segment, a shorter path first when one is a prefix. */
function comparePages(a: string, b: string): number {
  const left = sortKey(a);
  const right = sortKey(b);
  for (const [index, segment] of left.entries()) {
    const other = right[index];
    if (other === undefined) {
      return 1;
    }
    if (segment !== other) {
      return segment < other ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/**
 * The pages of the API reference in `directory`, an absolute path such as `<root>/site/api`, index
 * first, then segment by segment, each folder's `index.md` before the pages in that folder. So
 * `explorer-verify/index.md` comes first, then the members of `explorer-verify`, then
 * `explorer-verify-server/index.md`. None when the folder does not exist.
 */
export function apiPages(directory: string): ApiPage[] {
  return listFiles(directory, ".", ".md")
    .toSorted(comparePages)
    .map((page) => ({
      page,
      title: headings(readFileSync(path.join(directory, page), "utf8"))[0] ?? page,
    }));
}

/**
 * Whether a page of the API reference is the index or the page of an entry point,
 * `<name>/index.md`, which the sidebar lists. The page of a member, such as
 * `explorer-verify/functions/verify.md`, is not: the page of its entry point links it.
 */
export function isApiEntryPage(page: string): boolean {
  return page === "index.md" || /^[^/]+\/index\.md$/.test(page);
}

/** A row of the index's table whose description is TypeDoc's placeholder, `-`. */
const UNDESCRIBED_ROW = /^\| \[([^\]]+)\]\([^)]*\) \| - \|$/;

/**
 * Problems with the pages generated into `directory`: the index and the page of each entry point,
 * `<page name>/index.md`, must exist, the index must describe every entry point, no page may share
 * its name with a folder, and no page may hold `{{` in prose, which the docs site would evaluate
 * as a Vue expression (R-AX-17).
 */
export function apiProblems(directory: string, entryPoints: readonly ApiEntryPoint[]): string[] {
  const pages = apiPages(directory);
  const problems: string[] = [];
  const index = pages.find(({ page, title }) => page === "index.md" && title === API_TITLE);
  if (index === undefined) {
    problems.push(`${directory} has no index.md titled "${API_TITLE}" (R-AX-2)`);
  } else {
    for (const line of readFileSync(path.join(directory, index.page), "utf8").split("\n")) {
      const name = UNDESCRIBED_ROW.exec(line)?.[1];
      if (name !== undefined) {
        problems.push(
          `${directory}/index.md lists ${name} without a description; give its entry point a @packageDocumentation comment (R-AX-2)`,
        );
      }
    }
  }
  for (const { name } of entryPoints) {
    const page = `${apiPageName(name)}/index.md`;
    if (!pages.some((candidate) => candidate.page === page && candidate.title === name)) {
      problems.push(`${directory} has no page ${page} titled ${name} (R-AX-2)`);
    }
  }
  for (const { page } of pages) {
    if (existsSync(path.join(directory, page.replace(/\.md$/, "")))) {
      problems.push(
        `${directory}/${page} has a folder of the same name; a link to the page would reach the folder (R-AX-17)`,
      );
    }
    problems.push(
      ...braceProblems(page, readFileSync(path.join(directory, page), "utf8")).map(
        (problem) => `${directory}/${problem}`,
      ),
    );
  }
  return problems;
}

/** The file, in the API reference's folder, that maps each page to its description. */
export const API_DESCRIPTIONS = "descriptions.json";

/** The description of the reference's index page. */
export const API_INDEX_DESCRIPTION =
  "Every export of the explorer-verify packages by entry point: functions, classes, types and constants, generated from their TSDoc.";

/** The longest description of an API page. */
const API_DESCRIPTION_MAX = 160;

/** The kind TypeDoc puts before a member's name in its heading, such as `Function: `. */
const KIND_PREFIX = /^[A-Z][A-Za-z ]*: /;

/** A TSDoc summary as plain text: links as their text, no code marks, one line. */
function plainSummary(summary: string): string {
  return summary
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll("`", "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/**
 * The description of the page of one API member or entry point, from its title (the page's first
 * heading, such as `Function: verify()`), its entry point, such as `explorer-verify/core`, and the
 * first paragraph of its TSDoc summary: the member's name and entry point, then as many of the
 * summary's sentences as fit in 160 characters. A first sentence too long to fit is cut at a word
 * and ends with `…`. Naming the entry point keeps the description of a member that two entry
 * points export unique.
 */
export function apiDescription(title: string, entry: string, summary: string): string {
  const name = title.replace(KIND_PREFIX, "").replaceAll(/\\(.)/g, "$1");
  const lead = name === entry ? `${entry}: ` : `${name} in ${entry}: `;
  const sentences = plainSummary(summary)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence !== "");
  let text = lead;
  for (const sentence of sentences) {
    const next = text === lead ? `${text}${sentence}` : `${text} ${sentence}`;
    if (next.length > API_DESCRIPTION_MAX) {
      break;
    }
    text = next;
  }
  if (text !== lead) {
    return text;
  }
  const room = API_DESCRIPTION_MAX - lead.length - 1;
  const first = sentences[0] ?? "";
  const cut = first.slice(0, room + 1);
  const word = cut.lastIndexOf(" ");
  const kept = cut.slice(0, word > 0 ? word : room).replace(/[\s,;:]+$/, "");
  return `${lead}${kept}…`;
}

/**
 * The `<title>` text of each API page whose first heading another API page shares: the member's
 * name without its kind, then its entry point in brackets, such as
 * `verify() (explorer-verify/core)`. The entry point is the title of the `index.md` of the page's
 * folder. A page whose heading no other page has keeps it, and is left out.
 */
export function apiTitles(pages: readonly ApiPage[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const { title } of pages) {
    count.set(title, (count.get(title) ?? 0) + 1);
  }
  const titles = new Map<string, string>();
  for (const { page, title } of pages) {
    const folder = page.split("/")[0] ?? "";
    const entry = pages.find((candidate) => candidate.page === `${folder}/index.md`)?.title;
    if ((count.get(title) ?? 0) > 1 && entry !== undefined && !isApiEntryPage(page)) {
      titles.set(page, `${title.replace(KIND_PREFIX, "").replaceAll(/\\(.)/g, "$1")} (${entry})`);
    }
  }
  return titles;
}
