/**
 * How error messages name a time budget. Internal: not exported from the package entry point.
 */

/**
 * A time budget as a person reads it: in seconds from 1 s, as `4 s` or `1.5 s`, and in
 * milliseconds below, as `500 ms`. The number in milliseconds stays in `details.timeoutMs`.
 *
 * @param ms - The budget in milliseconds.
 * @returns The budget with its unit.
 */
export function budgetText(ms: number): string {
  return ms >= 1_000 ? `${String(ms / 1_000)} s` : `${String(ms)} ms`;
}
