/**
 * Reads the command line with `util.parseArgs` in its non-strict, token mode, which never throws,
 * then checks the tokens itself. So `--json` is known before any usage error (R-AX-5), and no
 * error message repeats text the caller typed: an option's value, or a mistyped name, may be a key
 * (R-AX-9). An issue names the CLI's own option names, or the position of an argument.
 */
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import type { InputIssue } from "explorer-verify";

import { REFUSED_KEY_MESSAGE, REFUSED_KEY_OPTIONS, ROUTE_OPTIONS } from "./keys.ts";
import { closest } from "./suggest.ts";

/** One option a command or the CLI accepts. */
export interface OptionSpec {
  /** `string` takes a value; `boolean` takes none. */
  type: "string" | "boolean";
  /** A one-letter alias, such as `q` for `--quiet`. */
  short?: string;
  /** Whether the option may repeat; its values then form a list. */
  multiple?: boolean;
  /**
   * Whether giving the option twice is an issue, instead of keeping the last value: for an option
   * whose repeat a caller could read as a request for more, such as `--backend`.
   */
  once?: boolean;
  /** The placeholder of a string option's value in the help text, such as `<mode>`. */
  value?: string;
  /** One line for the help text. */
  description: string;
}

/** Options by their long name, without the leading `--`. */
export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

/** The value of one option after the checks. */
export type OptionValue = string | boolean | readonly string[];

/** What the reader needs to know of a command. */
export interface CommandSpec {
  /** The name typed after `explorer-verify`. */
  readonly name: string;
  /** The options the command accepts besides the global ones. */
  readonly options: OptionSpecs;
  /** A hidden command runs, but no message or help text names it. */
  readonly hidden?: boolean;
  /**
   * Whether the command talks to an explorer: it then accepts the route options and the key flags
   * (R-AX-9, R-RT-2), and the main loop reads the keys before it runs.
   */
  readonly routed?: boolean;
}

/** The options a command accepts besides the global ones, the route options included. */
export function commandOptions(command: CommandSpec): OptionSpecs {
  return command.routed === true ? { ...ROUTE_OPTIONS, ...command.options } : command.options;
}

/**
 * The options every command accepts, in help order (R-AX-5, R-AX-6, R-AX-11, R-AX-14, R-AX-15).
 * `-v` is not bound, because it can mean verbose or version.
 */
export const GLOBAL_OPTIONS: OptionSpecs = {
  help: {
    type: "boolean",
    short: "h",
    description: "Print the help of the command, or of the CLI, on stdout.",
  },
  version: {
    type: "boolean",
    description: "Print the CLI and core versions; with --json, the routing table's date too.",
  },
  json: { type: "boolean", description: "Print one JSON envelope on stdout." },
  quiet: { type: "boolean", short: "q", description: "Show only errors on stderr." },
  verbose: { type: "boolean", description: "Show debug lines on stderr." },
  "log-format": {
    type: "string",
    value: "<format>",
    description: "text (default) for people, or json for one JSON object per stderr line.",
  },
  color: { type: "string", value: "<mode>", description: "auto (default), always or never." },
};

/** The word that asks for help, as in `explorer-verify help verify`. */
export const HELP_WORD = "help";

/** The command a contract address as the first argument runs (R-DX-1). */
const ADDRESS_COMMAND = "verify";

/** The issue message of an option with `once` given twice. */
const ONCE_MESSAGE = "can be given only once";

/** A contract address: `0x` and 40 hex digits. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What {@link readArguments} found. */
export interface Arguments {
  /**
   * Whether `--json` was given as a flag: before any `--`, and not as another option's value. A
   * `--json=<value>` counts too, and is also a usage error.
   */
  json: boolean;
  /** The command name, when the first positional names a command. */
  command?: string;
  /** The positionals after the command name. */
  positionals: string[];
  /**
   * The checked option values, by long name. An option that does not repeat keeps its last value.
   */
  values: Map<string, OptionValue>;
  /**
   * Every problem found: the options' in command-line order, then the command's. Each names one of
   * the CLI's option names or an argument's position, never text the caller typed.
   */
  issues: InputIssue[];
  /** Whether `--help`, `-h` or the word `help` asked for help. The command is then its topic. */
  help: boolean;
  /**
   * The closest command or option to the first mistyped one (R-AX-10), such as `--dry-run`. It is
   * one of the CLI's own names.
   */
  suggestion?: string;
}

