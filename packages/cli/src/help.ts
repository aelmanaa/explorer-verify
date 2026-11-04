/**
 * The help of the CLI and of each command (R-AX-11): examples first, then the usage, the options,
 * the environment variables, the exit codes, and links to the docs and `llms.txt`. One
 * {@link HelpResult} feeds the text on stdout, the `--json` envelope and the generated CLI
 * reference, so the three never disagree (R-AX-2).
 */
import type { ExitCode } from "explorer-verify";

import { GLOBAL_OPTIONS, HELP_WORD } from "./arguments.ts";
import type { OptionSpec, OptionSpecs } from "./arguments.ts";
import type { Command, Example } from "./command.ts";
import { LOG_LEVELS, LOG_VARIABLE } from "./log-level.ts";

/** The CLI reference on the docs site. */
export const DOCS_URL = "https://aelmanaa.github.io/explorer-verify/reference/cli";

/** The index of the docs for agents. */
export const LLMS_URL = "https://aelmanaa.github.io/explorer-verify/llms.txt";

/** The program name. */
const PROGRAM = "explorer-verify";

/** What the CLI does, in one line. */
const SUMMARY = "Verify the source of deployed smart contracts on block explorers.";

/** One environment variable the CLI reads. */
export interface VariableHelp {
  readonly name: string;
  readonly description: string;
}

/** The environment variables the CLI reads, in help order. */
export const ENVIRONMENT: readonly VariableHelp[] = [
  {
    name: LOG_VARIABLE,
    description: `The stderr log level when no flag sets one: ${LOG_LEVELS.join(", ")}.`,
  },
  { name: "NO_COLOR", description: "Any value but empty turns colour off under --color auto." },
  { name: "TERM", description: "dumb turns colour and the spinner off under --color auto." },
  { name: "CI", description: "Any value but empty turns the spinner and the pager off." },
];

/** One exit code and what it means. */
export interface ExitCodeHelp {
  readonly code: ExitCode;
  readonly meaning: string;
}

/** Every exit code of the CLI, in order (R-AX-7). The tests check it against the catalogue. */
export const EXIT_CODES: readonly ExitCodeHelp[] = [
  { code: 0, meaning: "Verified: verified or already-verified. Help and the version also exit 0" },
  { code: 1, meaning: "Failed: the explorer definitively rejected the submission" },
  { code: 2, meaning: "Usage or input error: nothing was submitted for verification" },
  { code: 3, meaning: "API key: missing, invalid or under-privileged" },
  {
    code: 4,
    meaning:
      "No verdict yet: not-confirmed (the output carries the handle) or verification-inconclusive",
  },
  { code: 5, meaning: "Network: the explorer was unavailable after retries" },
  {
    code: 6,
    meaning:
      "Unknown state: unknown-state (the output carries the handle) or internal-error, a bug in the CLI. Do not retry automatically",
  },
  { code: 130, meaning: "Cancelled: SIGINT or SIGTERM stopped the run" },
];

/** The examples of the CLI's own help, before the first example of each command. */
const CLI_EXAMPLES: readonly Example[] = [
  {
    args: "--version --json",
    description: "Print the CLI and core versions and the routing table's date as one envelope.",
  },
  {
    args: "help --json",
    description:
      "List the commands, options, environment variables and exit codes as one envelope.",
  },
];

/** One option in the help. */
export interface OptionHelp {
  /** The long name with its dashes, such as `--log-format`. */
  readonly name: string;
  /** The short alias with its dash, such as `-q`. */
  readonly short?: string;
  /** The placeholder of the value, such as `<mode>`. Absent when the option takes none. */
  readonly value?: string;
  /** Whether the option may repeat. */
  readonly repeatable: boolean;
  readonly description: string;
}

/** One example in the help. */
interface ExampleHelp {
  /** The whole command line, starting with `explorer-verify`. */
  readonly command: string;
  readonly description: string;
}

/** One command in the help. */
export interface CommandHelp {
  readonly name: string;
  readonly summary: string;
  /** The usage line, starting with `explorer-verify`. */
  readonly usage: string;
  readonly examples: readonly ExampleHelp[];
  /** The command's own options; the global ones are in {@link HelpResult.globalOptions}. */
  readonly options: readonly OptionHelp[];
}

/** The `result` of the help envelope (`help.schema.json`). */
export interface HelpResult {
  /** The command the help is about, or `null` for the CLI's own help. */
  readonly topic: string | null;
  readonly summary: string;
  readonly usage: readonly string[];
  /** The examples, first in the text. */
  readonly examples: readonly ExampleHelp[];
  /** The public commands, or only the topic. */
  readonly commands: readonly CommandHelp[];
  readonly globalOptions: readonly OptionHelp[];
  readonly environment: readonly VariableHelp[];
  readonly exitCodes: readonly ExitCodeHelp[];
  readonly docsUrl: string;
  readonly llmsUrl: string;
}

