/**
 * API key redaction (R-SEC-1, R-AX-9). The error class and the HTTP layer's logger both go through
 * {@link redact}, so there is one rule for what counts as a secret.
 *
 * Every pattern runs in linear time: each one starts at most once per position, behind a
 * lookbehind or a fixed prefix, and every repetition is bounded or ends at a character the
 * repetition cannot contain. A 1 MB explorer answer, such as hex bytecode, is redacted in
 * milliseconds.
 */
import type { Logger } from "./types.ts";

/** What every redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** Known secrets shorter than this are ignored: they would match noise and corrupt the marker. */
export const MIN_SECRET_LENGTH = 8;

// Where a parameter name may start: not after a letter or digit, or after a JSON-escaped newline,
// carriage return or tab, or after a percent-encoded `&`, `#` or `?` (encoded any number of times).
const NAME_START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt])|(?<=%(?:25)*(?:26|23|3f)))`;
// A parameter value: runs to a separator, a quote, a backslash or an encoded separator. It
// continues through other percent escapes, so an encoded key is redacted whole.
const VALUE = String.raw`(?:[^%&#;\s"'<>\\]|%(?!(?:25)*(?:26|23|3b|22|27|20))(?:[0-9a-f]{2})?)+`;
// `=`, raw or percent-encoded any number of times.
const EQUALS = "(?:=|%(?:25)*3d)";

/**
 * The redaction patterns, in the order they run. Exported for the tests, which time each one on
 * adversarial input.
 */
export const REDACTION_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // `apikey`, `api_key`, `api-key` and `x-api-key`, followed by `=`, or by `:` with spaces.
  {
    pattern: new RegExp(
      String.raw`${NAME_START}((?:x-)?api[_-]?key(?:[ \t]{0,16}[:=][ \t]{0,16}|%(?:25)*3d))${VALUE}`,
      "gi",
    ),
    replacement: `$1${REDACTED}`,
  },
  // Other key-like parameter names, followed by `=`.
  {
    pattern: new RegExp(
      String.raw`${NAME_START}((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|key|auth|secret|password)${EQUALS})${VALUE}`,
      "gi",
    ),
    replacement: `$1${REDACTED}`,
  },
  // A JSON member such as `"apiKey": "..."`.
  {
    pattern: /("(?:x-)?api[_-]?key"[ \t]{0,16}:[ \t]{0,16}")[^"\\]*/gi,
    replacement: `$1${REDACTED}`,
  },
  // The user name and password of a URL, such as `https://user:pass@host`. The scheme starts at
  // most once per URL and both parts are bounded.
  {
    pattern: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s?#@]{1,256}@/gi,
    replacement: `$1${REDACTED}@`,
  },
  // An HTTP bearer token. The value must look like a token, so "bearer of bad news" stays.
  {
    pattern: /(?<![A-Za-z0-9])(bearer[ \t]{1,16})[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1${REDACTED}`,
  },
  // A bare Etherscan-style key: 34 uppercase letters and digits, with at least one of each.
  {
    pattern:
      /(?<![A-Za-z0-9])(?=[A-Z0-9]{0,33}[A-Z])(?=[A-Z0-9]{0,33}[0-9])[A-Z0-9]{34}(?![A-Za-z0-9])/g,
    replacement: REDACTED,
  },
];

/** The ways a secret can appear in text: as is, URL-encoded and form-encoded. */
function forms(secret: string): string[] {
  const all = [secret, new URLSearchParams({ s: secret }).toString().slice(2)];
  try {
    all.push(encodeURIComponent(secret));
  } catch {
    // A lone surrogate cannot be URL-encoded; the other forms still apply.
  }
  return all;
}

/** One pattern that matches every form of every known secret, longest first, in any case. */
function secretPattern(secrets: readonly string[]): RegExp | undefined {
  const all = new Set<string>();
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      for (const form of forms(secret)) {
        all.add(form);
      }
    }
  }
  if (all.size === 0) {
    return undefined;
  }
  const escaped = [...all]
    .toSorted((a, b) => b.length - a.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`));
  return new RegExp(escaped.join("|"), "gi");
}

/**
 * Replaces every secret in `text` with `[redacted]`:
 *
 * - each value in `secrets` of at least 8 characters, in any case, also URL-encoded and
 *   form-encoded;
 * - the value of a key-like query, fragment or form parameter (`apikey`, `api_key`, `x-api-key`,
 *   `key`, `token`, `access_token`, `refresh_token`, `client_secret`, `auth`, `secret`,
 *   `password`, in any case), even when the value is not known, also percent-encoded inside
 *   another URL;
 * - a JSON `"apikey"` member, the user name and password of a URL, a bearer token;
 * - a bare 34-character Etherscan-style key.
 *
 * @param text - Any string that may hold a key, such as a URL or an explorer's response body.
 * @param secrets - Key values known to the caller.
 * @returns The text with every secret replaced.
 * @example
 * ```ts
 * redact("GET https://api.example.org/api?module=contract&apikey=ABC123", []);
 * // "GET https://api.example.org/api?module=contract&apikey=[redacted]"
 * ```
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  const known = secretPattern(secrets);
  let result = known === undefined ? text : text.replace(known, REDACTED);
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// Covers a pattern-based secret, such as a bare 34-character key, cut at the end of the window.
const EXCERPT_MARGIN = 64;

/**
 * The first `length` characters of `text`, redacted. Only a window of `text` is redacted, so a
 * long answer costs no more than a short one. Redaction runs before the final cut, and the
 * window's last part is dropped, so a cut can never leave part of a key behind.
 *
 * @param text - An explorer's answer, of any length.
 * @param secrets - Key values known to the caller.
 * @param length - The longest excerpt to return.
 * @returns At most `length` characters, redacted.
 * @example
 * ```ts
 * redactExcerpt("<html>... 1 MB ...</html>", [], 300).length; // at most 300
 * ```
 */
export function redactExcerpt(text: string, secrets: readonly string[], length: number): string {
  let longest = 0;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      for (const form of forms(secret)) {
        longest = Math.max(longest, form.length);
      }
    }
  }
  const tail = longest + EXCERPT_MARGIN;
  // Twice what is needed, so that redaction can shrink the text and still leave `length`.
  const window = 2 * (length + tail);
  if (text.length <= window) {
    return redact(text, secrets).slice(0, length);
  }
  const redacted = redact(text.slice(0, window), secrets);
  return redacted.slice(0, Math.max(0, Math.min(length, redacted.length - tail)));
}

