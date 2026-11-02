// Shared logic for the agent-docs rules (requirements R-AX-1 to R-AX-3), used by
// scripts/check-agent-docs.ts, scripts/package-docs.ts and scripts/check-packed-files.ts.
//
// The rules:
// - `llms.txt` at the repository root has an H1, a summary blockquote and H2 sections, and links
//   only with absolute URLs. Each GitHub link to this repository names a file that exists, and
//   every Markdown file under `docs/user/` is listed.
// - Each user page has the version line `Version: explorer-verify <version>` and a relative link
//   to the root `llms.txt` in its first 10 lines. The version matches the core package.
// - The agent page `docs/user/guides/using-from-an-agent.md` exists.
// - Each relative link in a Markdown file under `docs/` points to a file that exists and, when it
//   has a fragment, to a heading in that file (GitHub heading slugs).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The prefix of an absolute link to a file on the default branch of this repository. */
export const GITHUB_BLOB = "https://github.com/aelmanaa/explorer-verify/blob/main/";
const GITHUB_FILE = /^https:\/\/github\.com\/aelmanaa\/explorer-verify\/(?:blob|tree)\/main\//;

/** The folder of the user docs, which the package ships as `docs/`. */
export const USER_DOCS = "docs/user";
/** The page that R-AX-3 requires. */
export const AGENT_PAGE = "docs/user/guides/using-from-an-agent.md";
/** The core package, whose version the user pages state. */
export const PACKAGE_DIR = "packages/explorer-verify";
/** How many lines from the top of a user page may hold the version line and the `llms.txt` link. */
export const HEAD_LINES = 10;

const VERSION_LINE = /^Version: explorer-verify (\S+)$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A link target found in a Markdown file. */
export interface Link {
  /** The 1-based line number. */
  line: number;
  /** The target as written, without angle brackets. */
  target: string;
}

/** Files under `directory` (relative to `root`) with the given extension, as POSIX paths. */
export function listFiles(root: string, directory: string, extension: string): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(root, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((entry) => {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFiles(root, relative, extension);
      }
      return entry.name.endsWith(extension) ? [relative] : [];
    })
    .toSorted();
}

/** The version of the core package. */
export function packageVersion(root: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(root, PACKAGE_DIR, "package.json"), "utf8"),
  );
  const version: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string") {
    throw new Error(`${PACKAGE_DIR}/package.json has no version`);
  }
  return version;
}

