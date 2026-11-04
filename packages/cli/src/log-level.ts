/**
 * The log level and format of stderr (R-AX-14, R-AX-15). `--quiet` sets `error`, `--verbose` sets
 * `debug`, and `EXPLORER_VERIFY_LOG` sets the level when no flag does. The default is `info`.
 */

/** Every level, from the most verbose. `off` shows nothing on stderr. */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "off"] as const;

/** One of {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The level of one stderr line. `off` is a threshold only, never a line's level. */
export type LineLevel = Exclude<LogLevel, "off">;

/** The values of `--log-format`. */
export const LOG_FORMATS = ["text", "json"] as const;

/** One of {@link LOG_FORMATS}. */
export type LogFormat = (typeof LOG_FORMATS)[number];

/** The environment variable that sets the level when no flag does. */
export const LOG_VARIABLE = "EXPLORER_VERIFY_LOG";

/**
 * Whether a line at `line` level reaches stderr at the `threshold` level.
 *
 * @param line - The level of the line.
 * @param threshold - The level in effect.
 * @returns `true` when the line is shown.
 */
export function shows(line: LineLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS.indexOf(line) >= LOG_LEVELS.indexOf(threshold);
}

/** The level `EXPLORER_VERIFY_LOG` sets, and whether it held a value that is not a level. */
export interface EnvironmentLevel {
  /** The level, when the variable holds one. */
  level?: LogLevel;
  /** `true` when the variable is set to a value that is not a level. */
  invalid: boolean;
}

/**
 * Reads `EXPLORER_VERIFY_LOG`. An unset or empty variable sets nothing. A value that is not one of
 * {@link LOG_LEVELS}, compared exactly, sets nothing and is reported as invalid; the caller warns
 * without repeating the value.
 *
 * @param value - The variable's value.
 * @returns The level, or that the value is invalid.
 */
export function environmentLevel(value: string | undefined): EnvironmentLevel {
  if (value === undefined || value === "") {
    return { invalid: false };
  }
  const level = LOG_LEVELS.find((known) => known === value);
  return level === undefined ? { invalid: true } : { level, invalid: false };
}

/**
 * The level in effect: `--quiet` gives `error`, `--verbose` gives `debug`, otherwise the
 * environment's level, otherwise `info`. The caller rejects `--quiet` with `--verbose` first.
 *
 * @param flags - Whether `--quiet` and `--verbose` were given.
 * @param fromEnvironment - The level `EXPLORER_VERIFY_LOG` sets, if any.
 * @returns The level.
 */
export function effectiveLevel(
  flags: { quiet: boolean; verbose: boolean },
  fromEnvironment: LogLevel | undefined,
): LogLevel {
  if (flags.quiet) {
    return "error";
  }
  if (flags.verbose) {
    return "debug";
  }
  return fromEnvironment ?? "info";
}
