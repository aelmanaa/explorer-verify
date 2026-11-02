/**
 * API key redaction (R-SEC-1, R-AX-9). The error class and the HTTP layer's logger both go through
 * {@link redact}, so there is one rule for what counts as a secret.
 */
import type { Logger } from "./types.ts";

/** What every redacted value is replaced with. */
export const REDACTED = "[redacted]";

// A query, fragment or form parameter whose name marks it as a secret, followed by `=`. The name
// must start the string or follow a separator, so `monkey=` and `tokenizer=` do not match. The
// separators and `=` also match percent-encoded, for a URL inside another URL's query. The value
// runs to the next separator, quote or `%`.
const SECRET_PARAM =
  /(^|[?&#;\s"']|%3f|%26|%23)((?:api[_-]?key|key|access[_-]?token|token|auth|secret|password)(?:=|%3d))[^&#\s"'<>;%]*/gi;
// The user name and password in a URL, such as `https://user:pass@host`.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]*@/gi;
// An HTTP bearer token, as it appears in a logged `Authorization` header.
const BEARER = /(\bbearer\s+)[^\s"'<>,;]+/gi;

/**
 * Replaces every secret in `text` with `[redacted]`: each value in `secrets`, the value of any
 * key-like query, fragment or form parameter (`apikey`, `api_key`, `key`, `token` and similar,
 * in any case) even when the value is not known, the user name and password of a URL, and a
 * bearer token.
 *
 * @param text - Any string that may hold a key, such as a URL or an explorer's response body.
 * @param secrets - Key values known to the caller, also matched in their URL-encoded form. Empty
 *   strings are ignored.
 * @returns The text with every secret replaced.
 * @example
 * ```ts
 * redact("GET https://api.example.org/api?module=contract&apikey=ABC123", []);
 * // "GET https://api.example.org/api?module=contract&apikey=[redacted]"
 * ```
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.replaceAll(secret, REDACTED).replaceAll(encoded(secret), REDACTED);
    }
  }
  return result
    .replace(SECRET_PARAM, `$1$2${REDACTED}`)
    .replace(USERINFO, `$1${REDACTED}@`)
    .replace(BEARER, `$1${REDACTED}`);
}

/** The URL-encoded form of `secret`, or `secret` itself when it cannot be encoded (a lone surrogate). */
function encoded(secret: string): string {
  try {
    return encodeURIComponent(secret);
  } catch {
    return secret;
  }
}

/**
 * Wraps a logger so that every message passes through {@link redact} before it reaches the
 * caller's logger (R-SEC-1). The HTTP layer logs through this wrapper only.
 *
 * @param logger - The caller's logger.
 * @param secrets - Key values to remove, such as the API key for this call.
 * @returns A logger with the same four methods.
 * @example
 * ```ts
 * const log = redactingLogger(console, [apiKey]);
 * log.debug(`GET ${url}`); // the key in url prints as [redacted]
 * ```
 */
export function redactingLogger(logger: Logger, secrets: readonly string[] = []): Logger {
  return {
    debug: (message) => {
      logger.debug(redact(message, secrets));
    },
    info: (message) => {
      logger.info(redact(message, secrets));
    },
    warn: (message) => {
      logger.warn(redact(message, secrets));
    },
    error: (message) => {
      logger.error(redact(message, secrets));
    },
  };
}
