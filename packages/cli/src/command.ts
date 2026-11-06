/**
 * The shape of a command. The CLI's main loop owns the output contract: it parses the global
 * options, builds the logger and the event writer, handles signals, and turns what `run` returns
 * or throws into stdout, stderr and the exit code. A command only does its work.
 */
import { ExplorerVerifyError } from "explorer-verify";
import type {
  DryRunResult,
  InputIssue,
  Logger,
  VerifyEachResult,
  VerifyEvent,
  VerifyResult,
} from "explorer-verify";

import type { CommandSpec, OptionValue } from "./arguments.ts";
import { ownHint } from "./hints.ts";
import type { InputStream, RouteOptions } from "./keys.ts";
import type { LineLevel } from "./log-level.ts";
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
  /**
   * The stderr event writer. Pass it to the library. `level` replaces the event's own level, such
   * as `info` for the `verify.routed` line of a backend the routing table chose.
   */
  readonly onEvent: (event: VerifyEvent, level?: LineLevel) => void;
  /** The environment variables, without the key variables: the keys come from `routeOptions`. */
  readonly env: Environment;
  /**
   * Returns `apiKeys` and `route` from the route options, the key variables and the key flags
   * (R-AX-9). Spread it into the library's options. Empty for a command that is not `routed`.
   * A function, so printing the context shows no key.
   */
  readonly routeOptions: () => RouteOptions;
}

/** One example of a command line, for the help text and the CLI reference. */
export interface Example {
  /** The arguments after `explorer-verify`, separated by single spaces. */
  readonly args: string;
  /** What the command line does, in one sentence. */
  readonly description: string;
}

/** What a command returns: a result of `verify()`, `checkStatus()`, `dryRun()` or `verifyEach()`. */
export type CommandResult = VerifyResult | DryRunResult | VerifyEachResult;

/** Does a command's work. */
export type RunCommand = (context: CommandContext) => Promise<CommandResult>;

/** What a command's `prepare` receives: the command line, before any key is read. */
export interface PrepareContext {
  /** The positionals after the command name. */
  readonly positionals: readonly string[];
  /** The checked option values, global ones included, by long name. */
  readonly values: ReadonlyMap<string, OptionValue>;
  /** Opens stdin. Call it only when an option asks to read stdin, such as `--input-json -`. */
  readonly stdin: () => InputStream;
  /**
   * Adds values that the main loop removes from stdout and stderr (R-SEC-1), such as the parts of
   * an RPC URL that can hold a key. Call it as soon as the value is read, before any check.
   */
  readonly addSecrets: (secrets: readonly string[]) => void;
}

/** What a command's `prepare` returns. */
export interface Prepared {
  /**
   * The option values to run with: the command line's, plus any that the request gave, such as
   * `backend` from the route of `--input-json`. The keys are read with these values.
   */
  readonly values: ReadonlyMap<string, OptionValue>;
  /**
   * The name to give an issue about an option that the request filled, such as `route.backend`
   * for `--backend`. Absent when the command line gave every option.
   */
  readonly fieldNames?: ReadonlyMap<string, string>;
  /** Does the work with what `prepare` read. */
  readonly run: RunCommand;
}

/** The fields every row of the command table has. */
interface CommandFields extends CommandSpec {
  /** One line for the help text. */
  readonly summary: string;
  /**
   * The usage line after the command name, without `[options]`: the positionals and the options
   * the command needs, such as `<handle>`. Empty when it needs none.
   */
  readonly usage: string;
  /** More usage lines, for each other way to call the command, such as with `--input-json`. */
  readonly moreUsage?: readonly string[];
  /** At least one example. The help text shows them first (R-AX-11), and the tests run them. */
  readonly examples: readonly [Example, ...Example[]];
  /** The most positionals the command accepts after its name. */
  readonly maxPositionals: number;
  /**
   * The issue of more positionals than {@link maxPositionals}, when the command can say more than
   * the default one, or `undefined` for the default.
   */
  readonly extraArguments?: (values: ReadonlyMap<string, OptionValue>) => InputIssue | undefined;
}

/**
 * One row of the command table. A command either runs at once with `run`, or reads its request
 * first with `prepare`, before the main loop reads the keys, so the request can name the route
 * the keys go to (R-AX-16). Either one returns a result, or throws an `ExplorerVerifyError`;
 * anything else it throws becomes `internal-error`.
 */
export type Command = CommandFields &
  (
    | { readonly run: RunCommand; readonly prepare?: undefined }
    | {
        readonly prepare: (context: PrepareContext) => Promise<Prepared>;
        readonly run?: undefined;
      }
  );

/** The hint of a usage error, and of an `invalid-input` error with the library's generic hint. */
const USAGE_HINT: string =
  "Fix the arguments the message names, then run the command again. explorer-verify --help lists every command and option.";

/** The most issues a usage error lists; the message counts the rest. */
const MAX_ISSUES = 20;

/**
 * The `invalid-input` error of a command line (R-AX-5): exit code 2. The message lists the first
 * {@link MAX_ISSUES} issues, so the error line alone says what to fix, and counts the rest; the
 * envelope also holds them in `details.issues`. Issues name options, never their values. A
 * suggestion, one of the CLI's own names, leads the hint (R-AX-10). The CLI keeps this hint.
 *
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
  return ownHint(
    new ExplorerVerifyError(
      { code: "invalid-input", issues: shown },
      `The command line is invalid: ${list}${more}.`,
      {
        secrets: [],
        hint: suggestion === undefined ? USAGE_HINT : `Did you mean ${suggestion}? ${USAGE_HINT}`,
      },
    ),
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

/**
 * The values of an option that repeats, in command-line order: empty when it was not given.
 *
 * @param values - The checked option values.
 * @param name - The option's long name.
 * @returns The values.
 */
export function listOption(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
): readonly string[] {
  const value = values.get(name);
  return value === undefined || typeof value === "string" || typeof value === "boolean"
    ? []
    : value;
}
