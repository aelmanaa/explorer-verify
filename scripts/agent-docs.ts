// Shared logic for the agent-docs rules (requirements R-AX-1 to R-AX-3), used by
// scripts/check-agent-docs.ts, scripts/package-docs.ts and scripts/check-packed-files.ts.
//
// The rules:
// - `llms.txt` at the repository root has an H1, a summary blockquote and the H2 sections
//   "User docs" and "Contributor docs", and links only with absolute URLs. A link into this
//   repository is a raw link to `main` and names a file that exists. Every Markdown file under
//   `docs/user/` is listed.
// - Each user page has the version line `Version: explorer-verify <version>` and a relative link
//   to the root `llms.txt` in its first 10 lines. The version matches the core package.
// - The agent page `docs/user/guides/using-from-an-agent.md` exists and has its required headings.
// - `docs/user/` holds no symbolic links.
// - Each relative link in a Markdown file under `docs/` points to a file that exists, with the
//   same case, and, when it has a fragment, to a heading in that file (GitHub heading slugs).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The prefix of a raw link to a file on the default branch of this repository. */
export const RAW_MAIN = "https://raw.githubusercontent.com/aelmanaa/explorer-verify/main/";
const REPOSITORY_LINK =
  /^https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/aelmanaa\/explorer-verify(?:[/?#]|$)/i;

/** The folder of the user docs, which the package ships as `docs/`. */
export const USER_DOCS = "docs/user";
/** The page that R-AX-3 requires. */
export const AGENT_PAGE = "docs/user/guides/using-from-an-agent.md";
/** The headings the agent page must have (R-AX-3). */
export const AGENT_PAGE_HEADINGS: readonly string[] = [
  "Submit is permanent",
  "Safe steps",
  "API keys",
  "Etherscan plan rule",
];
/** The H2 sections `llms.txt` must have (R-AX-1). */
export const LLMS_SECTIONS: readonly string[] = ["User docs", "Contributor docs"];
/** The core package, whose version the user pages state. */
export const PACKAGE_DIR = "packages/explorer-verify";
/** How many lines from the top of a user page may hold the version line and the `llms.txt` link. */
export const HEAD_LINES = 10;

/** The version line. The check and `writeVersions` share it. */
const VERSION_LINE = /^([ \t]*)Version: explorer-verify (\S+)([ \t]*)$/;
const FENCE = /^\s*(```|~~~)/;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const NOT_PARAGRAPH = /^ {0,3}(?:[-*+>|]|\d+[.)])/;
const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** A link target found in a Markdown text. */
export interface Link {
  /** The 1-based line number. */
  line: number;
  /** The target as written, without angle brackets. */
  target: string;
}

/** The regular files and the symbolic links under `directory` (relative to `root`). */
function walk(root: string, directory: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  let entries;
  try {
    entries = readdirSync(path.join(root, directory), { withFileTypes: true });
  } catch {
    return { files, symlinks };
  }
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = walk(root, relative);
      files.push(...inner.files);
      symlinks.push(...inner.symlinks);
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      // A symbolic link, or another entry that is not a regular file or folder.
      symlinks.push(relative);
    }
  }
  return { files: files.toSorted(), symlinks: symlinks.toSorted() };
}

/** The regular files under `directory` (relative to `root`) whose names end with `suffix`. */
export function listFiles(root: string, directory: string, suffix = ""): string[] {
  return walk(root, directory).files.filter((file) => file.endsWith(suffix));
}

/**
 * Whether `relative` names a regular file or a directory under `root`. Each segment must match a
 * directory entry exactly, so a link with the wrong case fails on every file system. A symbolic
 * link counts as missing.
 */
function lookup(root: string, relative: string): "file" | "directory" | undefined {
  let current = root;
  let kind: "file" | "directory" = "directory";
  for (const segment of relative.split("/").filter((part) => part !== "" && part !== ".")) {
    if (kind === "file") {
      return undefined;
    }
    const entry = readdirSync(current, { withFileTypes: true }).find(
      (candidate) => candidate.name === segment,
    );
    if (entry === undefined || !(entry.isFile() || entry.isDirectory())) {
      return undefined;
    }
    kind = entry.isFile() ? "file" : "directory";
    current = path.join(current, segment);
  }
  return kind;
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

/**
 * Calls `visit` for each line outside fenced code blocks, with inline code spans blanked. A fence
 * closes only on the marker that opened it.
 */
export function forEachProseLine(
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
    } else if (fence === undefined) {
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
      links.push({ line: index + 1, target: unwrap(String(match[1])) });
    }
    const reference = REFERENCE_LINK.exec(line);
    if (reference !== null) {
      links.push({ line: index + 1, target: unwrap(String(reference[1])) });
    }
  });
  return links;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const hex = name[1] === "x" || name[1] === "X";
      return String.fromCodePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * The anchor GitHub gives a heading. It slugs the rendered text: link text kept, HTML tags,
 * backticks and emphasis markers dropped, entities decoded. Then it lower-cases, drops punctuation
 * except `-` and `_`, and turns each space into a hyphen without collapsing runs.
 */
export function githubSlug(heading: string): string {
  const rendered = decodeEntities(
    heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/[`*]/g, "")
      .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, ""),
  );
  return rendered
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** The headings of a Markdown text, ATX (`# Title`) and setext (a line underlined with = or -). */
export function headings(text: string): string[] {
  const found: string[] = [];
  let previous: { index: number; raw: string } | undefined;
  forEachProseLine(text, (_line, index, raw) => {
    const atx = ATX_HEADING.exec(raw);
    if (atx !== null) {
      found.push(String(atx[1]));
      previous = undefined;
      return;
    }
    if (
      previous?.index === index - 1 &&
      SETEXT_UNDERLINE.test(raw) &&
      !NOT_PARAGRAPH.test(previous.raw)
    ) {
      found.push(previous.raw.trim());
      previous = undefined;
      return;
    }
    previous = raw.trim() === "" ? undefined : { index, raw };
  });
  return found;
}

