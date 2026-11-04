// The API reference of the docs site (R-AX-2, decision 0015): TypeDoc with typedoc-plugin-markdown
// writes one Markdown page per package entry point into `site/api/`, which only the site build
// reads. It is never written to `docs/user/`, so the npm package does not ship it. The runner is
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

/** A page path without its `.md`. */
function withoutMd(page: string): string {
  return page.replace(/\.md$/, "");
}

/**
 * The pages of the API reference in `directory`, an absolute path such as `<root>/site/api`, index
 * first, then in path order without `.md`, so `explorer-verify` comes before
 * `explorer-verify-server`. None when the folder does not exist.
 */
export function apiPages(directory: string): ApiPage[] {
  return listFiles(directory, ".", ".md")
    .toSorted((a, b) => (withoutMd(a) < withoutMd(b) ? -1 : 1))
    .toSorted((a, b) => Number(b === "index.md") - Number(a === "index.md"))
    .map((page) => ({
      page,
      title: headings(readFileSync(path.join(directory, page), "utf8"))[0] ?? page,
    }));
}

/**
 * Problems with the pages generated into `directory`: the index and a page per entry point must
 * exist, no page may share its name with a folder, and no page may hold `{{` in prose, which the
 * docs site would evaluate as a Vue expression (R-AX-17).
 */
export function apiProblems(directory: string, entryPoints: readonly ApiEntryPoint[]): string[] {
  const pages = apiPages(directory);
  const titles = new Set(pages.map(({ title }) => title));
  const problems: string[] = [];
  if (!pages.some(({ page, title }) => page === "index.md" && title === API_TITLE)) {
    problems.push(`${directory} has no index.md titled "${API_TITLE}" (R-AX-2)`);
  }
  for (const { name } of entryPoints) {
    if (!titles.has(name)) {
      problems.push(`${directory} has no page for ${name} (R-AX-2)`);
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
