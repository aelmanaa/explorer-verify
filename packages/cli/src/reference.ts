// References: R-AX-2.
/**
 * The generated parts of the CLI reference, `docs/user/reference/cli.md`, and of the CLI output
 * page, `cli-output.md`. They render the same {@link HelpResult} the `--help` text shows, so the
 * pages cannot drift from the code:
 * `scripts/generate-cli-reference.ts` writes them, and `pnpm run check` fails when a committed page
 * differs. The tables are padded the way the formatter pads them, so a formatted page still
 * matches.
 */
import { CHAIN_NAMES } from "./chains.ts";
import type { Command } from "./command.ts";
import { commandHelp, helpResult, optionLabel } from "./help.ts";
import type { CommandHelp, OptionHelp } from "./help.ts";

/** The line before the generated part. */
export const START_MARKER =
  "<!-- Generated from the CLI's help by scripts/generate-cli-reference.ts. Edit the command table, not this part. -->";

/** The line after the generated part. */
export const END_MARKER = "<!-- End of the generated part. -->";

/** A table cell: pipes escaped, so a description cannot break the table. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** A Markdown table with every column padded to its widest cell, at least 3 characters. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const head = header.map(cell);
  const body = rows.map((row) => row.map(cell));
  const widths = head.map((title, column) =>
    Math.max(3, title.length, ...body.map((row) => String(row[column]).length)),
  );
  const line = (row: readonly string[]): string =>
    `| ${widths.map((width, column) => String(row[column]).padEnd(width)).join(" | ")} |`;
  return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)];
}

/** An option as the reference writes it, such as `` `-q`, `--quiet` ``. */
function optionCode(option: OptionHelp): string {
  return optionLabel(option)
    .split(", ")
    .map((part) => `\`${part}\``)
    .join(", ");
}

/** The table of a list of options. */
function optionTable(options: readonly OptionHelp[]): string[] {
  return table(
    ["Option", "What it does"],
    options.map((option) => [
      optionCode(option),
      option.repeatable ? `${option.description} Repeatable.` : option.description,
    ]),
  );
}

/** The widest line of a generated code block: wider lines scroll on the docs site. */
export const USAGE_WIDTH = 72;

/**
 * A usage line folded to {@link USAGE_WIDTH} columns. It breaks only before an option, a group in
 * parentheses or a part in brackets, and indents each continuation line by two spaces.
 *
 * @param usage - The usage line.
 * @returns Its lines.
 */
export function foldUsage(usage: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of usage.split(/ (?=--|\(|\[)/)) {
    if (line === "") {
      line = part;
    } else if (line.length + 1 + part.length <= USAGE_WIDTH) {
      line = `${line} ${part}`;
    } else {
      lines.push(line);
      line = `  ${part}`;
    }
  }
  return [...lines, line];
}

/**
 * The section of one command: its usage and its options. A hidden command, which the table of
 * commands does not list, also gets its summary.
 */
function commandSection(help: CommandHelp, summary: boolean): string[] {
  const lines = [`### \`${help.name}\``, "", ...(summary ? [help.summary, ""] : [])];
  lines.push("Usage:", "", "```text", ...foldUsage(help.usage), "```", "");
  if (help.options.length > 0) {
    lines.push(...optionTable(help.options), "");
  }
  return lines;
}

/**
 * The generated part of the CLI reference, markers included: the usage, the commands with their
 * options, and the chain names.
 *
 * @param commands - The command table.
 * @returns The Markdown, ending in a newline.
 */
export function referenceBlock(commands: readonly Command[]): string {
  const help = helpResult(commands);
  const rows = chainRows();
  const lines = [START_MARKER, "", "## Usage", "", "Run a command, or print the help:", ""];
  lines.push("```text", ...help.usage.flatMap(foldUsage), "```", "");
  if (help.commands.length === 0) {
    lines.push("This version has no public commands yet.", "");
  } else {
    lines.push(
      ...table(
        ["Command", "What it does"],
        help.commands.map((command) => [`\`${command.name}\``, command.summary]),
      ),
      "",
    );
  }
  for (const command of commands.filter((each) => each.hidden !== true)) {
    lines.push(...commandSection(commandHelp(command), false));
  }
  const hidden = commands.filter((each) => each.hidden === true);
  if (hidden.length > 0) {
    lines.push(
      "## Hidden commands",
      "",
      "Usage messages and the CLI's own help do not list these commands, and a later release removes them. `explorer-verify help <command>` still shows their help.",
      "",
    );
    for (const command of hidden) {
      lines.push(...commandSection(commandHelp(command), true));
    }
  }
  lines.push(
    "## Chain names",
    "",
    "`--chain` takes these names, in any case, as well as any chain ID.",
    "",
    // Folded, so the long table does not push the rest of the page down.
    "<details>",
    `<summary>The names of ${String(rows.length)} chains</summary>`,
    "",
    ...table(["Names", "Chain ID"], rows),
    "",
    "</details>",
    "",
    END_MARKER,
  );
  return `${lines.join("\n")}\n`;
}

/** One row for each chain ID, with its names in help order. */
function chainRows(): string[][] {
  const names = new Map<number, string[]>();
  for (const [name, chainId] of CHAIN_NAMES) {
    names.set(chainId, [...(names.get(chainId) ?? []), `\`${name}\``]);
  }
  return [...names].map(([chainId, each]) => [each.join(", "), String(chainId)]);
}

/**
 * The generated part of the CLI output page, `docs/user/reference/cli-output.md`, markers
 * included: the global options, the environment variables and the exit codes.
 *
 * @param commands - The command table.
 * @returns The Markdown, ending in a newline.
 */
export function outputBlock(commands: readonly Command[]): string {
  const help = helpResult(commands);
  const lines = [START_MARKER, "", "## Global options", "", ...optionTable(help.globalOptions), ""];
  lines.push(
    "## Environment variables",
    "",
    ...table(
      ["Variable", "What it does"],
      help.environment.map((variable) => [`\`${variable.name}\``, variable.description]),
    ),
    "",
    "## Exit codes",
    "",
    ...table(
      ["Code", "Meaning"],
      help.exitCodes.map((exit) => [String(exit.code), exit.meaning]),
    ),
    "",
    "[Errors](errors/index.md#exit-codes) lists the error codes behind each exit code.",
    "",
    END_MARKER,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The page with its generated part replaced by `block`.
 *
 * @param page - The page as committed.
 * @param block - The generated part, from {@link referenceBlock} or {@link outputBlock}.
 * @returns The new page.
 * @throws Error when the page does not hold each marker exactly once, start first.
 */
export function replaceBlock(page: string, block: string): string {
  const start = page.indexOf(START_MARKER);
  const end = page.indexOf(END_MARKER);
  const once =
    start !== -1 &&
    end > start &&
    page.indexOf(START_MARKER, start + 1) === -1 &&
    page.indexOf(END_MARKER, end + 1) === -1;
  if (!once) {
    throw new Error("The CLI reference must hold each marker of the generated part once.");
  }
  const after = end + END_MARKER.length + (page[end + END_MARKER.length] === "\n" ? 1 : 0);
  return `${page.slice(0, start)}${block}${page.slice(after)}`;
}
