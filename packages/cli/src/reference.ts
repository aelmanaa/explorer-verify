// References: R-AX-2.
/**
 * The generated part of the CLI reference, `docs/user/reference/cli.md`. It renders the
 * same {@link HelpResult} the `--help` text shows, so the page cannot drift from the code:
 * `scripts/generate-cli-reference.ts` writes it, and `pnpm run check` fails when the committed page
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

/** The section of one command. */
function commandSection(help: CommandHelp): string[] {
  const lines = [`### \`${help.name}\``, "", help.summary, ""];
  lines.push("```text", help.usage, "```", "", "Examples:", "");
  for (const example of help.examples) {
    lines.push(`- \`${example.command}\`: ${example.description}`);
  }
  lines.push("");
  if (help.options.length > 0) {
    lines.push(...optionTable(help.options), "");
  }
  return lines;
}

/**
 * The generated part of the CLI reference, markers included.
 *
 * @param commands - The command table.
 * @returns The Markdown, ending in a newline.
 */
export function referenceBlock(commands: readonly Command[]): string {
  const help = helpResult(commands);
  const lines = [START_MARKER, "", "## Usage", "", "```text", ...help.usage, "```", ""];
  lines.push("## Examples", "");
  for (const example of help.examples) {
    lines.push(`- \`${example.command}\`: ${example.description}`);
  }
  lines.push("", "## Commands", "");
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
    lines.push(...commandSection(commandHelp(command)));
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
      lines.push(...commandSection(commandHelp(command)));
    }
  }
  lines.push("## Global options", "", ...optionTable(help.globalOptions), "");
  lines.push(
    "## Environment variables",
    "",
    ...table(
      ["Variable", "What it does"],
      help.environment.map((variable) => [`\`${variable.name}\``, variable.description]),
    ),
    "",
  );
  lines.push(
    "## Exit codes",
    "",
    ...table(
      ["Code", "Meaning"],
      help.exitCodes.map((exit) => [String(exit.code), exit.meaning]),
    ),
    "",
    "[Errors](errors/index.md#exit-codes) lists the error codes behind each exit code.",
    "",
    "## Chain names",
    "",
    "`--chain` takes these names, in any case, as well as any chain ID.",
    "",
    ...table(
      ["Name", "Chain ID"],
      [...CHAIN_NAMES].map(([name, chainId]) => [`\`${name}\``, String(chainId)]),
    ),
    "",
    END_MARKER,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The page with its generated part replaced by `block`.
 *
 * @param page - The page as committed.
 * @param block - The generated part, from {@link referenceBlock}.
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