/** The anchors of a Markdown text: heading slugs, with `-1`, `-2` for repeats, and HTML ids. */
export function anchors(text: string): Set<string> {
  const found = new Set<string>();
  const seen = new Map<string, number>();
  for (const heading of headings(text)) {
    const slug = githubSlug(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    found.add(count === 0 ? slug : `${slug}-${count}`);
  }
  forEachProseLine(text, (_line, _index, raw) => {
    for (const match of raw.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) {
      found.add(String(match[1]));
    }
  });
  return found;
}

/** Splits a link target into its path and its percent-decoded fragment. */
function splitTarget(target: string): { file: string; fragment: string | undefined } {
  const hash = target.indexOf("#");
  if (hash === -1) {
    return { file: target, fragment: undefined };
  }
  const fragment = target.slice(hash + 1);
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Keep the fragment as written; the anchor check reports it.
  }
  return { file: target.slice(0, hash), fragment: decoded };
}

/** The repository path a relative link in `file` points to, without a trailing slash. */
function resolveLink(file: string, linked: string): string {
  if (linked === "") {
    return file;
  }
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(file), linked))
    .replace(/(.)\/$/, "$1");
}

function leaves(relative: string): boolean {
  return relative === ".." || relative.startsWith("../") || relative.startsWith("/");
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
    const relative = resolveLink(file, linked);
    if (leaves(relative)) {
      problems.push(`${where}: link ${target} leaves the repository`);
      continue;
    }
    const kind = lookup(root, relative);
    if (kind === undefined) {
      problems.push(`${where}: link ${target} points to ${relative}, which does not exist`);
      continue;
    }
    if (fragment !== undefined && fragment !== "" && kind === "file" && relative.endsWith(".md")) {
      const targetText = relative === file ? text : readFileSync(path.join(root, relative), "utf8");
      if (!anchors(targetText).has(fragment)) {
        problems.push(`${where}: link ${target} names a heading that ${relative} does not have`);
      }
    }
  }
  return problems;
}

