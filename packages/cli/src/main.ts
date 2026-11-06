/**
 * The CLI's main loop and its output contract (R-AX-5, R-AX-6, R-AX-7, R-AX-12, R-AX-14,
 * R-AX-15). Every exit path ends here with one outcome: the result a command returned, the
 * `ExplorerVerifyError` it threw, `invalid-input` for a usage error, `cancelled` for SIGINT or
 * SIGTERM, or `internal-error` for anything else. The outcome gives stdout, the error line on
 * stderr and the exit code, so the three never disagree.
 */
import { homedir } from "node:os";

import { ERROR_HINTS, ExplorerVerifyError, parseHandle } from "explorer-verify";
import type { Handle, InputIssue } from "explorer-verify";
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { ExitCode } from "explorer-verify/envelope";

import { readArguments } from "./arguments.ts";
import type { Arguments, OptionValue } from "./arguments.ts";
import { stringOption, usageError } from "./command.ts";
import type { Command, CommandContext, CommandResult, RunCommand } from "./command.ts";
import { COMMANDS } from "./commands.ts";
import { helpResult, helpText, shortHelpText } from "./help.ts";
import { hasOwnHint } from "./hints.ts";
import { keyVariableValues, readRouteOptions, scrubbing, withoutKeyVariables } from "./keys.ts";
import type { InputStream, RouteOptions } from "./keys.ts";
import {
  effectiveLevel,
  environmentLevel,
  LOG_FORMATS,
  LOG_LEVELS,
  LOG_VARIABLE,
} from "./log-level.ts";
import type { LogFormat } from "./log-level.ts";
import { cliEnvelope, infoText, stdoutText } from "./output.ts";
import { createStderr } from "./stderr.ts";
import type { OutputStream, Stderr } from "./stderr.ts";
import { COLOR_MODES, terminalPolicy } from "./terminal.ts";
import type { ColorMode, Environment } from "./terminal.ts";
import { versionResult, versionText } from "./version.ts";

/** The signals that cancel a run (exit code 130). */
export type SignalName = "SIGINT" | "SIGTERM";

/** What the CLI reads from and writes to. The bin passes the process's own. */
export interface Io {
  /** The arguments after the program name. */
  readonly argv: readonly string[];
  /** The environment variables. */
  readonly env: Environment;
  /** Receives the envelope or the summary, and nothing else. */
  readonly stdout: OutputStream;
  /** Receives logs, events, errors and the spinner. */
  readonly stderr: OutputStream;
  /** Opens stdin. The CLI calls it only when a flag asks it to read stdin, such as `--api-key-stdin`. */
  readonly stdin: () => InputStream;
  /** Calls `listener` on SIGINT and SIGTERM, and returns a function that stops it. */
  readonly onSignal: (listener: (signal: SignalName) => void) => () => void;
}

/** The options that give a key from a file or stdin, which a next command would not repeat. */
const KEY_FLAGS = ["api-key-file", "api-key-stdin"];

/** The longest part of an unexpected exception's message that `internal-error` keeps. */
const MESSAGE_LENGTH = 500;

/** What one run knows about signals and the submission, from start to exit. */
interface RunState {
  /** Aborts on the first signal; the command's context carries its signal. */
  readonly controller: AbortController;
  /** The first signal that arrived before the outcome was fixed. */
  received: SignalName | undefined;
  /** The handle of the last `verify.submitted` event. */
  submitted: string | undefined;
  /** The handle of each backend's `verify.submitted` event, by backend, in event order. */
  readonly submissions: Map<string, string>;
  /** The backends whose `verify.result` event arrived: their jobs ended. */
  readonly ended: Set<string>;
  /** The backends of a repeated `--backend`, in command-line order; empty otherwise. */
  order: readonly string[];
  /** Set once the outcome is fixed; later signals are ignored. */
  fixed: boolean;
  /**
   * Every key read, and every part of an RPC URL that can hold one, removed from everything written
   * to stdout and stderr (R-SEC-1, R-AX-9).
   */
  readonly secrets: string[];
}

/**
 * The value of an option that takes one of `allowed`: `fallback` when it is absent, and
 * `fallback` with an issue when it is something else.
 */
function choice<T extends string>(
  args: Arguments,
  name: string,
  allowed: readonly T[],
  fallback: T,
  issues: InputIssue[],
): T {
  const value = stringOption(args.values, name);
  if (value === undefined) {
    return fallback;
  }
  const found = allowed.find((known) => known === value);
  if (found === undefined) {
    issues.push({ field: `--${name}`, message: `must be one of ${allowed.join(", ")}` });
    return fallback;
  }
  return found;
}

