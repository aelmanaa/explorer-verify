// References: R-AX-10, R-AX-9.
/**
 * The closest match for a mistyped command or option name. The suggestion is always one
 * of the CLI's own names, never text the caller typed, so a mistyped key is never repeated.
 */

/** Names shorter than this are not compared: a one- or two-letter typo matches too much. */
const MIN_LENGTH = 3;

/**
 * The optimal string alignment distance between two strings: insertions, deletions,
 * substitutions and swaps of two neighbouring characters each cost 1.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns The distance.
 */
export function editDistance(a: string, b: string): number {
  // d[i * width + j] is the distance between the first i characters of a and the first j of b.
  const width = b.length + 1;
  const d: number[] = [];
  const at = (i: number, j: number): number => Number(d[i * width + j]);
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      if (i === 0 || j === 0) {
        d.push(i + j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      d.push(best);
    }
  }
  return at(a.length, b.length);
}

/**
 * The single closest name to `typed`, or `undefined` when none is close. A name is close when the
 * distance is at most a third of its length, and at least 1. Of two names at the same distance,
 * the first in `names` wins, so the result does not depend on anything but the table's order.
 * A name whose length differs from `typed` by more than its limit is skipped without comparing,
 * so a long input, such as a pasted key, takes constant time.
 *
 * @param typed - What the caller typed, without any leading `--`.
 * @param names - The names to compare against, in help order.
 * @returns The closest name, or `undefined`.
 */
export function closest(typed: string, names: readonly string[]): string | undefined {
  if (typed.length < MIN_LENGTH) {
    return undefined;
  }
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const limit = Math.max(1, Math.floor(name.length / 3));
    // The length difference is a lower bound on the distance, so a long input costs nothing.
    if (
      name.length < MIN_LENGTH ||
      name === typed ||
      Math.abs(typed.length - name.length) > limit
    ) {
      continue;
    }
    const distance = editDistance(typed, name);
    if (distance <= limit && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best?.name;
}