/** Problems with `llms.txt` at the repository root. */
function checkLlmsTxt(root: string, userPages: readonly string[]): string[] {
  if (lookup(root, "llms.txt") !== "file") {
    return ["llms.txt: missing at the repository root (R-AX-1)"];
  }
  const text = readFileSync(path.join(root, "llms.txt"), "utf8");
  const lines = text.split("\n");
  const problems: string[] = [];
  const firstLine = lines.findIndex((line) => line.trim() !== "");
  if (!/^# \S/.test(lines[firstLine] ?? "")) {
    problems.push("llms.txt: the first line must be an H1 (`# Name`) (R-AX-1)");
  }
  const sections = lines.flatMap((line) => (line.startsWith("## ") ? [line.slice(3).trim()] : []));
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  const intro = lines.slice(firstLine + 1, firstSection === -1 ? lines.length : firstSection);
  if (!intro.some((line) => /^> \S/.test(line))) {
    problems.push(
      "llms.txt: has no summary blockquote (`> ...`) before the first section (R-AX-1)",
    );
  }
  for (const section of LLMS_SECTIONS) {
    if (!sections.includes(section)) {
      problems.push(`llms.txt: has no section \`## ${section}\` (R-AX-1)`);
    }
  }
  const listed = new Set<string>();
  for (const { line, target } of markdownLinks(text)) {
    const where = `llms.txt:${line}`;
    if (!SCHEME.test(target)) {
      problems.push(`${where}: link ${target} is relative; use an absolute URL (R-AX-1)`);
    } else if (REPOSITORY_LINK.test(target)) {
      if (!target.startsWith(RAW_MAIN)) {
        problems.push(
          `${where}: link ${target} is not a raw link to main; use ${RAW_MAIN}<path> (R-AX-1)`,
        );
        continue;
      }
      const relative = path.posix.normalize(splitTarget(target.slice(RAW_MAIN.length)).file);
      if (leaves(relative)) {
        problems.push(`${where}: link ${target} leaves the repository`);
      } else if (lookup(root, relative) === "file") {
        listed.add(relative);
      } else {
        problems.push(`${where}: link ${target} names ${relative}, which does not exist`);
      }
    }
  }
  for (const page of userPages) {
    if (!listed.has(page)) {
      problems.push(`llms.txt: does not list ${page}; add ${RAW_MAIN}${page} (R-AX-1)`);
    }
  }
  return problems;
}

/** The version line in the first lines of a page, outside code fences, with its 1-based line. */
function versionLine(text: string): { line: number; version: string } | undefined {
  let found: { line: number; version: string } | undefined;
  forEachProseLine(text.split("\n").slice(0, HEAD_LINES).join("\n"), (_line, index, raw) => {
    const match = VERSION_LINE.exec(raw);
    if (found === undefined && match !== null) {
      found = { line: index + 1, version: String(match[2]) };
    }
  });
  return found;
}