/**
 * The `internal-error` of an unexpected exception (R-AX-5): exit code 6, not retryable, no handle,
 * the fixed hint, and the exception's message redacted whole, then cut short, so a key across the
 * cut never leaves a fragment (R-SEC-1). The redacted cause keeps the stack for the debug line.
 */
function internalError(error: unknown, secrets: readonly string[]): ExplorerVerifyError {
  let text: string;
  try {
    text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
  } catch {
    text = "an exception whose message cannot be read";
  }
  const redacted = new ExplorerVerifyError({ code: "internal-error" }, text, { secrets });
  return new ExplorerVerifyError(
    { code: "internal-error" },
    `An unexpected error occurred: ${redacted.message.slice(0, MESSAGE_LENGTH)}`,
    { hint: ERROR_HINTS["internal-error"], secrets, cause: error },
  );
}

/** A one-line handle read back, or `undefined` when it does not parse. */
function handleOf(line: string | undefined): Handle | undefined {
  try {
    return line === undefined ? undefined : parseHandle(line);
  } catch {
    return undefined;
  }
}

/**
 * The handles of the jobs a cancel leaves running: each backend that sent `verify.submitted` and
 * no `verify.result`, in `order` (the backends of a repeated `--backend`), then any other backend
 * in the order it submitted.
 *
 * @param submissions - The handle of each backend that submitted, in event order.
 * @param ended - The backends whose result arrived.
 * @param order - The backends of a repeated `--backend`, in command-line order.
 * @returns The handles.
 */
export function pendingHandles(
  submissions: ReadonlyMap<string, string>,
  ended: ReadonlySet<string>,
  order: readonly string[],
): Handle[] {
  const rank = (backend: string): number => {
    const index = order.indexOf(backend);
    return index === -1 ? order.length : index;
  };
  return [...submissions]
    .filter(([backend]) => !ended.has(backend))
    .map(([backend, line], index) => ({ backend, line, index }))
    .toSorted((a, b) => rank(a.backend) - rank(b.backend) || a.index - b.index)
    .flatMap(({ line }) => handleOf(line) ?? []);
}

/**
 * The `cancelled` error of a signal. It carries `handle` when exactly one backend submitted. A
 * run on several backends also carries `handles`: every backend whose job was still running, so
 * no job is lost.
 */
function cancelledError(signal: SignalName, state: RunState): ExplorerVerifyError {
  const handle = state.submissions.size > 1 ? undefined : handleOf(state.submitted);
  const several = state.submissions.size > 1 || state.order.length > 1;
  const handles = several ? pendingHandles(state.submissions, state.ended, state.order) : [];
  return new ExplorerVerifyError(
    {
      code: "cancelled",
      ...(handle === undefined ? {} : { handle }),
      ...(handles.length === 0 ? {} : { handles }),
    },
    `The run was cancelled by ${signal}.`,
    { hint: ERROR_HINTS.cancelled, secrets: [] },
  );
}

/**
 * A stack without the user's home directory: `~` stands in for it, so a `--verbose` line does not
 * print where the package is installed. A home of `/` or empty is left alone.
 *
 * @param stack - The redacted stack.
 * @param home - The home directory.
 * @returns The stack with `~` for the home directory.
 */
export function tidyStack(stack: string, home: string): string {
  return home.length > 1 ? stack.replaceAll(home, "~") : stack;
}

/** How a command's run ended. A signal settles it as an error with no value. */
type Settled = { result: CommandResult } | { error: unknown };

/** What a run ends with: a command's result or an error. */
type Outcome = CommandResult | ExplorerVerifyError;

/**
 * Runs a command with the context and a spinner. A signal aborts the context's signal and ends
 * the run at once, whatever the command does next; the caller turns it into `cancelled`. The
 * caller checks that no signal arrived before this starts.
 */
