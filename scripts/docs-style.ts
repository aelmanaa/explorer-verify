// The style rules of the user docs (docs/contributor/docs-style.md), used by
// scripts/check-agent-docs.ts, which `pnpm run check` runs.
//
// On every page under `docs/user/` the check fails:
// - a paragraph, list item or quote over 80 words;
// - a page whose paragraphs, list items and quotes average over 30 words;
// - a sentence with more than 4 code spans;
// - a code block whose introducing line does not end with a colon;
// - a paragraph that starts with "Note:" or a similar label instead of a GitHub alert;
// - a dated citation ("read 2026-…", "fetched 2026-…") outside a "Sources" H2;
// - a shell block line that starts with a bare `explorer-verify` instead of
//   `npx @explorer-verify/cli`;
// - a guide or quickstart (`guides/`, `start/`, `tutorials/`) without a "For:" and a
//   "You need:" line in its first 15 lines, or whose last H2 is not "Next steps";
// - the line `<!-- docs-style: legacy -->`, which once exempted a page from these rules;
// - a line over 80 characters in a fenced code block, except in a `text` block, which holds
//   program output as printed. A block with a line that cannot break, such as JSON with a long
//   string, may have `<!-- code-width: the reason -->` on the nearest non-blank line before it.
//
// The code width rule also runs on the agent skills, `llms.txt` and the site's home page. It is
// for the source and the copies in the npm package and on GitHub; the site soft-wraps code.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { forEachProseLine, listFiles, SKILLS, USER_DOCS } from "./agent-docs.ts";

/** The line that once exempted a page from the style rules. The check now fails it. */
export const LEGACY_MARKER = "<!-- docs-style: legacy -->";
/** The style guide that the problems point to. */
export const STYLE_GUIDE = "docs/contributor/docs-style.md";
/** The most words a paragraph, list item or quote may have. The guide asks for about 50. */
export const MAX_WORDS = 80;
/** The highest average word count of a page's paragraphs, list items and quotes. */
export const MAX_AVERAGE = 30;
/** The most code spans one sentence may have. */
export const MAX_CODE_SPANS = 4;
/** How many lines from the top of a guide may hold its "For:" and "You need:" lines. */
export const GUIDE_HEAD_LINES = 15;
/** The folders under `docs/user/` whose pages are guides or quickstarts. */
export const GUIDE_FOLDERS: readonly string[] = ["guides", "start", "tutorials"];
/** The H2 that ends a guide. */
export const NEXT_STEPS = "Next steps";
/** The H2 that may hold dated citations. */
export const SOURCES = "Sources";
/** The most characters a line of a fenced code block may have. */
export const MAX_CODE_WIDTH = 80;
/** The languages of code blocks whose lines may be longer: program output, as printed. */
export const WRAPPED_LANGUAGES: ReadonlySet<string> = new Set(["text"]);
/** The comment that lets one code block keep lines over {@link MAX_CODE_WIDTH}, with its reason. */
export const CODE_WIDTH_EXEMPTION: RegExp = /^<!-- code-width: \S.* -->$/;
/** Markdown files outside `docs/user/` that the code width rule reads, besides the skills. */
export const CODE_WIDTH_FILES: readonly string[] = ["llms.txt", "site/pages/index.md"];