/** Calls `visit` for each line outside fenced code blocks, with inline code spans blanked. */
function forEachProseLine(
  text: string,
  visit: (line: string, index: number, raw: string) => void,
): void {
  let fence: string | undefined;
  for (const [index, raw] of text.split("\n").entries()) {
    const marker = FENCE.exec(raw)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker;
      } else if (marker === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence === undefined) {
      visit(
        raw.replace(/`[^`]*`/g, (span) => " ".repeat(span.length)),
        index,
        raw,
      );
    }
  }
}

function unwrap(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

/** The link targets in a Markdown text: inline links, images and reference definitions. */
export function markdownLinks(text: string): Link[] {
  const links: Link[] = [];
  forEachProseLine(text, (line, index) => {
    for (const match of line.matchAll(INLINE_LINK)) {
      links.push({ line: index + 1, target: unwrap(match[1] ?? "") });
    }
    const reference = REFERENCE_LINK.exec(line)?.[1];
    if (reference !== undefined) {
      links.push({ line: index + 1, target: unwrap(reference) });
    }
  });
  return links;
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, each space a hyphen. */
export function githubSlug(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors of a Markdown text: heading slugs, with `-1`, `-2` for repeats, and HTML ids. */
export function anchors(text: string): Set<string> {
  const found = new Set<string>();
  const seen = new Map<string, number>();
  forEachProseLine(text, (_line, _index, raw) => {
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(raw)?.[1];
    if (heading !== undefined) {
      const slug = githubSlug(heading);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      found.add(count === 0 ? slug : `${slug}-${count}`);
    }
    for (const match of raw.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) {
      found.add(match[1] ?? "");
    }
  });
  return found;
}

function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Splits a link target into its path and its decoded fragment. */
function splitTarget(target: string): { file: string; fragment: string | undefined } {
  const hash = target.indexOf("#");
  if (hash === -1) {
    return { file: target, fragment: undefined };
  }
  let fragment = target.slice(hash + 1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // Keep the fragment as written; the anchor check reports it.
  }
  return { file: target.slice(0, hash), fragment };
}

/** Problems with the relative links of one Markdown file under `root`. */
function checkLinks(root: string, file: string, text: string): string[] {
  const problems: string[] = [];
  for (const { line, target } of markdownLinks(text)) {
    if (SCHEME.test(target) || target.startsWith("//")) {
      continue;
    }
    const where = `${file}:${line}`;
    const { file: linked, fragment } = splitTarget(target);
    const relative =
      linked === ""
        ? file
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), linked));
    if (relative.startsWith("../")) {
      problems.push(`${where}: link ${target} leaves the repository`);
      continue;
    }
    const absolute = path.join(root, relative);
    if (!exists(absolute)) {
      problems.push(`${where}: link ${target} points to ${relative}, which does not exist`);
      continue;
    }
    if (fragment !== undefined && fragment !== "" && relative.endsWith(".md") && isFile(absolute)) {
      const targetText = relative === file ? text : readFileSync(absolute, "utf8");
      if (!anchors(targetText).has(fragment)) {
        problems.push(`${where}: link ${target} names a heading that ${relative} does not have`);
      }
    }
  }
  return problems;
}

/** Problems with `llms.txt` at the repository root. */
function checkLlmsTxt(root: string, userPages: readonly string[]): string[] {
  const file = path.join(root, "llms.txt");
  if (!exists(file)) {
    return ["llms.txt: missing at the repository root (R-AX-1)"];
  }
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const problems: string[] = [];
  const firstLine = lines.findIndex((line) => line.trim() !== "");
  if (firstLine === -1 || !/^# \S/.test(lines[firstLine] ?? "")) {
    problems.push("llms.txt: the first line must be an H1 (`# Name`) (R-AX-1)");
  }
  const firstSection = lines.findIndex((line) => /^## \S/.test(line));
  if (firstSection === -1) {
    problems.push("llms.txt: has no H2 section (R-AX-1)");
  }
  const intro = lines.slice(firstLine + 1, firstSection === -1 ? lines.length : firstSection);
  if (!intro.some((line) => /^> \S/.test(line))) {
    problems.push(
      "llms.txt: has no summary blockquote (`> ...`) before the first section (R-AX-1)",
    );
  }
  const listed = new Set<string>();
  for (const { line, target } of markdownLinks(text)) {
    if (!SCHEME.test(target)) {
      problems.push(`llms.txt:${line}: link ${target} is relative; use an absolute URL (R-AX-1)`);
      continue;
    }
    if (GITHUB_FILE.test(target)) {
      const relative = splitTarget(target.replace(GITHUB_FILE, "")).file;
      listed.add(relative);
      if (!exists(path.join(root, relative))) {
        problems.push(`llms.txt:${line}: link ${target} names ${relative}, which does not exist`);
      }
    }
  }
  for (const page of userPages) {
    if (!listed.has(page)) {
      problems.push(`llms.txt: does not list ${page}; add ${GITHUB_BLOB}${page} (R-AX-1)`);
    }
  }
  return problems;
}

/** Problems with the head of one user page: the version line and the `llms.txt` link. */
function checkUserPage(file: string, text: string, version: string): string[] {
  const problems: string[] = [];
  const head = text.split("\n").slice(0, HEAD_LINES);
  const stated = head
    .map((line) => VERSION_LINE.exec(line.trim())?.[1])
    .find((match) => match !== undefined);
  if (stated === undefined) {
    problems.push(
      `${file}: no line \`Version: explorer-verify ${version}\` in the first ${HEAD_LINES} lines (R-AX-2)`,
    );
  } else if (stated !== version) {
    problems.push(
      `${file}: states version ${stated}, but ${PACKAGE_DIR} is ${version}; run node scripts/check-agent-docs.ts --write-versions (R-AX-2)`,
    );
  }
  const linksIndex = markdownLinks(head.join("\n")).some(({ target }) => {
    if (SCHEME.test(target)) {
      return false;
    }
    const relative = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), splitTarget(target).file),
    );
    return relative === "llms.txt";
  });
  if (!linksIndex) {
    problems.push(
      `${file}: no relative link to the root llms.txt in the first ${HEAD_LINES} lines (R-AX-3)`,
    );
  }
  return problems;
}

/** Every problem with the agent docs of the repository at `root`; empty when the docs pass. */
export function checkAgentDocs(root: string): string[] {
  const version = packageVersion(root);
  const userPages = listFiles(root, USER_DOCS, ".md");
  const problems = checkLlmsTxt(root, userPages);
  if (!userPages.includes(AGENT_PAGE)) {
    problems.push(`${AGENT_PAGE}: missing; the agent page is required (R-AX-3)`);
  }
  for (const page of userPages) {
    problems.push(...checkUserPage(page, readFileSync(path.join(root, page), "utf8"), version));
  }
  for (const file of listFiles(root, "docs", ".md")) {
    problems.push(...checkLinks(root, file, readFileSync(path.join(root, file), "utf8")));
  }
  return problems;
}

