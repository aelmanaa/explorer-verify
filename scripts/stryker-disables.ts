// Rules for the Stryker comments that mark equivalent mutants in shipped code, and the list of
// them in docs/contributor/testing.md. scripts/check-stryker-disables.ts applies them.
//
// Stryker has no per-mutant ignore in its config, so an equivalent mutant is recorded in the
// source, on the line before it. Each comment must be
// `// Stryker disable next-line <Mutator>[,<Mutator>]: <reason>`: a disable without `next-line`
// can last to the end of the file, and `all` skips mutants nobody looked at.

/** One recorded equivalent mutant. */
export interface Disable {
  /** The file, relative to the repository root. */
  readonly file: string;
  /** The line of the comment, from 1. */
  readonly line: number;
  /** The Stryker mutator names the comment skips on the next line. */
  readonly mutators: readonly string[];
  /** Why the skipped mutants are equivalent. */
  readonly reason: string;
}

/** The mutators of StrykerJS 10 for JavaScript and TypeScript. */
export const MUTATORS: readonly string[] = [
  "ArithmeticOperator",
  "ArrayDeclaration",
  "ArrowFunction",
  "AssignmentOperator",
  "BlockStatement",
  "BooleanLiteral",
  "ConditionalExpression",
  "EqualityOperator",
  "LogicalOperator",
  "MethodExpression",
  "ObjectLiteral",
  "OptionalChaining",
  "Regex",
  "StringLiteral",
  "UnaryOperator",
  "UpdateOperator",
];

const FORM = /^\s*\/\/ Stryker disable next-line ([A-Za-z]+(?:,[A-Za-z]+)*): (\S.*)$/;
const ANY = /Stryker\s+(?:disable|restore)/;

/**
 * The Stryker comments of one file and the problems with them. A line that mentions
 * `Stryker disable` or `Stryker restore` in any other form is a problem.
 */
export function parseDisables(
  file: string,
  text: string,
): { disables: Disable[]; problems: string[] } {
  const disables: Disable[] = [];
  const problems: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!ANY.test(line)) {
      continue;
    }
    const where = `${file}:${String(index + 1)}`;
    const match = FORM.exec(line);
    if (match === null) {
      problems.push(
        `${where}: write it as \`// Stryker disable next-line <Mutator>[,<Mutator>]: <reason>\``,
      );
      continue;
    }
    // Both groups always take part in a match.
    const mutators = String(match[1]).split(",");
    const unknown = mutators.filter((name) => !MUTATORS.includes(name));
    if (unknown.length > 0) {
      problems.push(`${where}: unknown mutator ${unknown.join(", ")}; name the mutators to skip`);
      continue;
    }
    disables.push({ file, line: index + 1, mutators, reason: String(match[2]).trim() });
  }
  return { disables, problems };
}

/** One line per comment for the terminal: `file:line  Mutators  reason`. */
export function formatInventory(disables: readonly Disable[]): string {
  return disables
    .map(
      ({ file, line, mutators, reason }) =>
        `${file}:${String(line)}  ${mutators.join(",")}  ${reason}\n`,
    )
    .join("");
}

/**
 * The rows of the table in testing.md: file, mutators and reason, in source order. Line numbers
 * are left out, so an edit elsewhere in a file does not change the table.
 */
export function tableRows(disables: readonly Disable[]): string[][] {
  return disables.map(({ file, mutators, reason }) => [
    `\`${file}\``,
    mutators.join(", "),
    reason.replaceAll("|", String.raw`\|`),
  ]);
}

export const START = "<!-- stryker-disables:start -->";
export const END = "<!-- stryker-disables:end -->";
const HEADER = ["File", "Mutators", "Why the mutants are equivalent"];

/** One Markdown table row. */
function tableLine(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** The table as Markdown, unpadded; the formatter pads it. */
export function formatTable(rows: readonly string[][]): string {
  return [tableLine(HEADER), tableLine(HEADER.map(() => "---")), ...rows.map(tableLine)].join("\n");
}

/** The cells of each row of a Markdown table, header and separator dropped, padding trimmed. */
export function readTable(markdown: string): string[][] {
  const rows = markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
  return rows.slice(2);
}

/** The text between the markers, or `undefined` when either is missing. */
export function section(doc: string): string | undefined {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end < start) {
    return undefined;
  }
  return doc.slice(start + START.length, end);
}

/** `doc` with the text between the markers replaced by the table of `rows`. */
export function withTable(doc: string, rows: readonly string[][]): string {
  const old = section(doc);
  if (old === undefined) {
    throw new Error(`the document has no ${START} … ${END} section`);
  }
  return doc.replace(`${START}${old}${END}`, `${START}\n\n${formatTable(rows)}\n\n${END}`);
}