/** Splits a code line into the characters a reader sees, to measure its width. */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const SHELL_LANGUAGES: ReadonlySet<string> = new Set(["sh", "bash", "shell", "console", "zsh"]);
const FENCE_OPEN = /^\s*(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
const QUOTE = /^\s{0,3}>[ \t]?/;
const TABLE_ROW = /^\s*\|/;
const CONTAINER = /^\s*:::/;
const CODE_SPAN = /`[^`]*`/g;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const DATED_CITATION = /\b(?:read|fetched|checked|accessed|retrieved)(?: on)? \d{4}-\d{2}-\d{2}\b/i;
const LABEL_CALLOUT =
  /^(?:\*\*|__)?(?:note|tip|important|warning|caution)(?::(?:\*\*|__)|(?:\*\*|__):|:)/i;
const BARE_COMMAND = /^(?:\$[ \t]+)?explorer-verify(?:\s|$)/;

/** A paragraph, list item or quote, with its text joined on spaces. */
export interface TextBlock {
  /** The 1-based line it starts on. */
  readonly line: number;
  readonly kind: "paragraph" | "item" | "quote";
  /** The text as written, with HTML comments removed and code spans kept. */
  readonly text: string;
}

/** A fenced code block. */
interface Fence {
  /** The 0-based index of the opening line. */
  readonly index: number;
  readonly lang: string;
  readonly lines: readonly string[];
}

/** A page split into what the rules read. */
interface Page {
  readonly blocks: readonly TextBlock[];
  readonly fences: readonly Fence[];
  /** The text of each H2, in order, with the 0-based line it is on. */
  readonly h2: readonly { readonly index: number; readonly text: string }[];
  /** Each prose line, by 0-based index, with comments blanked and code spans kept. */
  readonly prose: ReadonlyMap<number, string>;
  /** Each prose line, by 0-based index, with comments and code spans blanked. */
  readonly bare: ReadonlyMap<number, string>;
}

/** The 1-based line of the legacy marker on a line of its own, or `undefined`. */
export function legacyLine(text: string): number | undefined {
  const index = text.split("\n").findIndex((line) => line.trim() === LEGACY_MARKER);
  return index === -1 ? undefined : index + 1;
}

/** Whether a page, relative to `docs/user/`, is a guide or quickstart. */
export function isGuide(page: string): boolean {
  return GUIDE_FOLDERS.some((folder) => page.startsWith(`${folder}/`));
}

/** The fenced blocks among the lines that are not prose, read from the opening fence. */
function readFences(lines: readonly string[], prose: ReadonlyMap<number, string>): Fence[] {
  const fences: Fence[] = [];
  let open: { index: number; marker: string; lang: string; lines: string[] } | undefined;
  for (const [index, line] of lines.entries()) {
    if (prose.has(index)) {
      continue;
    }
    const match = FENCE_OPEN.exec(line);
    if (open === undefined) {
      if (match !== null) {
        open = {
          index,
          marker: String(match[1]).slice(0, 3),
          lang: String(match[2]).toLowerCase(),
          lines: [],
        };
      }
    } else if (match !== null && String(match[1]).startsWith(open.marker)) {
      fences.push({ index: open.index, lang: open.lang, lines: open.lines });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  return fences;
}

/** Splits a page into its text blocks, fences and H2 headings. */
function parse(text: string): Page {
  const lines = text.split("\n");
  const prose = new Map<number, string>();
  const bare = new Map<number, string>();
  forEachProseLine(text, (line, index, raw) => {
    prose.set(index, raw);
    bare.set(index, line);
  });
  const blocks: TextBlock[] = [];
  const h2: { index: number; text: string }[] = [];
  let current: { line: number; kind: TextBlock["kind"]; parts: string[] } | undefined;
  const close = (): void => {
    if (current !== undefined) {
      blocks.push({ line: current.line, kind: current.kind, text: current.parts.join(" ") });
      current = undefined;
    }
  };
  for (const index of lines.keys()) {
    const raw = prose.get(index);
    if (raw === undefined || raw.trim() === "" || TABLE_ROW.test(raw) || CONTAINER.test(raw)) {
      close();
      continue;
    }
    const heading = ATX_HEADING.exec(raw);
    if (heading !== null) {
      close();
      if (heading[1] === "##") {
        h2.push({ index, text: String(heading[2]).trim() });
      }
      continue;
    }
    const kind: TextBlock["kind"] = LIST_ITEM.test(raw)
      ? "item"
      : QUOTE.test(raw)
        ? "quote"
        : "paragraph";
    const part = raw.replace(QUOTE, "").replace(LIST_ITEM, "").trim();
    if (
      kind === "item" ||
      current === undefined ||
      (kind === "quote") !== (current.kind === "quote")
    ) {
      close();
      current = { line: index + 1, kind, parts: [part] };
    } else {
      current.parts.push(part);
    }
  }
  close();
  return { blocks, fences: readFences(lines, prose), h2, prose, bare };
}

/** The words of a text: a code span counts as one word, a link as its text. */
export function wordCount(text: string): number {
  return text
    .replace(CODE_SPAN, " code ")
    .replace(LINK, " $1 ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The most code spans that one sentence of a text holds. */
export function codeSpansPerSentence(text: string): number {
  // Code spans may hold periods, so each is replaced by a mark before the split.
  const marked = text.replace(CODE_SPAN, "\u0000");
  return Math.max(
    0,
    ...marked.split(/(?<=[.!?])\s+/).map((sentence) => sentence.split("\u0000").length - 1),
  );
}

/** The density of a list of blocks: their number, average and longest word count. */
function densityOf(blocks: readonly TextBlock[]): {
  blocks: number;
  average: number;
  longest: number;
} {
  const counts = blocks.map((block) => wordCount(block.text));
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    blocks: counts.length,
    average: counts.length === 0 ? 0 : Math.round(total / counts.length),
    longest: Math.max(0, ...counts),
  };
}

/** How dense a page is: its paragraphs, list items and quotes, and their average word count. */
export function pageDensity(text: string): { blocks: number; average: number; longest: number } {
  return densityOf(parse(text).blocks);
}

/** The H2 a 0-based line falls under, or `undefined` before the first one. */
function sectionOf(page: Page, index: number): string | undefined {
  return page.h2.findLast((heading) => heading.index < index)?.text;
}

/** The problem with the line that introduces a fence, or `undefined` when it ends with a colon. */
function introProblem(page: Page, fence: Fence): string | undefined {
  for (let index = fence.index - 1; index >= 0; index -= 1) {
    const raw = page.prose.get(index);
    if (raw === undefined) {
      // The closing fence of the block before: an output block needs no introduction.
      return undefined;
    }
    if (raw.trim() === "" || CONTAINER.test(raw)) {
      continue;
    }
    if (ATX_HEADING.test(raw)) {
      break;
    }
    return raw.trimEnd().endsWith(":")
      ? undefined
      : "end the sentence that introduces this code block with a colon";
  }
  return "introduce this code block with a sentence that ends with a colon";
}

/**
 * The code width problems of one Markdown file: each line over {@link MAX_CODE_WIDTH} characters
 * in a fenced block that is not `text` and has no exemption, and each exemption on a block that
 * needs none. `file` is the repository path, for the messages.
 */
export function codeWidthProblems(file: string, text: string): string[] {
  const lines = text.split("\n");
  const problems: string[] = [];
  for (const fence of parse(text).fences) {
    const before = lines.slice(0, fence.index).findLastIndex((line) => line.trim() !== "");
    const exempt = before !== -1 && CODE_WIDTH_EXEMPTION.test(String(lines[before]).trim());
    const long = WRAPPED_LANGUAGES.has(fence.lang)
      ? []
      : fence.lines.flatMap((line, offset) => {
          const width = [...GRAPHEMES.segment(line)].length;
          return width > MAX_CODE_WIDTH ? [{ line: fence.index + offset + 2, width }] : [];
        });
    if (exempt && long.length === 0) {
      problems.push(
        `${file}:${before + 1}: a code-width exemption on a block with no line over ${MAX_CODE_WIDTH} characters; remove it (${STYLE_GUIDE})`,
      );
    } else if (!exempt) {
      for (const { line, width } of long) {
        problems.push(
          `${file}:${line}: a code line of ${width} characters; wrap it at ${MAX_CODE_WIDTH}, a shell line with \\, or put <!-- code-width: the reason --> before the block (${STYLE_GUIDE})`,
        );
      }
    }
  }
  return problems;
}

/**
 * The style problems of one user page. `file` is the repository path, such as
 * `docs/user/guides/x.md`, and `page` the path under `docs/user/`.
 */
export function styleProblems(file: string, page: string, text: string): string[] {
  const parsed = parse(text);
  const problems: string[] = codeWidthProblems(file, text);
  const report = (line: number, message: string): void => {
    problems.push(`${file}:${line}: ${message} (${STYLE_GUIDE})`);
  };
  const legacy = legacyLine(text);
  if (legacy !== undefined) {
    report(legacy, "the legacy marker no longer exempts a page; remove it and fix the page");
  }
  const { average } = densityOf(parsed.blocks);
  if (average > MAX_AVERAGE) {
    report(1, `an average of ${average} words per block; keep it at most ${MAX_AVERAGE}`);
  }
  for (const block of parsed.blocks) {
    const words = wordCount(block.text);
    if (words > MAX_WORDS) {
      report(
        block.line,
        `a ${block.kind === "item" ? "list item" : block.kind} of ${words} words; keep it near 50 and at most ${MAX_WORDS}`,
      );
    }
    const spans = codeSpansPerSentence(block.text);
    if (spans > MAX_CODE_SPANS) {
      report(
        block.line,
        `a sentence with ${spans} code spans; use at most ${MAX_CODE_SPANS}, or a list or a table`,
      );
    }
    if (block.kind === "paragraph" && LABEL_CALLOUT.test(block.text)) {
      report(block.line, "a labelled callout; use a GitHub alert such as > [!NOTE]");
    }
  }
  for (const [index, line] of parsed.bare) {
    if (DATED_CITATION.test(line) && sectionOf(parsed, index) !== SOURCES) {
      report(index + 1, `a dated citation outside the "${SOURCES}" H2; move it there`);
    }
  }
  for (const fence of parsed.fences) {
    const problem = introProblem(parsed, fence);
    if (problem !== undefined) {
      report(fence.index + 1, problem);
    }
    if (SHELL_LANGUAGES.has(fence.lang)) {
      for (const [offset, line] of fence.lines.entries()) {
        if (BARE_COMMAND.test(line.trim())) {
          report(
            fence.index + offset + 2,
            "a bare explorer-verify command; start it with npx @explorer-verify/cli",
          );
        }
      }
    }
  }
  if (isGuide(page)) {
    const head = [...parsed.prose].filter(([index]) => index < GUIDE_HEAD_LINES);
    for (const label of ["For:", "You need:"]) {
      if (!head.some(([, line]) => line.trim().startsWith(`${label} `))) {
        report(1, `a guide needs a "${label}" line in its first ${GUIDE_HEAD_LINES} lines`);
      }
    }
    const last = parsed.h2.at(-1);
    if (last?.text !== NEXT_STEPS) {
      report(
        last === undefined ? 1 : last.index + 1,
        `a guide ends with a "${NEXT_STEPS}" H2; the last H2 is ${last === undefined ? "missing" : `"${last.text}"`}`,
      );
    }
  }
  return problems;
}

/** The user pages under `root`, each with its path under `docs/user/` and its text. */
function userPages(root: string): { file: string; page: string; text: string }[] {
  return listFiles(root, USER_DOCS, ".md").map((file) => ({
    file,
    page: path.posix.relative(USER_DOCS, file),
    text: readFileSync(path.join(root, file), "utf8"),
  }));
}

/**
 * Every style problem of the user pages under `root`, and the code width problems of the skills
 * and {@link CODE_WIDTH_FILES}; empty when they pass.
 */
export function checkDocsStyle(root: string): string[] {
  const others = [...listFiles(root, SKILLS, ".md"), ...CODE_WIDTH_FILES].filter((file) =>
    existsSync(path.join(root, file)),
  );
  return [
    ...userPages(root).flatMap(({ file, page, text }) => styleProblems(file, page, text)),
    ...others.flatMap((file) =>
      codeWidthProblems(file, readFileSync(path.join(root, file), "utf8")),
    ),
  ];
}

/**
 * One line per user page under `root`: its paragraphs, list items and quotes, and their average and
 * longest word count.
 */
export function densityReport(root: string): string[] {
  return userPages(root).map(({ page, text }) => {
    const { blocks, average, longest } = pageDensity(text);
    return `${page}: ${blocks} blocks, average ${average} words, longest ${longest}`;
  });
}
