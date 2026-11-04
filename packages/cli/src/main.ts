/**
 * The CLI's main loop and its output contract (R-AX-5, R-AX-6, R-AX-7, R-AX-12, R-AX-14,
 * R-AX-15). Every exit path ends here with one outcome: the result a command returned, the
 * `ExplorerVerifyError` it threw, `invalid-input` for a usage error, `cancelled` for SIGINT or
 * SIGTERM, or `internal-error` for anything else. The outcome gives stdout, the error line on
 * stderr and the exit code, so the three never disagree.
 */
import { homedir } from "node:os";

import {
  ERROR_EXIT_CODES,
  ExplorerVerifyError,
  exitCodeOf,
  parseHandle,
  toEnvelope,
} from "explorer-verify";
import type { ExitCode, Handle, InputIssue, VerifyOutcome, VerifyResult } from "explorer-verify";

import { readArguments } from "./arguments.ts";
import type { Arguments } from "./arguments.ts";
import { stringOption, usageError } from "./command.ts";
import type { Command, CommandContext } from "./command.ts";
import { COMMANDS } from "./commands.ts";
import { helpResult, helpText } from "./help.ts";
import {
  effectiveLevel,
  environmentLevel,
  LOG_FORMATS,
  LOG_LEVELS,
  LOG_VARIABLE,
} from "./log-level.ts";
import type { LogFormat } from "./log-level.ts";
import { infoText, stdoutText } from "./output.ts";
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
  /** Calls `listener` on SIGINT and SIGTERM, and returns a function that stops it. */
  readonly onSignal: (listener: (signal: SignalName) => void) => () => void;
}

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
  /** Set once the outcome is fixed; later signals are ignored. */
  fixed: boolean;
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
function internalError(error: unknown): ExplorerVerifyError {
  let text: string;
  try {
    text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
  } catch {
    text = "an exception whose message cannot be read";
  }
  const redacted = new ExplorerVerifyError({ code: "internal-error" }, text, { secrets: [] });
  return new ExplorerVerifyError(
    { code: "internal-error" },
    `An unexpected error occurred: ${redacted.message.slice(0, MESSAGE_LENGTH)}`,
    { secrets: [], cause: error },
  );
}

/** The `cancelled` error of a signal, with the handle of the submission when there was one. */
function cancelledError(signal: SignalName, submitted: string | undefined): ExplorerVerifyError {
  let handle: Handle | undefined;
  try {
    handle = submitted === undefined ? undefined : parseHandle(submitted);
  } catch {
    handle = undefined;
  }
  return new ExplorerVerifyError(
    handle === undefined ? { code: "cancelled" } : { code: "cancelled", handle },
    `The run was cancelled by ${signal}.`,
    { secrets: [] },
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
type Settled = { result: VerifyResult } | { error: unknown };

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
): Promise<VerifyOutcome> {
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
  const context: CommandContext = {
    positionals: args.positionals,
    values: args.values,
    signal,
    logger: stderr.logger,
    onEvent: (event) => {
      if (event.type === "verify.submitted") {
        state.submitted = event.handle;
      }
      stderr.onEvent(event);
    },
    env: io.env,
  };
  stderr.startSpinner(`Running ${command.name}`);
  try {
    const running = Promise.resolve()
      .then(async () => await command.run(context))
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
      : internalError(settled.error);
  } finally {
    stderr.stopSpinner();
  }
}

/** Writes the outcome: stdout from its envelope, its error line on stderr; returns its exit code. */
function finish(
  outcome: VerifyOutcome,
  io: Io,
  stderr: Stderr,
  options: { json: boolean; color: boolean },
): ExitCode {
  const envelope = toEnvelope(outcome);
  const code = exitCodeOf(outcome);
  const text = stdoutText(envelope, options.json, options.color);
  // The stderr writer never throws, so stdout is written whatever stderr does.
  if ("error" in envelope) {
    stderr.error(envelope.error);
    if (outcome instanceof ExplorerVerifyError && outcome.code === "internal-error") {
      const { cause } = outcome;
      if (cause instanceof Error && cause.stack !== undefined) {
        stderr.log("debug", "The stack of the unexpected error, redacted.", {
          stack: tidyStack(cause.stack, homedir()),
        });
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
    issues.push({
      field: command.name,
      message:
        command.maxPositionals === 0
          ? "takes no arguments"
          : `takes at most ${String(command.maxPositionals)} arguments`,
    });
  }
  const version = args.values.get("version") === true;
  if (state.received === undefined && issues.length === 0 && (args.help || version)) {
    // Help and the version run nothing and exit 0 (R-AX-11); help wins when both are asked for.
    state.fixed = true;
    io.stdout.write(
      args.help
        ? infoText(helpResult(commands, command), args.json, helpText)
        : infoText(versionResult(), args.json, versionText),
    );
    return 0;
  }
  let outcome: VerifyOutcome;
  if (state.received !== undefined) {
    outcome = cancelledError(state.received, state.submitted);
  } else if (command === undefined || issues.length > 0) {
    outcome = usageError(issues, args.suggestion);
  } else {
    outcome = await runCommand(command, args, io, stderr, state);
  }
  // A signal that arrived before the outcome was fixed wins. From here on, signals are ignored,
  // so the envelope is always written.
  state.fixed = true;
  const final =
    state.received === undefined ? outcome : cancelledError(state.received, state.submitted);
  return finish(final, io, stderr, { json: args.json, color: policy.colorStdout });
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
export async function main(io: Io, commands: readonly Command[] = COMMANDS): Promise<ExitCode> {
  // Until the command line is read, a literal `--json` before any `--` counts, so a failure that
  // happens first still prints an envelope (R-AX-5).
  const end = io.argv.indexOf("--");
  let json = io.argv.slice(0, end === -1 ? undefined : end).includes("--json");
  const state: RunState = {
    controller: new AbortController(),
    received: undefined,
    submitted: undefined,
    fixed: false,
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
    code = failSafe(error, io, json);
  }
  state.fixed = true;
  stopListening();
  return code;
}

/** The exit code of a bug in the CLI itself, with its `internal-error` written where possible. */
function failSafe(error: unknown, io: Io, json: boolean): ExitCode {
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
    return finish(internalError(error), io, stderr, { json, color: false });
  } catch {
    // stdout refused the output too; the exit code is all that is left.
    return ERROR_EXIT_CODES["internal-error"];
  }
}
