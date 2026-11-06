/**
 * The check for unknown option keys (R-IN-6): every public function refuses an options object
 * with a key it does not read, and suggests the closest name it does read. Internal: not exported
 * from the package entry point. A copy of the core's `src/internal/known-keys.ts`; a core test
 * keeps the two the same.
 */
import type { InputIssue } from "explorer-verify";

/** Keys shorter than this get no suggestion: a one- or two-letter key matches too much. */
const MIN_LENGTH = 3;

/**
 * A key named in an issue: an identifier of at most 32 characters with fewer than 8 digits. Any
 * other key is not repeated, because a long or key-shaped name may be a secret pasted in the
 * wrong place (R-SEC-1).
 */
const NAMEABLE = /^(?!(?:\D*\d){8})[A-Za-z_$][\w$-]{0,31}$/;

/**
 * The own enumerable string keys of `value`, as `Object.keys()` gives them, without reading any
 * value: a getter never runs. `undefined` when `value` is not a non-array object, or when listing
 * its keys throws, as a hostile Proxy does.
 *
 * @param value - The caller's options.
 * @returns The keys, or `undefined`.
 */
export function ownKeys(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    return Array.isArray(value) ? undefined : Object.keys(value);
  } catch {
    return undefined;
  }
}

/**
 * The known name `typed` may mean: one equal to it ignoring case, or one of which it is a prefix,
 * or the other way round, ignoring case. The shortest such name wins, then the first in `names`.
 *
 * @param typed - The unknown key.
 * @param names - The known names, in documentation order.
 * @returns The suggestion, or `undefined`.
 */
function closest(typed: string, names: readonly string[]): string | undefined {
  if (typed.length < MIN_LENGTH) {
    return undefined;
  }
  const lower = typed.toLowerCase();
  let best: string | undefined;
  for (const name of names) {
    const other = name.toLowerCase();
    if (
      (lower.startsWith(other) || other.startsWith(lower)) &&
      (best === undefined || name.length < best.length)
    ) {
      best = name;
    }
  }
  return best;
}

/**
 * An issue for each key of `keys` that is not in `known`. The issue names the key, after
 * `prefix`, and the closest known name when one is close; it never holds the key's value. A key
 * that is not a short identifier with few digits is not repeated: its issue names the object,
 * `prefix` without its dot or `fallback` when there is no prefix. Callers pass the own enumerable string keys, as {@link ownKeys}
 * gives them.
 *
 * @param keys - The keys of the caller's object.
 * @param known - The keys the function reads, in documentation order.
 * @param prefix - What goes before each key in the issue's field, such as `route.`; empty for
 *   top-level options.
 * @param fallback - The field of an issue for a key that is not repeated, when `prefix` is empty.
 * @returns The issues, in the object's key order; empty when every key is known.
 * @example
 * ```ts
 * unknownKeys(["timeout"], ["timeoutMs"], "", "options");
 * // [{ field: "timeout", message: "is not a known option; did you mean timeoutMs?" }]
 * ```
 */
export function unknownKeys(
  keys: Iterable<string>,
  known: readonly string[],
  prefix: string,
  fallback: string,
): InputIssue[] {
  const issues: InputIssue[] = [];
  for (const key of keys) {
    if (known.includes(key)) {
      continue;
    }
    const named = NAMEABLE.test(key);
    const suggestion = named ? closest(key, known) : undefined;
    issues.push({
      field: named ? prefix + key : prefix.slice(0, -1) || fallback,
      message: `is not a known option${suggestion === undefined ? "" : `; did you mean ${suggestion}?`}`,
    });
  }
  return issues;
}