/** Sets the version line of every user page to the package version. Returns the pages changed. */
export function writeVersions(root: string): string[] {
  const version = packageVersion(root);
  const changed: string[] = [];
  for (const page of listFiles(root, USER_DOCS, ".md")) {
    const file = path.join(root, page);
    const text = readFileSync(file, "utf8");
    const updated = text.replace(
      /^Version: explorer-verify \S+$/m,
      `Version: explorer-verify ${version}`,
    );
    if (updated !== text) {
      writeFileSync(file, updated);
      changed.push(page);
    }
  }
  return changed;
}

/** The path inside the package of a repository file under `docs/user/`. */
export function packagedPath(repositoryPath: string): string {
  return `docs/${path.posix.relative(USER_DOCS, repositoryPath)}`;
}

/** The files the packed tarball must hold: `llms.txt` and each user page under `docs/`. */
export function packagedDocFiles(root: string): string[] {
  return ["llms.txt", ...listFiles(root, USER_DOCS, ".md").map(packagedPath)];
}

/**
 * Rewrites the relative links of a user page for the package: a link inside `docs/user/` stays,
 * a link to the root `llms.txt` points to the packaged one, and any other link becomes a GitHub URL.
 */
export function rewriteForPackage(file: string, text: string): string {
  const destination = packagedPath(file);
  const rewrite = (target: string): string => {
    if (SCHEME.test(target) || target.startsWith("//") || target.startsWith("#")) {
      return target;
    }
    const { file: linked } = splitTarget(target);
    const rest = target.slice(linked.length);
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), linked));
    if (relative === USER_DOCS || relative.startsWith(`${USER_DOCS}/`)) {
      return target;
    }
    if (relative === "llms.txt") {
      return `${path.posix.relative(path.posix.dirname(destination), "llms.txt")}${rest}`;
    }
    return `${GITHUB_BLOB}${relative}${rest}`;
  };
  const lines = text.split("\n");
  forEachProseLine(text, (line, index, raw) => {
    let output = "";
    let last = 0;
    const matches = [...line.matchAll(INLINE_LINK)];
    const reference = REFERENCE_LINK.exec(line);
    for (const match of matches) {
      const target = match[1] ?? "";
      const start = (match.index ?? 0) + match[0].lastIndexOf(target);
      output += raw.slice(last, start) + rewrite(target);
      last = start + target.length;
    }
    if (reference?.[1] !== undefined && matches.length === 0) {
      const start = (reference.index ?? 0) + reference[0].lastIndexOf(reference[1]);
      output += raw.slice(last, start) + rewrite(reference[1]);
      last = start + reference[1].length;
    }
    lines[index] = output + raw.slice(last);
  });
  return lines.join("\n");
}

/** The packaged `llms.txt`: the root one with links to user pages made relative to the package. */
export function packagedLlmsTxt(text: string): string {
  return text.replaceAll(`${GITHUB_BLOB}${USER_DOCS}/`, "docs/");
}

/**
 * Writes the user docs into `packageDir` as `docs/`, with links rewritten for the package, and the
 * packaged `llms.txt` next to them. Removes the previous copy first.
 */
export function packageDocs(root: string, packageDir: string): string[] {
  const docs = path.join(packageDir, "docs");
  rmSync(docs, { recursive: true, force: true });
  const written: string[] = [];
  for (const page of listFiles(root, USER_DOCS, ".md")) {
    const destination = path.join(packageDir, packagedPath(page));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      rewriteForPackage(page, readFileSync(path.join(root, page), "utf8")),
    );
    written.push(packagedPath(page));
  }
  writeFileSync(
    path.join(packageDir, "llms.txt"),
    packagedLlmsTxt(readFileSync(path.join(root, "llms.txt"), "utf8")),
  );
  written.push("llms.txt");
  return written;
}

/** The file paths in the output of `npm pack --dry-run --json`. */
export function packedFiles(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const files: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "files") : undefined;
  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run --json printed no file list");
  }
  return files.flatMap((file: unknown) => {
    const name: unknown =
      typeof file === "object" && file !== null ? Reflect.get(file, "path") : undefined;
    return typeof name === "string" ? [name] : [];
  });
}

/** The required files that the list of packed paths lacks. */
export function missingFromPack(packed: readonly string[], required: readonly string[]): string[] {
  const present = new Set(packed.map((file) => file.replace(/^package\//, "")));
  return required.filter((file) => !present.has(file));
}
