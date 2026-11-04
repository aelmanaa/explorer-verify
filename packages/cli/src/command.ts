/**
 * The shape of a command. The CLI's main loop owns the output contract: it parses the global
 * options, builds the logger and the event writer, handles signals, and turns what `run` returns
 * or throws into stdout, stderr and the exit code. A command only does its work.
 */
import { ExplorerVerifyError } from "explorer-verify";
import type { InputIssue, Logger, VerifyEvent, VerifyResult } from "explorer-verify";

import type { CommandSpec, OptionValue } from "./arguments.ts";
import type { Environment } from "./terminal.ts";

/** What a command's `run` receives. */
export interface CommandContext {
  /** The positionals after the command name. */
  readonly positionals: readonly string[];
  /** The checked option values, global ones included, by long name. */
  readonly values: ReadonlyMap<string, OptionValue>;
  /** Aborts on SIGINT or SIGTERM. Pass it to the library. */
  readonly signal: AbortSignal;
  /** The stderr logger. Pass it to the library. */
  readonly logger: Logger;
  /** The stderr event writer. Pass it to the library. */
  readonly onEvent: (event: VerifyEvent) => void;
  /** The environment variables. */
  readonly env: Environment;
}

/** One example of a command line, for the help text and the CLI reference. */
export interface Example {
  /** The arguments after `explorer-verify`, separated by single spaces. */
  readonly args: string;
  /** What the command line does, in one sentence. */
  readonly description: string;
}

/** One row of the command table. */
export interface Command extends CommandSpec {
  /** One line for the help text. */
  readonly summary: string;
  /** The positionals of the usage line, such as `<handle>`. Empty when it takes none. */
  readonly usage: string;
  /** At least one example. The help text shows them first (R-AX-11), and the tests run them. */
  readonly examples: readonly [Example, ...Example[]];
  /** The most positionals the command accepts after its name. */
  readonly maxPositionals: number;
  /**
   * Does the work. It returns a result, or throws an `ExplorerVerifyError`; anything else it
   * throws becomes `internal-error`.
   */
  readonly run: (context: CommandContext) => Promise<VerifyResult>;
}

/** The hint of a usage error. */
const USAGE_HINT =
  "Fix the arguments the message names, then run the command again. explorer-verify --help lists the commands and options.";

/** The most issues a usage error lists; the message counts the rest. */
const MAX_ISSUES = 20;

/**
 * The `invalid-input` error of a command line (R-AX-5): exit code 2. The message lists the first
 * {@link MAX_ISSUES} issues, because the envelope has no `details`, and counts the rest. Issues
 * name options, never their values. A suggestion, one of the CLI's own names, leads the hint
 * (R-AX-10).
 *
 * @param issues - The problems found.
 * @param suggestion - The closest name to a mistyped command or option, such as `--dry-run`.
 * @returns The error.
 */
export function usageError(
  issues: readonly InputIssue[],
  suggestion?: string,
): ExplorerVerifyError {
  const shown = issues.slice(0, MAX_ISSUES);
  const left = issues.length - shown.length;
  const list = shown.map((issue) => `${issue.field} ${issue.message}`).join("; ");
  const more = left > 0 ? `; and ${String(left)} more` : "";
  return new ExplorerVerifyError(
    { code: "invalid-input", issues: shown },
    `The command line is invalid: ${list}${more}.`,
    {
      secrets: [],
      hint: suggestion === undefined ? USAGE_HINT : `Did you mean ${suggestion}? ${USAGE_HINT}`,
    },
  );
}

/**
 * The value of a string option, or `undefined` when it was not given.
 *
 * @param values - The checked option values.
 * @param name - The option's long name.
 * @returns The value.
 */
export function stringOption(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
): string | undefined {
  const value = values.get(name);
  return typeof value === "string" ? value : undefined;
}
