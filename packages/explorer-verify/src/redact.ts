/**
 * API key redaction (R-SEC-1, R-AX-9). The error class and the HTTP layer's logger both go through
 * {@link redact}, so there is one rule for what counts as a secret.
 *
 * Every pattern runs in linear time: each one starts at most once per position, behind a
 * lookbehind or a fixed prefix, and every repetition is bounded or ends at a character the
 * repetition cannot contain. A 1 MB explorer answer, such as hex bytecode, is redacted in
 * milliseconds.
 */
import type { LogFields, Logger, LogValue } from "./types.ts";

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
// The API key parameter names: `apikey`, `api_key`, `api-key` and `x-api-key`, in any case.
const API_KEY_NAME = "(?:x-)?api[_-]?key";
// Other key-like parameter names.
const KEY_LIKE_NAME =
  "(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|key|auth|secret|password)";

// The bounds of the patterns below. The excerpt margin is derived from them, so they cannot drift.
// The most spaces or tabs around `:` or `=`, and after `bearer`.
const SPACING = 16;
// The longest URL scheme, such as `https`.
const SCHEME = 32;
// The longest URL user info, `user:password`.
const USERINFO = 256;
// The fewest characters of a bearer token.
const BEARER_TOKEN = 8;
// The length of a bare Etherscan-style key.
const BARE_KEY = 34;
// The most escape sequences, such as `\"`, that a JSON apikey member value runs through.
const JSON_ESCAPES = 1024;
const JSON_NAME = '"x-api-key"';
// A bare Etherscan-style key: 34 uppercase letters and digits, with at least one of each.
const BARE_KEY_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?=[A-Z0-9]{0,${String(BARE_KEY - 1)}}[A-Z])(?=[A-Z0-9]{0,${String(BARE_KEY - 1)}}[0-9])[A-Z0-9]{${String(BARE_KEY)}}(?![A-Za-z0-9])`,
  "g",
);

/**
 * The redaction patterns, in the order they run. A pattern runs only when the lower-cased text
 * holds one of its `needs` (or always, when `needs` is empty), so text with nothing to redact,
 * such as bytecode, costs one scan. Exported for the tests, which time each pattern on adversarial
 * input.
 */
export const REDACTION_PATTERNS: readonly {
  pattern: RegExp;
  replacement: string;
  needs: readonly string[];
}[] = [
  // `apikey`, `api_key`, `api-key` and `x-api-key`, followed by `=`, or by `:` with spaces.
  {
    pattern: new RegExp(
      String.raw`${NAME_START}(${API_KEY_NAME}(?:[ \t]{0,${String(SPACING)}}[:=][ \t]{0,${String(SPACING)}}|%(?:25)*3d))${VALUE}`,
      "gi",
    ),
    replacement: `$1${REDACTED}`,
    needs: ["key"],
  },
  // Other key-like parameter names, followed by `=`.
  {
    pattern: new RegExp(String.raw`${NAME_START}(${KEY_LIKE_NAME}${EQUALS})${VALUE}`, "gi"),
    replacement: `$1${REDACTED}`,
    needs: ["key", "token", "auth", "secret", "password"],
  },
  // A JSON member such as `"apiKey": "..."`. The value runs through up to 1024 escape sequences
  // such as `\"` and `\\`, so a key that holds a quote or a backslash is redacted whole. The value
  // is written as runs between escapes: V8 keeps one backtrack entry per repetition, so a
  // repetition per character overflows the stack on a value of a few megabytes.
  {
    pattern: new RegExp(
      String.raw`("${API_KEY_NAME}"[ \t]{0,${String(SPACING)}}:[ \t]{0,${String(SPACING)}}")[^"\\]*(?:\\[^][^"\\]*){0,${String(JSON_ESCAPES)}}`,
      "gi",
    ),
    replacement: `$1${REDACTED}`,
    needs: ["key"],
  },
  // The user name and password of a URL, such as `https://user:pass@host`. The scheme starts at
  // most once per URL and both parts are bounded.
  {
    pattern: new RegExp(
      String.raw`(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,${String(SCHEME - 1)}}:\/\/)[^/\s?#@]{1,${String(USERINFO)}}@`,
      "gi",
    ),
    replacement: `$1${REDACTED}@`,
    needs: ["://"],
  },
  // An HTTP bearer token. The value must look like a token, so "bearer of bad news" stays.
  {
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9])(bearer[ \t]{1,${String(SPACING)}})[A-Za-z0-9._~+/=-]{${String(BEARER_TOKEN)},}`,
      "gi",
    ),
    replacement: `$1${REDACTED}`,
    needs: ["bearer"],
  },
  // A bare Etherscan-style key. A handle's job id skips it: see redactJobId.
  {
    pattern: BARE_KEY_PATTERN,
    replacement: REDACTED,
    needs: [],
  },
];

/** `text` with every character other than an ASCII letter or digit written as `\uXXXX`. */
function unicodeEscaped(text: string): string {
  let escaped = "";
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    escaped += /[A-Za-z0-9]/.test(char)
      ? char
      : `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

