import assert from "node:assert/strict";

const SMALL = 1 << 16;
const LARGE = 1 << 20;
// Rounds of each measurement. The two measurements alternate, so load from other processes falls
// on both, and the fastest round of each is compared. After 3 rounds, more run only while the
// check fails, up to 20: a busy machine can preempt several rounds in a row.
const ROUNDS = 3;
const MAX_ROUNDS = 20;
// Linear code costs about the same on the two sides of each comparison, up to about 6 times as
// much on one large string under load; quadratic code at least 16 times as much. 8 sits between.
const MAX_RATIO = 8;
// Below this, a timing is mostly noise, so the fast side counts as at least this long.
const NOISE_MS = 2;
// A ceiling far above any linear run, even on a busy machine.
const CEILING_MS = 2_000;

/** Milliseconds that one call of `run` takes. */
function time(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/**
 * Times `slow` and `fast` in alternating rounds and asserts that the fastest `slow` round takes
 * less than 8 times the fastest `fast` round, and less than 2 s.
 */
function assertRatio(name: string, fast: () => void, slow: () => void): void {
  let fastMs = Number.POSITIVE_INFINITY;
  let slowMs = Number.POSITIVE_INFINITY;
  const passes = (): boolean =>
    slowMs < MAX_RATIO * Math.max(NOISE_MS, fastMs) && slowMs < CEILING_MS;
  // Stops early once linear code passes, or once the slow side is over the ceiling, which no
  // later round can undo.
  for (let round = 0; round < MAX_ROUNDS && (round < ROUNDS || !passes()); round++) {
    fastMs = Math.min(fastMs, time(fast));
    slowMs = Math.min(slowMs, time(slow));
    if (slowMs >= CEILING_MS) {
      break;
    }
  }
  assert.ok(passes(), `${name}: ${slowMs.toFixed(1)} ms against ${fastMs.toFixed(1)} ms`);
}

/**
 * Asserts that `run` takes linear time: one call on a 1 MB input costs less than 8 times the 16
 * calls on a 64 KB input that cover the same length, and less than 2 s. Quadratic code costs 16
 * times as much on the 1 MB input. The comparison is between runs of the same length, timed in
 * alternating rounds, so a busy machine slows both sides alike and cannot fail the check.
 *
 * @param name - What is timed, for the failure message.
 * @param make - Builds the input at a given size in characters.
 * @param run - The code under test.
 */
export function assertLinear(
  name: string,
  make: (size: number) => string,
  run: (text: string) => void,
): void {
  const small = make(SMALL);
  const large = make(LARGE);
  assertRatio(
    name,
    () => {
      for (let part = 0; part < LARGE / SMALL; part++) {
        run(small);
      }
    },
    () => {
      run(large);
    },
  );
}

/**
 * Asserts that `run` costs about the same on two inputs of the same size: less than 8 times as
 * long on `slow` as on `fast`, and less than 2 s. It catches work that is quadratic in the length
 * of a line or a run inside the input, which a size comparison cannot see when that length is
 * bounded.
 *
 * @param name - What is timed, for the failure message.
 * @param fast - An input that linear and quadratic code both handle quickly.
 * @param slow - An input of the same size that only quadratic code handles slowly.
 * @param run - The code under test.
 */
export function assertSameCost(
  name: string,
  fast: string,
  slow: string,
  run: (text: string) => void,
): void {
  assertRatio(
    name,
    () => {
      run(fast);
    },
    () => {
      run(slow);
    },
  );
}