/** One option or positional, with the position of its argument from 1. */
type Token =
  | {
      kind: "option";
      name: string;
      /** The value, or `undefined` when none was given or the next argument was not one. */
      value: string | undefined;
      inline: boolean;
      /** The position of the argument, from 1. */
      position: number;
    }
  | { kind: "positional"; value: string };

/**
 * Whether an argument that follows a string option is the next option rather than its value. `-`
 * (stdin) and negative numbers are values.
 */
function looksLikeOption(value: string): boolean {
  return value.length > 1 && value.startsWith("-") && !/^-\d/.test(value);
}

/**
 * Splits `argv` into tokens. When a string option took the next argument but that argument looks
 * like an option, the option gets no value and reading starts again at that argument, so
 * `--color --json` still finds `--json`.
 */
function tokenize(
  argv: readonly string[],
  config: ParseArgsOptionsConfig,
  known: ReadonlyMap<string, OptionSpec>,
): Token[] {
  const result: Token[] = [];
  let start = 0;
  let restart = true;
  while (restart) {
    restart = false;
    const { tokens } = parseArgs({
      args: argv.slice(start),
      options: config,
      strict: false,
      allowPositionals: true,
      tokens: true,
    });
    for (const token of tokens) {
      if (token.kind === "positional") {
        result.push({ kind: "positional", value: token.value });
        continue;
      }
      if (token.kind !== "option") {
        continue;
      }
      const position = start + token.index + 1;
      const value = token.value;
      const inline = token.inlineValue === true;
      if (
        value !== undefined &&
        !inline &&
        known.get(token.name)?.type === "string" &&
        looksLikeOption(value)
      ) {
        result.push({ kind: "option", name: token.name, value: undefined, inline, position });
        start = position;
        restart = true;
        break;
      }
      result.push({ kind: "option", name: token.name, value, inline, position });
    }
  }
  return result;
}

/** The text after "command" when the command is missing or unknown. */
function expected(commands: readonly CommandSpec[]): string {
  const names = commands.filter((command) => command.hidden !== true).map(({ name }) => name);
  return names.length === 0
    ? "this version has no public commands yet; see the CLI reference"
    : `give one of ${names.join(", ")}`;
}

/**
 * Reads the command line. It accepts the global options anywhere, and the options of the command
 * named by the first positional, or by the second after the word `help`. Every other option, a
 * missing or extra value, and an unknown command are issues. A missing command is not an issue
 * when help or the version was asked for.
 *
 * @param argv - The arguments after the program name.
 * @param commands - The command table.
 * @returns The flags, the command, its positionals and values, and the issues.
 */
