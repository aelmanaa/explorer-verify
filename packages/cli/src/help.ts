// References: R-AX-11, R-AX-2.
/**
 * The help of the CLI and of each command: examples first, then the usage, the options,
 * the environment variables, the exit codes, and links to the docs and `llms.txt`. One
 * {@link HelpResult} feeds the text on stdout, the `--json` envelope and the generated CLI
 * reference, so the three never disagree.
 */
import type { ExitCode } from "explorer-verify/envelope";

import { commandOptions, GLOBAL_OPTIONS, HELP_WORD } from "./arguments.ts";
import type { OptionSpec, OptionSpecs } from "./arguments.ts";
import type { Command, Example } from "./command.ts";
import { KEY_VARIABLES } from "./keys.ts";
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
  { name: "CI", description: "Any value but empty turns the spinner off." },
  ...KEY_VARIABLES.map(({ name, backend, host }) => ({
    name,
    description: `The API key of ${backend}, sent only to ${host}. Empty counts as unset.`,
  })),
];

/** One exit code and what it means. */
export interface ExitCodeHelp {
  readonly code: ExitCode;
  readonly meaning: string;
}

// References: R-AX-7.
/** Every exit code of the CLI, in order. The tests check it against the catalogue. */
export const EXIT_CODES: readonly ExitCodeHelp[] = [
  {
    code: 0,
    meaning:
      "Verified: verified or already-verified. With result.storedContract, the explorer holds another contract's source, not yours. Help and the version also exit 0",
  },
  { code: 1, meaning: "Failed: the explorer definitively rejected the submission" },
  { code: 2, meaning: "Usage or input error: nothing was submitted for verification" },
  { code: 3, meaning: "API key: missing, invalid or under-privileged" },
  {
    code: 4,
    meaning:
      "No verdict yet: not-confirmed (the output carries the handle), verification-inconclusive, not-indexed (the explorer has not indexed the contract yet) or proxy-link-pending (SDK only)",
  },
  { code: 5, meaning: "Network: the explorer was unavailable after retries" },
  {
    code: 6,
    meaning:
      "Unknown state: unknown-state (the output carries the handle), proxy-link-unknown-state (SDK only), or internal-error, a bug in the CLI. Do not retry automatically",
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
  return {
    name: command.name,
    summary: command.summary,
    usage: usageLine(command, command.usage),
    examples: command.examples.map(exampleHelp),
    options: optionsHelp(commandOptions(command)),
  };
}

// References: R-AX-11.
/**
 * The usage lines of a command, one for each way to call it, each ending in `[options]`. They name
 * the arguments and options the command needs.
 *
 * @param command - The command.
 * @returns The lines, starting with `explorer-verify`.
 */
export function usageLines(command: Command): string[] {
  return [command.usage, ...(command.moreUsage ?? [])].map((usage) => usageLine(command, usage));
}

/** One usage line of a command, from the text after its name. */
function usageLine(command: Command, usage: string): string {
  return `${PROGRAM} ${command.name}${usage === "" ? "" : ` ${usage}`} [options]`;
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
      usage: usageLines(topic),
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

// References: R-AX-12.
/**
 * The help as text for stdout. Every line ends in a newline, and nothing depends on the terminal,
 * so the same command gives the same bytes.
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
    // The global sections are the same for every command: the CLI's own help lists them.
    lines.push(
      `Global options, environment variables and exit codes: ${PROGRAM} --help`,
      `Docs: ${help.docsUrl}`,
    );
    return `${lines.join("\n")}\n`;
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

/** How many examples the short help shows. */
const SHORT_EXAMPLES = 2;

// References: R-AX-11.
/**
 * The short help that a bare `explorer-verify`, or a command typed with nothing after it, prints
 * on stderr before it exits 2: the usage, two examples, and where the full help is.
 *
 * @param help - The help of the CLI or of the command.
 * @returns The text.
 */
export function shortHelpText(help: HelpResult): string {
  const name = help.topic === null ? PROGRAM : `${PROGRAM} ${help.topic}`;
  // The CLI's own short help shows each command's first example, not the help and version ones.
  const examples =
    help.topic === null
      ? help.commands.flatMap((command) => command.examples.slice(0, 1))
      : help.examples;
  const lines = [`${name}: ${help.summary}`, "", "Usage:", ...help.usage.map((u) => `  ${u}`)];
  lines.push("", "Examples:");
  for (const example of examples.slice(0, SHORT_EXAMPLES)) {
    lines.push(`  ${example.command}`, `      ${example.description}`);
  }
  const full = help.topic === null ? `${PROGRAM} --help` : `${PROGRAM} ${HELP_WORD} ${help.topic}`;
  lines.push("", `Every option: ${full}`);
  return `${lines.join("\n")}\n`;
}