/** `value` as text for a log line. Never throws; a value that cannot be read is `[unloggable]`. */
function loggable(value: unknown, secrets: readonly string[]): string {
  try {
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else if (value instanceof Error) {
      text = `${value.name}: ${value.message}`;
    } else if (typeof value === "object" && value !== null) {
      text = JSON.stringify(value);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      text = String(value);
    } else if (typeof value === "symbol") {
      text = value.toString();
    } else {
      text = value === null ? "null" : typeof value;
    }
    return redact(text, secrets);
  } catch {
    return "[unloggable]";
  }
}

/**
 * Wraps a logger so that every argument passes through {@link redact} before it reaches the
 * caller's logger (R-SEC-1). It never throws: a value it cannot turn into text is logged as
 * `[unloggable]`. Extra arguments are kept, each redacted. The entry point wraps the caller's
 * logger once per call; the HTTP layer logs through that wrapper only.
 *
 * @param logger - The caller's logger.
 * @param secrets - Key values to remove, such as the API key for this call.
 * @returns A logger with the same four methods.
 * @example
 * ```ts
 * const apiKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";
 * const log = redactingLogger(console, [apiKey]);
 * log.debug(`GET https://api.example.org/api?apikey=${apiKey}`); // prints apikey=[redacted]
 * ```
 */
export function redactingLogger(logger: Logger, secrets: readonly string[] = []): Logger {
  const wrap =
    (method: keyof Logger) =>
    (message: string, ...rest: unknown[]): void => {
      const args = [message, ...rest].map((value) => loggable(value, secrets));
      Reflect.apply(logger[method], logger, args);
    };
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}