export function readArguments(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): Arguments {
  const known = new Map<string, OptionSpec>(Object.entries(GLOBAL_OPTIONS));
  for (const command of commands) {
    for (const [name, spec] of Object.entries(commandOptions(command))) {
      known.set(name, spec);
    }
  }
  // A refused key option takes the next argument as its value, so a key typed after it is
  // dropped with it and never read as a positional (R-AX-9).
  for (const name of REFUSED_KEY_OPTIONS) {
    known.set(name, { type: "string", description: REFUSED_KEY_MESSAGE });
  }
  const config: ParseArgsOptionsConfig = {};
  for (const [name, spec] of known) {
    config[name] =
      spec.short === undefined ? { type: spec.type } : { type: spec.type, short: spec.short };
  }
  const tokens = tokenize(argv, config, known);

  const positionals: string[] = [];
  for (const token of tokens) {
    if (token.kind === "positional") {
      positionals.push(token.value);
    }
  }
  // `help [command]` asks for help, like `--help`; the command after it is the topic.
  const helpWord = positionals[0] === HELP_WORD;
  const named = helpWord ? positionals.slice(1) : positionals;
  const [first, ...after] = named;
  let found = commands.find((command) => command.name === first);
  let rest = after;
  // The short form of R-DX-1: a contract address first runs `verify` with it.
  const addressCommand = commands.find((command) => command.name === ADDRESS_COMMAND);
  if (found === undefined && first !== undefined && ADDRESS.test(first) && addressCommand) {
    found = addressCommand;
    rest = named;
  }
  const allowed = new Map<string, OptionSpec>(Object.entries(GLOBAL_OPTIONS));
  for (const [name, spec] of Object.entries(found === undefined ? {} : commandOptions(found))) {
    allowed.set(name, spec);
  }
  // The names an unknown option is compared with: never a hidden command's, unless it was named.
  const visible = commands.filter((command) => command.hidden !== true);
  const candidates = [
    ...allowed.keys(),
    ...(found === undefined
      ? visible.flatMap((command) => Object.keys(commandOptions(command)))
      : []),
  ];

  const values = new Map<string, OptionValue>();
  const lists = new Map<string, string[]>();
  const issues: InputIssue[] = [];
  let optionSuggestion: string | undefined;
  // One issue per argument, so a group of unknown short options such as `-abc` is one issue.
  const refused = new Set<number>();
  let json = false;
  const asked = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") {
      continue;
    }
    if (REFUSED_KEY_OPTIONS.includes(token.name)) {
      if (!refused.has(token.position)) {
        refused.add(token.position);
        issues.push({ field: `--${token.name}`, message: REFUSED_KEY_MESSAGE });
      }
      continue;
    }
    const spec = allowed.get(token.name);
    if (spec === undefined) {
      if (!refused.has(token.position)) {
        refused.add(token.position);
        if (found !== undefined && known.has(token.name)) {
          issues.push({ field: `--${token.name}`, message: `is not an option of ${found.name}` });
        } else {
          issues.push({ field: `argument ${String(token.position)}`, message: "is not an option" });
          // An option of a command that was not named is valid, so nothing is suggested for it.
          // Only the first suggestion is kept, so later options are not compared.
          if (optionSuggestion === undefined && !known.has(token.name)) {
            const close = closest(token.name, candidates);
            optionSuggestion = close === undefined ? undefined : `--${close}`;
          }
        }
      }
      continue;
    }
    const label = `--${token.name}`;
    if (spec.type === "boolean") {
      json ||= token.name === "json";
      // `--help=yes` is refused for its value, but still counts as asking for help.
      asked.add(token.name);
      if (token.value === undefined) {
        values.set(token.name, true);
      } else {
        issues.push({ field: label, message: "takes no value" });
      }
      continue;
    }
    const value = token.value;
    if (value === undefined) {
      issues.push({ field: label, message: "needs a value" });
      continue;
    }
    if (spec.multiple === true) {
      const list = lists.get(token.name) ?? [];
      list.push(value);
      lists.set(token.name, list);
      values.set(token.name, list);
    } else if (spec.once === true && values.has(token.name)) {
      issues.push({ field: label, message: ONCE_MESSAGE });
    } else {
      values.set(token.name, value);
    }
  }

  const help = helpWord || values.get("help") === true;
  // Help and the version need no command; an unknown one is still an issue.
  const needsCommand = !helpWord && !asked.has("help") && !asked.has("version");
  let commandSuggestion: string | undefined;
  if (found === undefined && (first !== undefined || needsCommand)) {
    issues.push({
      field: "command",
      message: `${first === undefined ? "is missing" : "is not known"}; ${expected(commands)}`,
    });
    commandSuggestion =
      first === undefined
        ? undefined
        : closest(first, [...visible.map(({ name }) => name), HELP_WORD]);
  }
  if (helpWord && rest.length > 0) {
    issues.push({ field: HELP_WORD, message: "takes at most one command" });
  }
  const result: Arguments = { json, positionals: rest, values, issues, help };
  if (found !== undefined) {
    result.command = found.name;
  }
  // A mistyped command comes first: its options are unknown until it is fixed.
  const suggestion = commandSuggestion ?? optionSuggestion;
  if (suggestion !== undefined) {
    result.suggestion = suggestion;
  }
  return result;
}
