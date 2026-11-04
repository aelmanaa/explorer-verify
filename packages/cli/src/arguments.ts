/**
 * Reads the command line with `util.parseArgs` in its non-strict, token mode, which never throws,
 * then checks the tokens itself. So `--json` is known before any usage error (R-AX-5), and no
 * error message repeats text the caller typed: an option's value, or a mistyped name, may be a key
 * (R-AX-9). An issue names the CLI's own option names, or the position of an argument.
 */
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import type { InputIssue } from "explorer-verify";

/** One option a command or the CLI accepts. */
export interface OptionSpec {
  /** `string` takes a value; `boolean` takes none. */
  type: "string" | "boolean";
  /** A one-letter alias, such as `q` for `--quiet`. */
  short?: string;
  /** Whether the option may repeat; its values then form a list. */
  multiple?: boolean;
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
}

/** The options every command accepts (R-AX-5, R-AX-6, R-AX-14, R-AX-15). */
export const GLOBAL_OPTIONS: OptionSpecs = {
  json: { type: "boolean", description: "Print one JSON envelope on stdout." },
  quiet: { type: "boolean", short: "q", description: "Show only errors on stderr." },
  verbose: { type: "boolean", description: "Show debug lines on stderr." },
  "log-format": { type: "string", description: "text (default) or json lines on stderr." },
  color: { type: "string", description: "auto (default), always or never." },
};

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
 * named by the first positional. Every other option, a missing or extra value, and an unknown
 * command are issues.
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
    for (const [name, spec] of Object.entries(command.options)) {
      known.set(name, spec);
    }
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
  const [first, ...rest] = positionals;
  const found = commands.find((command) => command.name === first);
  const allowed = new Map<string, OptionSpec>(Object.entries(GLOBAL_OPTIONS));
  for (const [name, spec] of Object.entries(found?.options ?? {})) {
    allowed.set(name, spec);
  }

  const values = new Map<string, OptionValue>();
  const lists = new Map<string, string[]>();
  const issues: InputIssue[] = [];
  // One issue per argument, so a group of unknown short options such as `-abc` is one issue.
  const refused = new Set<number>();
  let json = false;
  for (const token of tokens) {
    if (token.kind !== "option") {
      continue;
    }
    const spec = allowed.get(token.name);
    if (spec === undefined) {
      if (!refused.has(token.position)) {
        refused.add(token.position);
        issues.push(
          found !== undefined && known.has(token.name)
            ? { field: `--${token.name}`, message: `is not an option of ${found.name}` }
            : { field: `argument ${String(token.position)}`, message: "is not an option" },
        );
      }
      continue;
    }
    const label = `--${token.name}`;
    if (spec.type === "boolean") {
      json ||= token.name === "json";
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
    } else {
      values.set(token.name, value);
    }
  }

  if (found === undefined) {
    issues.push({
      field: "command",
      message: `${first === undefined ? "is missing" : "is not known"}; ${expected(commands)}`,
    });
  }
  return found === undefined
    ? { json, positionals: rest, values, issues }
    : { json, command: found.name, positionals: rest, values, issues };
}