/** Problems with the head of one user page: the version line and the `llms.txt` link. */
function checkUserPage(file: string, text: string, version: string): string[] {
  const problems: string[] = [];
  const stated = versionLine(text);
  if (stated === undefined) {
    problems.push(
      `${file}: no line \`Version: explorer-verify ${version}\` in the first ${HEAD_LINES} lines (R-AX-2)`,
    );
  } else if (stated.version !== version) {
    problems.push(
      `${file}:${stated.line}: states version ${stated.version}, but ${PACKAGE_DIR} is ${version}; run node scripts/check-agent-docs.ts --write-versions (R-AX-2)`,
    );
  }
  const head = text.split("\n").slice(0, HEAD_LINES).join("\n");
  const linksIndex = markdownLinks(head).some(
    ({ target }) =>
      !SCHEME.test(target) && resolveLink(file, splitTarget(target).file) === "llms.txt",
  );
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
  const { files, symlinks } = walk(root, USER_DOCS);
  const userPages = files.filter((file) => file.endsWith(".md"));
  const problems = checkLlmsTxt(root, userPages);
  for (const link of symlinks) {
    problems.push(`${link}: symlinks are not allowed in docs/user (R-AX-2)`);
  }
  if (userPages.includes(AGENT_PAGE)) {
    const found = anchors(readFileSync(path.join(root, AGENT_PAGE), "utf8"));
    for (const heading of AGENT_PAGE_HEADINGS) {
      if (!found.has(githubSlug(heading))) {
        problems.push(`${AGENT_PAGE}: has no heading "${heading}" (R-AX-3)`);
      }
    }
  } else {
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

/**
 * Sets the version line of every user page to the package version. It changes only a version
 * line in the first lines of a page and outside code fences. Returns the pages changed.
 */
export function writeVersions(root: string): string[] {
  const version = packageVersion(root);
  const changed: string[] = [];
  for (const page of listFiles(root, USER_DOCS, ".md")) {
    const file = path.join(root, page);
    const text = readFileSync(file, "utf8");
    const stated = versionLine(text);
    if (stated !== undefined && stated.version !== version) {
      const lines = text.split("\n");
      lines[stated.line - 1] = String(lines[stated.line - 1]).replace(
        VERSION_LINE,
        `$1Version: explorer-verify ${version}$3`,
      );
      writeFileSync(file, lines.join("\n"));
      changed.push(page);
    }
  }
  return changed;
}

/** The path inside the package of a repository file under `docs/user/`. */
export function packagedPath(repositoryPath: string): string {
  return `docs/${path.posix.relative(USER_DOCS, repositoryPath)}`;
}

/** The files the packed tarball must hold: `llms.txt` and each file under `docs/`. */
export function packagedDocFiles(root: string): string[] {
  return ["llms.txt", ...listFiles(root, USER_DOCS).map(packagedPath)];
}

/**
 * Rewrites the relative links of a user page for the package: a link inside `docs/user/` stays,
 * a link to the root `llms.txt` points to the packaged one, and any other link becomes a raw
 * GitHub URL.
 */
export function rewriteForPackage(file: string, text: string): string {
  const destination = packagedPath(file);
  const rewrite = (target: string): string => {
    if (SCHEME.test(target) || target.startsWith("//") || target.startsWith("#")) {
      return target;
    }
    const { file: linked } = splitTarget(target);
    const rest = target.slice(linked.length);
    const relative = resolveLink(file, linked);
    if (relative === USER_DOCS || relative.startsWith(`${USER_DOCS}/`)) {
      return target;
    }
    if (relative === "llms.txt") {
      return `${path.posix.relative(path.posix.dirname(destination), "llms.txt")}${rest}`;
    }
    return `${RAW_MAIN}${relative}${rest}`;
  };
  const lines = text.split("\n");
  forEachProseLine(text, (line, index, raw) => {
    let output = "";
    let last = 0;
    const matches = [...line.matchAll(INLINE_LINK)];
    const reference = REFERENCE_LINK.exec(line);
    if (reference !== null) {
      matches.unshift(reference);
    }
    for (const match of matches) {
      const target = String(match[1]);
      const inner = unwrap(target);
      const start = match.index + match[0].lastIndexOf(target);
      const replaced = rewrite(inner);
      output += raw.slice(last, start) + (inner === target ? replaced : `<${replaced}>`);
      last = start + target.length;
    }
    lines[index] = output + raw.slice(last);
  });
  return lines.join("\n");
}

/** The packaged `llms.txt`: the root one with links to user pages made relative to the package. */
export function packagedLlmsTxt(text: string): string {
  return text.replaceAll(`${RAW_MAIN}${USER_DOCS}/`, "docs/");
}

/**
 * Writes every file under `docs/user/` into `packageDir` as `docs/`, with the links of Markdown
 * pages rewritten for the package, and the packaged `llms.txt` next to them. Removes the previous
 * copy first.
 */
export function packageDocs(root: string, packageDir: string): string[] {
  rmSync(path.join(packageDir, "docs"), { recursive: true, force: true });
  const written: string[] = [];
  for (const source of listFiles(root, USER_DOCS)) {
    const destination = path.join(packageDir, packagedPath(source));
    mkdirSync(path.dirname(destination), { recursive: true });
    const content = readFileSync(path.join(root, source));
    writeFileSync(
      destination,
      source.endsWith(".md") ? rewriteForPackage(source, content.toString("utf8")) : content,
    );
    written.push(packagedPath(source));
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
  const present = new Set(packed);
  return required.filter((file) => !present.has(file));
}

/**
 * Problems with the relative links of the packaged pages and the packaged `llms.txt`: each must
 * point to a file or folder in the tarball. `packageDir` holds the files the list names.
 */
export function packagedLinkProblems(packageDir: string, packed: readonly string[]): string[] {
  const present = new Set(packed);
  for (const file of packed) {
    for (
      let folder = path.posix.dirname(file);
      folder !== ".";
      folder = path.posix.dirname(folder)
    ) {
      present.add(folder);
    }
  }
  const pages = packed.filter(
    (file) => file === "llms.txt" || (file.startsWith("docs/") && file.endsWith(".md")),
  );
  const problems: string[] = [];
  for (const page of pages) {
    for (const { line, target } of markdownLinks(
      readFileSync(path.join(packageDir, page), "utf8"),
    )) {
      const linked = splitTarget(target).file;
      if (SCHEME.test(target) || target.startsWith("//") || linked === "") {
        continue;
      }
      const relative = resolveLink(page, linked);
      if (!present.has(relative)) {
        problems.push(
          `${page}:${line}: link ${target} points to ${relative}, which is not in the tarball (R-AX-2)`,
        );
      }
    }
  }
  return problems;
}