async function runCommand(
  command: Command,
  args: Arguments,
  io: Io,
  stderr: Stderr,
  state: RunState,
): Promise<Outcome> {
  const { signal } = state.controller;
  const cancelled = new Promise<Settled>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve({ error: undefined });
      },
      { once: true },
    );
  });
  let routeOptions: RouteOptions = {};
  let values: ReadonlyMap<string, OptionValue> = args.values;
  let fieldNames: ReadonlyMap<string, string> = new Map();
  const context = (): CommandContext => ({
    positionals: args.positionals,
    values,
    signal,
    logger: stderr.logger,
    onEvent: (event, level) => {
      if (event.type === "verify.submitted") {
        state.submitted = event.handle;
        state.submissions.set(event.backend, event.handle);
      } else if (event.type === "verify.result") {
        state.ended.add(event.backend);
      }
      stderr.onEvent(event, level);
    },
    env: withoutKeyVariables(io.env),
    routeOptions: () => routeOptions,
  });
  stderr.startSpinner(`Running ${command.name}`);
  try {
    const running = Promise.resolve()
      .then(async () => {
        let run: RunCommand;
        if (command.prepare === undefined) {
          run = command.run;
        } else {
          // The request is read before the keys, so its route decides where a key goes (R-AX-16).
          const prepared = await command.prepare({
            positionals: args.positionals,
            values: args.values,
            stdin: io.stdin,
            addSecrets: (secrets) => {
              state.secrets.push(...secrets);
            },
          });
          values = prepared.values;
          run = prepared.run;
          fieldNames = prepared.fieldNames ?? fieldNames;
        }
        if (command.routed === true) {
          const read = await readRouteOptions({ values, env: io.env, stdin: io.stdin });
          state.secrets.push(...read.secrets);
          if (read.options === undefined) {
            throw usageError(
              read.issues.map((issue) => ({
                ...issue,
                field: fieldNames.get(issue.field) ?? issue.field,
              })),
            );
          }
          routeOptions = read.options;
          state.order = read.options.backends ?? [];
        }
        return await run(context());
      })
      .then(
        (result): Settled => ({ result }),
        (error: unknown): Settled => ({ error }),
      );
    const settled = await Promise.race([running, cancelled]);
    if ("result" in settled) {
      return settled.result;
    }
    return settled.error instanceof ExplorerVerifyError
      ? settled.error
      : internalError(settled.error, state.secrets);
  } finally {
    stderr.stopSpinner();
  }
}

/** Writes the outcome: stdout from its envelope, its error line on stderr; returns its exit code. */
function finish(
  outcome: Outcome,
  io: Io,
  stderr: Stderr,
  options: {
    json: boolean;
    color: boolean;
    keyFlag: boolean;
    secrets: readonly string[];
  },
): ExitCode {
  // A dry run's result goes through the same envelope as any other, and exits 0 (R-AX-8). The
  // CLI's hints and next command replace the library's words (R-AX-10).
  const envelope = cliEnvelope(toEnvelope(outcome, { secrets: options.secrets }), {
    own: hasOwnHint(outcome),
    keyFlag: options.keyFlag,
    json: options.json,
  });
  const code = exitCodeOf(outcome);
  const text = stdoutText(envelope, options.json, options.color);
  // The stderr writer never throws, so stdout is written whatever stderr does.
  if ("error" in envelope) {
    stderr.error(envelope.error, envelope.nextCommand);
    if (outcome instanceof ExplorerVerifyError && outcome.code === "internal-error") {
      const { cause } = outcome;
      if (cause instanceof Error && cause.stack !== undefined) {
        stderr.log("debug", "The stack of the unexpected error, redacted.", {
          stack: tidyStack(cause.stack, homedir()),
        });
      }
    }
  } else if ("outcomes" in envelope.result) {
    // A run on several backends: each backend's error goes to stderr too, with its hint (#225).
    for (const each of envelope.result.outcomes) {
      if ("error" in each) {
        stderr.error({ ...each.error, message: `${each.backend}: ${each.error.message}` });
      }
    }
  }
  if (text !== "") {
    io.stdout.write(text);
  }
  return code;
}