/**
 * The ways a secret can appear in text: as is, JSON-escaped (once, twice, and with every
 * character other than a letter or digit as `\uXXXX`), URL-encoded, form-encoded, and as the
 * WHATWG URL parser encodes it in a query string and in a path. An explorer that echoes a key in
 * a JSON body escapes a `"` or a `\` in it; one that echoes a JSON text inside another escapes it
 * twice; some encoders write `"`, `+`, `<`, `>`, `&` and `'` as `\uXXXX`. No form is shorter than
 * the secret. The parser leaves characters such as `'` and `~` raw that `encodeURIComponent`
 * encodes, so an explorer that echoes a parsed URL shows a form the others miss.
 */
function forms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const all = [
    secret,
    json,
    JSON.stringify(json).slice(1, -1),
    unicodeEscaped(secret),
    new URLSearchParams({ s: secret }).toString().slice(2),
  ];
  // Encoding never shortens a value, so a shorter result means the parser cut the secret at a `#`
  // or `?`. That piece is dropped: a short piece would match unrelated text.
  for (const parsed of [
    new URL(`http://h/?q=${secret}`).search.slice(3),
    new URL(`http://h/${secret}`).pathname.slice(1),
  ]) {
    if (parsed.length >= secret.length) {
      all.push(parsed);
    }
  }
  try {
    const encoded = encodeURIComponent(secret);
    // Encoded twice: a URL carried inside another URL's parameter, as a redirect target.
    all.push(encoded, encodeURIComponent(encoded));
  } catch {
    // A lone surrogate cannot be URL-encoded; the other forms still apply.
  }
  return all;
}

/**
 * One pattern that matches every form of every known secret that `upper` holds, longest first,
 * in any case. The check upper-cases both sides, as the `i` flag does character by character;
 * lower-casing would differ, for example on a Greek final sigma.
 */
