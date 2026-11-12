// The meta description of each user page on the docs site (R-AX-17, issue #367). The pages in
// `docs/user/` hold no frontmatter (decision 0015), so their descriptions live in
// `site/descriptions.json`, keyed by the page's path under `docs/user/`. The site config sets each
// one through `transformPageData`.
//
// Each description says what the page does for its reader, in 40 to 160 characters, and no two
// pages share one. A new user page needs an entry: `descriptionProblems` fails `site:check`, and a
// unit test fails, while a page has none or an entry names no page.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { listFiles, USER_DOCS } from "./agent-docs.ts";
import { DESCRIPTION_MAX, DESCRIPTION_MIN } from "./site-seo.ts";

/** The descriptions of the user pages, relative to the repository root. */
export const DESCRIPTIONS_FILE = "site/descriptions.json";

/**
 * The description of each user page in `root`, by its path under `docs/user/`, from
 * `site/descriptions.json`. None when the file does not exist. Throws when the file is not an
 * object of strings.
 */
export function readPageDescriptions(root: string): Map<string, string> {
  const file = path.join(root, DESCRIPTIONS_FILE);
  const descriptions = new Map<string, string>();
  if (!existsSync(file)) {
    return descriptions;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${DESCRIPTIONS_FILE} must be an object of page paths and descriptions`);
  }
  for (const [page, description] of Object.entries(parsed)) {
    if (typeof description !== "string") {
      throw new Error(`${DESCRIPTIONS_FILE}: the description of ${page} is not a string`);
    }
    descriptions.set(page, description);
  }
  return descriptions;
}

/**
 * Problems with the descriptions of the user pages in `root`: a page without one, an entry for a
 * page that does not exist, a description outside the length rule, and two pages that share one.
 */
export function descriptionProblems(root: string): string[] {
  const descriptions = readPageDescriptions(root);
  const pages = listFiles(root, USER_DOCS, ".md").map((file) =>
    path.posix.relative(USER_DOCS, file),
  );
  const problems: string[] = [];
  for (const page of pages) {
    if (!descriptions.has(page)) {
      problems.push(
        `${USER_DOCS}/${page} has no description; add one to ${DESCRIPTIONS_FILE} (R-AX-17)`,
      );
    }
  }
  const seen = new Map<string, string>();
  for (const [page, description] of descriptions) {
    if (!pages.includes(page)) {
      problems.push(
        `${DESCRIPTIONS_FILE} names ${page}, which is not a page under ${USER_DOCS}/ (R-AX-17)`,
      );
    }
    if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
      problems.push(
        `${DESCRIPTIONS_FILE}: ${page} has ${description.length} characters; keep it between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} (R-AX-17)`,
      );
    }
    const other = seen.get(description);
    if (other === undefined) {
      seen.set(description, page);
    } else {
      problems.push(`${DESCRIPTIONS_FILE}: ${other} and ${page} share a description (R-AX-17)`);
    }
  }
  return problems;
}
