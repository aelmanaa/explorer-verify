/**
 * What each stream may show (R-AX-6): colour per stream and spinners on stderr. The CLI has no
 * pager: its longest output, the help, fits a screen or two.
 * Each decision reads only its own stream's terminal state, `--color`, `NO_COLOR`, `TERM`, `CI`,
 * the log format and the log level. The CLI never prompts.
 */
import type { LogFormat, LogLevel } from "./log-level.ts";

/** The values of `--color`. */
export const COLOR_MODES = ["auto", "always", "never"] as const;

/** One of {@link COLOR_MODES}. */
export type ColorMode = (typeof COLOR_MODES)[number];

/** The environment variables the terminal rules read. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** What the CLI may do on each stream. */
export interface TerminalPolicy {
  /** ANSI colour on stdout. */
  colorStdout: boolean;
  /** ANSI colour on stderr. */
  colorStderr: boolean;
  /** A spinner and line redraws on stderr. */
  spinner: boolean;
}

/** The inputs of {@link terminalPolicy}. */
export interface TerminalInputs {
  color: ColorMode;
  env: Environment;
  stdoutIsTerminal: boolean;
  stderrIsTerminal: boolean;
  logFormat: LogFormat;
  level: LogLevel;
}

/** Whether an environment variable is set to a non-empty value. */
function isSet(env: Environment, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== "";
}

/**
 * The terminal rules of R-AX-6:
 *
 * - `--color=always` colours both streams and `--color=never` neither. With `auto`, a non-empty
 *   `NO_COLOR` or `TERM=dumb` turns colour off, and each stream is coloured only when it is a
 *   terminal. The flag wins over `NO_COLOR`, as no-color.org asks.
 * - A spinner runs only when stderr is a terminal, `CI` is unset or empty, `TERM` is not `dumb`
 *   (it cannot redraw a line), the log format is `text`, and the level shows more than errors (so
 *   not with `--quiet`).
 *
 * @param inputs - The flag values, the environment and each stream's terminal state.
 * @returns What each stream may show.
 */
export function terminalPolicy(inputs: TerminalInputs): TerminalPolicy {
  const { color, env } = inputs;
  const dumb = env["TERM"] === "dumb";
  const colorOff = isSet(env, "NO_COLOR") || dumb;
  const colorOf = (isTerminal: boolean): boolean =>
    color === "always" || (color === "auto" && !colorOff && isTerminal);
  const ci = isSet(env, "CI");
  return {
    colorStdout: colorOf(inputs.stdoutIsTerminal),
    colorStderr: colorOf(inputs.stderrIsTerminal),
    spinner:
      inputs.stderrIsTerminal &&
      !ci &&
      !dumb &&
      inputs.logFormat === "text" &&
      inputs.level !== "error" &&
      inputs.level !== "off",
  };
}

/** The ANSI styles the CLI uses. */
export type Style = "red" | "green" | "yellow" | "dim" | "bold";

const ANSI: Readonly<Record<Style, string>> = {
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  dim: "\u001B[2m",
  bold: "\u001B[1m",
};
const RESET = "\u001B[0m";

/**
 * A function that wraps text in an ANSI style when `enabled`, and returns it unchanged otherwise.
 *
 * @param enabled - Whether the stream is coloured.
 * @returns The styling function.
 */
export function painter(enabled: boolean): (style: Style, text: string) => string {
  return (style, text) => (enabled ? `${ANSI[style]}${text}${RESET}` : text);
}