/** Reads the command line, runs the command and writes its outcome. */
async function runCli(
  io: Io,
  commands: readonly Command[],
  state: RunState,
  setJson: (json: boolean) => void,
): Promise<ExitCode> {
  const args = readArguments(io.argv, commands);
  setJson(args.json);
  const issues = [...args.issues];
  const color: ColorMode = choice(args, "color", COLOR_MODES, "auto", issues);
  const logFormat: LogFormat = choice(args, "log-format", LOG_FORMATS, "text", issues);
  const quiet = args.values.get("quiet") === true;
  const verbose = args.values.get("verbose") === true;
  if (quiet && verbose) {
    issues.push({ field: "--quiet", message: "cannot be combined with --verbose" });
  }
  const fromEnvironment = environmentLevel(io.env[LOG_VARIABLE]);
  const level = effectiveLevel(
    { quiet: quiet && !verbose, verbose: verbose && !quiet },
    fromEnvironment.level,
  );
  const policy = terminalPolicy({
    color,
    env: io.env,
    stdoutIsTerminal: io.stdout.isTTY === true,
    stderrIsTerminal: io.stderr.isTTY === true,
    logFormat,
    level,
  });
  const stderr = createStderr({
    stream: io.stderr,
    level,
    format: logFormat,
    color: policy.colorStderr,
    spinner: policy.spinner,
  });
  if (fromEnvironment.invalid) {
    stderr.log("warn", `${LOG_VARIABLE} is not one of ${LOG_LEVELS.join(", ")}, so it is ignored.`);
  }
  const command = commands.find(({ name }) => name === args.command);
  if (command !== undefined && !args.help && args.positionals.length > command.maxPositionals) {
    issues.push(
      command.extraArguments?.(args.values) ?? {
        field: command.name,
        message:
          command.maxPositionals === 0
            ? "takes no arguments"
            : `takes at most ${String(command.maxPositionals)} argument${command.maxPositionals === 1 ? "" : "s"}`,
      },
    );
  }
  // A bare `explorer-verify`, or a command that needs arguments with nothing after it, is someone
  // finding their way: the short help goes to stderr, and the exit code stays 2, as for any usage
  // error (R-AX-11).
  const bare =
    io.argv.length === 0 ||
    (command !== undefined &&
      io.argv.length === 1 &&
      io.argv[0] === command.name &&
      command.usage !== "");
  if (bare) {
    state.fixed = true;
    io.stderr.write(shortHelpText(helpResult(commands, command)));
    return ERROR_EXIT_CODES["invalid-input"];
  }
  const version = args.values.get("version") === true;
  if (state.received === undefined && issues.length === 0 && (args.help || version)) {
    // Help and the version run nothing and exit 0 (R-AX-11); help wins when both are asked for.
    state.fixed = true;
    io.stdout.write(
      args.help
        ? infoText(helpResult(commands, command), args.json, helpText)
        : infoText(await versionResult(), args.json, versionText),
    );
    return 0;
  }
  let outcome: Outcome;
  if (state.received !== undefined) {
    outcome = cancelledError(state.received, state);
  } else if (command === undefined || issues.length > 0) {
    outcome = usageError(issues, args.suggestion);
  } else {
    outcome = await runCommand(command, args, io, stderr, state);
  }
  // A signal that arrived before the outcome was fixed wins. From here on, signals are ignored,
  // so the envelope is always written.
  state.fixed = true;
  const final = state.received === undefined ? outcome : cancelledError(state.received, state);
  return finish(final, io, stderr, {
    json: args.json,
    color: policy.colorStdout,
    keyFlag: KEY_FLAGS.some((flag) => args.values.has(flag)),
    secrets: state.secrets,
  });
}

/**
 * Runs the CLI once and returns its exit code (R-AX-7). It never throws: an unexpected exception
 * becomes `internal-error`, with one envelope on stdout under `--json` (R-AX-5).
 *
 * The first SIGINT or SIGTERM before the outcome is fixed gives `cancelled` (exit code 130); later
 * ones are ignored, so the envelope is written in full.
 *
 * @param io - The arguments, the environment, the two streams and the signal source.
 * @param commands - The command table; the tests pass their own.
 * @returns The exit code.
 */
export async function main(given: Io, commands: readonly Command[] = COMMANDS): Promise<ExitCode> {
  // Until the command line is read, a literal `--json` before any `--` counts, so a failure that
  // happens first still prints an envelope (R-AX-5).
  const end = given.argv.indexOf("--");
  let json = given.argv.slice(0, end === -1 ? undefined : end).includes("--json");
  const state: RunState = {
    controller: new AbortController(),
    received: undefined,
    submitted: undefined,
    submissions: new Map(),
    ended: new Set(),
    order: [],
    fixed: false,
    // The key variables are secrets before the command line is read, so no path prints them.
    secrets: keyVariableValues(given.env),
  };
  // The last guard of R-SEC-1: every key read is removed from both streams, whatever wrote it.
  const io: Io = {
    ...given,
    stdout: scrubbing(given.stdout, state.secrets),
    stderr: scrubbing(given.stderr, state.secrets),
  };
  const stopListening = io.onSignal((signal) => {
    if (!state.fixed && state.received === undefined) {
      state.received = signal;
      state.controller.abort();
    }
  });
  let code: ExitCode;
  try {
    code = await runCli(io, commands, state, (value) => {
      json = value;
    });
  } catch (error) {
    code = failSafe(error, io, json, state.secrets);
  }
  state.fixed = true;
  stopListening();
  return code;
}

/** The exit code of a bug in the CLI itself, with its `internal-error` written where possible. */
function failSafe(error: unknown, io: Io, json: boolean, secrets: readonly string[]): ExitCode {
  // A bug in the CLI itself. The level and format the caller chose may be what failed, so this
  // path ignores them on purpose and always writes the error in text at the default level.
  const stderr = createStderr({
    stream: io.stderr,
    level: "info",
    format: "text",
    color: false,
    spinner: false,
  });
  try {
    return finish(internalError(error, secrets), io, stderr, {
      json,
      color: false,
      keyFlag: false,
      secrets,
    });
  } catch {
    // stdout refused the output too; the exit code is all that is left.
    return ERROR_EXIT_CODES["internal-error"];
  }
}