/** The help of each option, in table order. */
function optionsHelp(options: OptionSpecs): OptionHelp[] {
  return Object.entries(options).map(([name, spec]: [string, OptionSpec]) => ({
    name: `--${name}`,
    ...(spec.short === undefined ? {} : { short: `-${spec.short}` }),
    ...(spec.type === "string" ? { value: spec.value ?? "<value>" } : {}),
    repeatable: spec.multiple === true,
    description: spec.description,
  }));
}

/** An example as the help shows it. */
function exampleHelp(example: Example): ExampleHelp {
  return { command: `${PROGRAM} ${example.args}`, description: example.description };
}

/**
 * The help of one command.
 *
 * @param command - The command.
 * @returns Its summary, usage, examples and options.
 */
export function commandHelp(command: Command): CommandHelp {
  const positionals = command.usage === "" ? "" : ` ${command.usage}`;
  return {
    name: command.name,
    summary: command.summary,
    usage: `${PROGRAM} ${command.name}${positionals} [options]`,
    examples: command.examples.map(exampleHelp),
    options: optionsHelp(command.options),
  };
}

/**
 * The help of the CLI, or of one command.
 *
 * @param commands - The command table.
 * @param topic - The command the help is about, or `undefined` for the CLI's own help.
 * @returns The help, the same for the text and the envelope.
 */
export function helpResult(commands: readonly Command[], topic?: Command): HelpResult {
  const shared = {
    globalOptions: optionsHelp(GLOBAL_OPTIONS),
    environment: ENVIRONMENT,
    exitCodes: EXIT_CODES,
    docsUrl: DOCS_URL,
    llmsUrl: LLMS_URL,
  };
  if (topic !== undefined) {
    const help = commandHelp(topic);
    return {
      topic: topic.name,
      summary: topic.summary,
      usage: [help.usage],
      examples: help.examples,
      commands: [help],
      ...shared,
    };
  }
  const visible = commands.filter((command) => command.hidden !== true).map(commandHelp);
  return {
    topic: null,
    summary: SUMMARY,
    usage: [`${PROGRAM} <command> [options]`, `${PROGRAM} ${HELP_WORD} [<command>]`],
    examples: [
      ...CLI_EXAMPLES.map(exampleHelp),
      ...visible.flatMap((command) => command.examples.slice(0, 1)),
    ],
    commands: visible,
    ...shared,
  };
}

/** Two columns: each name padded to the longest, then its text. */
function columns(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, text]) => `  ${name.padEnd(width)}  ${text}`);
}

/** How an option is written in the help, such as `-q, --quiet` or `--color <mode>`. */
export function optionLabel(option: OptionHelp): string {
  const long = option.value === undefined ? option.name : `${option.name} ${option.value}`;
  return option.short === undefined ? long : `${option.short}, ${long}`;
}

/** The lines of an option table. */
function optionLines(options: readonly OptionHelp[]): string[] {
  return columns(
    options.map((option) => [
      optionLabel(option),
      option.repeatable ? `${option.description} Repeatable.` : option.description,
    ]),
  );
}

/**
 * The help as text for stdout. Every line ends in a newline, and nothing depends on the terminal,
 * so the same command gives the same bytes (R-AX-12).
 *
 * @param help - The help.
 * @returns The text.
 */
export function helpText(help: HelpResult): string {
  const name = help.topic === null ? PROGRAM : `${PROGRAM} ${help.topic}`;
  const lines = [`${name}: ${help.summary}`, "", "Examples:"];
  for (const example of help.examples) {
    lines.push(`  ${example.command}`, `      ${example.description}`);
  }
  lines.push("", "Usage:", ...help.usage.map((usage) => `  ${usage}`), "");
  if (help.topic === null) {
    lines.push("Commands:");
    lines.push(
      ...(help.commands.length === 0
        ? ["  This version has no public commands yet."]
        : columns(help.commands.map((command) => [command.name, command.summary]))),
    );
    lines.push("");
  } else {
    for (const command of help.commands) {
      if (command.options.length > 0) {
        lines.push("Options:", ...optionLines(command.options), "");
      }
    }
  }
  lines.push("Global options:", ...optionLines(help.globalOptions), "");
  lines.push(
    "Environment variables:",
    ...columns(help.environment.map((variable) => [variable.name, variable.description])),
    "",
  );
  lines.push(
    "Exit codes:",
    ...columns(help.exitCodes.map((exit) => [String(exit.code), exit.meaning])),
    "",
  );
  lines.push(`Docs: ${help.docsUrl}`, `Docs index for agents: ${help.llmsUrl}`);
  return `${lines.join("\n")}\n`;
}
