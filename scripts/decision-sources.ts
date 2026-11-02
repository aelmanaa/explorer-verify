// The sources rule for decisions and research, used by scripts/check-agent-docs.ts.
//
// The rules:
// - Each decision record (`docs/contributor/decisions/NNNN-*.md`) has a relative link to a research
//   note in `docs/contributor/research/`, or the line `Research: none (maintainer choice).`
// - Each research link in a decision record points to a note that exists. A link to the research
//   index (README.md or the folder) is allowed and does not count as research.
// - The `Research: none` line and every link count only outside fenced code and HTML comments.
// - Each research note (a Markdown file in `docs/contributor/research/` other than README.md) has
//   a `## Sources` section with at least one http or https link: a Markdown link or a bare URL
//   (GitHub links bare URLs), outside code.
// - Each research note is linked from `docs/contributor/research/README.md`.
import { readFileSync } from "node:fs";
import path from "node:path";

import { forEachProseLine, listFiles, markdownLinks } from "./agent-docs.ts";

/** The folder of the decision records. */
export const DECISIONS = "docs/contributor/decisions";
/** The folder of the research notes. */
export const RESEARCH = "docs/contributor/research";
/** The index of the research notes. */
export const RESEARCH_INDEX: string = `${RESEARCH}/README.md`;
/** The exact line a decision record carries when no research backs it. */
export const NO_RESEARCH_LINE = "Research: none (maintainer choice).";

const RECORD = /^\d{4}-[^/]*\.md$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** An http or https URL: a Markdown link target, an angle-bracket link or a bare URL. */
const WEB_URL = /(?:^|[\s(<|])https?:\/\/[^\s>)|]+/i;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The files directly in `folder` (no subfolders) whose names end with `.md`. */
function markdownIn(root: string, folder: string): string[] {
  return listFiles(root, folder, ".md").filter(
    (file) => !path.posix.relative(folder, file).includes("/"),
  );
}

/** The repository paths of the relative links in `file`, without fragments, with their lines. */
function relativeTargets(file: string, text: string): { line: number; target: string }[] {
  return markdownLinks(text).flatMap(({ line, target }) => {
    if (SCHEME.test(target) || target.startsWith("//") || target.startsWith("#")) {
      return [];
    }
    const linked = target.replace(/#.*$/s, "");
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(file), linked))
      .replace(/(.)\/$/, "$1");
    return [{ line, target: resolved }];
  });
}

/**
 * The text of the `## Sources` section of a Markdown text, or undefined when it has none. Fenced
 * code is left out and inline code spans are blanked, so a URL in code does not count.
 */
export function sourcesSection(text: string): string | undefined {
  const lines: string[] = [];
  let inside = false;
  let found = false;
  forEachProseLine(text, (line, _index, raw) => {
    const heading = HEADING.exec(raw);
    if (heading !== null && String(heading[1]).length <= 2) {
      inside = String(heading[1]).length === 2 && String(heading[2]) === "Sources";
      found ||= inside;
      return;
    }
    if (inside) {
      lines.push(line);
    }
  });
  return found ? lines.join("\n") : undefined;
}

/** Problems with the research links of one decision record. */
function checkDecision(file: string, text: string, notes: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const research = relativeTargets(file, text).filter(
    ({ target }) => target.startsWith(`${RESEARCH}/`) && target !== RESEARCH_INDEX,
  );
  for (const { line, target } of research) {
    if (!notes.has(target)) {
      problems.push(`${file}:${line}: links ${target}, which is not a research note`);
    }
  }
  let none = false;
  forEachProseLine(text, (_line, _index, raw) => {
    none ||= raw.trimEnd() === NO_RESEARCH_LINE;
  });
  if (none && research.length > 0) {
    problems.push(`${file}: links research and also says \`${NO_RESEARCH_LINE}\`; keep one`);
  } else if (!none && research.length === 0) {
    problems.push(
      `${file}: links no research note; link the notes it relies on, or add the line \`${NO_RESEARCH_LINE}\``,
    );
  }
  return problems;
}

/** Problems with one research note. */
function checkNote(file: string, text: string, listed: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const sources = sourcesSection(text);
  if (sources === undefined) {
    problems.push(`${file}: has no \`## Sources\` section`);
  } else if (!WEB_URL.test(sources)) {
    problems.push(`${file}: the \`## Sources\` section has no http or https URL`);
  }
  if (!listed.has(file)) {
    problems.push(`${file}: not listed in ${RESEARCH_INDEX}`);
  }
  return problems;
}

/** Every problem with the decision and research sources rule; empty when the docs pass. */
export function checkDecisionSources(root: string): string[] {
  const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
  const markdown = markdownIn(root, RESEARCH);
  const notes = new Set(markdown.filter((file) => file !== RESEARCH_INDEX));
  const problems: string[] = [];
  for (const file of markdownIn(root, DECISIONS)) {
    if (RECORD.test(path.posix.basename(file))) {
      problems.push(...checkDecision(file, read(file), notes));
    }
  }
  const listed = new Set(
    markdown.includes(RESEARCH_INDEX)
      ? relativeTargets(RESEARCH_INDEX, read(RESEARCH_INDEX)).map(({ target }) => target)
      : [],
  );
  for (const note of notes) {
    problems.push(...checkNote(note, read(note), listed));
  }
  return problems;
}