function secretPattern(secrets: readonly string[], upper: string): RegExp | undefined {
  const all = new Set<string>();
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      for (const form of forms(secret)) {
        if (upper.includes(form.toUpperCase())) {
          all.add(form);
        }
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
  const known = secretPattern(secrets, text.toUpperCase());
  const result = known === undefined ? text : text.replace(known, REDACTED);
  return redactPatterns(result);
}

/**
 * {@link redact} for the job id of a handle: every rule except the bare-key shape. An explorer may
 * issue a job id of 34 upper-case letters and digits, and redacting it would make the handle
 * impossible to resume. A job id equal to a known secret is still redacted.
 *
 * @param jobId - The job id of a handle.
 * @param secrets - Key values known to the caller.
 * @returns The job id with every secret replaced.
 * @example
 * ```ts
 * redactJobId("JOB0123456789ABCDEFGHIJKLMNOPQRSTU", []); // unchanged
 * ```
 */
export function redactJobId(jobId: string, secrets: readonly string[]): string {
  const known = secretPattern(secrets, jobId.toUpperCase());
  const result = known === undefined ? jobId : jobId.replace(known, REDACTED);
  return redactPatterns(result, BARE_KEY_PATTERN);
}

/** `text` with every pattern in {@link REDACTION_PATTERNS} applied, except `skip`. */
function redactPatterns(text: string, skip?: RegExp): string {
  const lower = text.toLowerCase();
  let result = text;
  for (const { pattern, replacement, needs } of REDACTION_PATTERNS) {
    if (pattern === skip) {
      continue;
    }
    if (needs.length === 0 || needs.some((need) => lower.includes(need))) {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

/**
 * The longest text a pattern can need to see before it matches. When the excerpt window ends
 * inside such a text, the part before the cut stays unredacted, so the excerpt drops this many
 * characters from the window's end. The longest is URL user info: the scheme, `://`, the user
 * name and password, and `@`.
 */
export const EXCERPT_MARGIN: number = Math.max(
  SCHEME + "://".length + USERINFO + "@".length,
  "bearer".length + SPACING + BEARER_TOKEN,
  JSON_NAME.length + SPACING + ":".length + SPACING + '"'.length,
  BARE_KEY + 1,
);

/**
 * The first `length` characters of `text`, redacted. Only a window of `text` is redacted, so a
 * long answer costs no more than a short one. Redaction runs before the final cut, and the
 * window's last part, as long as the longest known secret plus {@link EXCERPT_MARGIN}, is
 * dropped. So the excerpt never shows part of a known secret or of a text that a pattern would
 * have redacted in the full answer. A key with no pattern, such as a key in a URL path that the
 * caller did not pass, is not covered.
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
 * A field value for a log line: a number, a boolean or `null` as is, a string redacted, and any
 * other value as redacted text. Never throws.
 */
function loggableValue(value: unknown, secrets: readonly string[]): LogValue {
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return loggable(value, secrets);
}

/**
 * The fields of a log line with every name and value redacted, in a new object. `Object.entries`
 * and `Object.fromEntries` read and define own properties only, so a field named `__proto__`
 * stays a field.
 */
function loggableFields(fields: LogFields, secrets: readonly string[]): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [
      loggable(name, secrets),
      typeof value === "string" && KEY_NAME_FIELD.test(name)
        ? REDACTED
        : loggableValue(value, secrets),
    ]),
  );
}

/**
 * A field name that holds a key, such as `apikey` or `token`: the parameter names the redaction
 * patterns use. A string value of such a field is replaced whole, even when the key is not known.
 */
const KEY_NAME_FIELD = new RegExp(`^(?:${API_KEY_NAME}|${KEY_LIKE_NAME})$`, "i");

/**
 * Wraps a logger so that the message and every field name and value pass through {@link redact}
 * before they reach the caller's logger (R-SEC-1, R-DX-5). The fields are a new object; the
 * caller's method gets no second argument when there are no fields, so `console` prints no
 * `undefined`.
 *
 * It never throws. A value it cannot turn into text is logged as `[unloggable]`. When the caller's
 * method throws, or is not a function, the line is dropped: a broken logger must not change the
 * outcome of a verification, and there is nowhere else to report it.
 *
 * @param logger - The caller's logger.
 * @param secrets - Key values to remove, such as the API key for this call.
 * @returns A logger with the same four methods.
 * @example
 * ```ts
 * const apiKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";
 * const log = redactingLogger(console, [apiKey]);
 * log.debug("request", { url: `https://api.example.org/api?apikey=${apiKey}` });
 * // prints request { url: 'https://api.example.org/api?apikey=[redacted]' }
 * ```
 */
export function redactingLogger(logger: Logger, secrets: readonly string[] = []): Logger {
  const wrap =
    (method: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      try {
        const args =
          fields === undefined
            ? [loggable(message, secrets)]
            : [loggable(message, secrets), loggableFields(fields, secrets)];
        const returned: unknown = Reflect.apply(logger[method], logger, args);
        if (returned !== undefined) {
          // An async logger method returns a promise. A rejection would be unhandled and stop a
          // Node process, so it is caught and dropped, like a throw. It is not awaited.
          void new Promise<unknown>((resolve) => {
            resolve(returned);
          }).catch(() => {});
        }
      } catch {
        // The caller's logger threw: drop the line (see above).
      }
    };
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}
