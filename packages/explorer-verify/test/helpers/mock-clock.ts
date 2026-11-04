/**
 * Drives a call that runs on Node's mock timers until it settles.
 *
 * `verify()`, `checkStatus()` and `dryRun()` load their explorer client with a dynamic `import()`
 * before the first request (decision 0031). The first import in a process takes real event-loop
 * turns: 14 to 17 on Node 24.0.0 measured locally, and more on a loaded CI runner. The time budget
 * starts before the load. A driver that moves the mock clock on every turn spends the budget
 * during the load: in CI on Node 24.0.0, a driver that moved it 500 ms per turn spent the whole
 * 120-second budget, and the first request failed with `timeout`. A driver that stops after a
 * fixed number of turns can stop before the load ends.
 *
 * {@link driveMockClock} avoids both: on each turn it runs only the timers that are pending, which
 * moves the clock only when the call waits on a timer, and it allows {@link MAX_TURNS} turns.
 */
import { setImmediate } from "node:timers/promises";

/** The most real turns {@link driveMockClock} gives a call, far more than any load takes. */
const MAX_TURNS = 100_000;

/** Options of {@link driveMockClock}. */
export interface DriveOptions {
  /** Called after each real turn, before the timers run. */
  readonly onTurn?: () => void;
  /** The most real turns to allow. Defaults to {@link MAX_TURNS}. */
  readonly maxTurns?: number;
}

/**
 * Lets one real event-loop turn pass. `setImmediate` is not among the mocked APIs, so the turn is
 * real: I/O, such as a dynamic `import()`, and promise callbacks make progress.
 */
async function nextTurn(): Promise<void> {
  await setImmediate();
}

/**
 * Turns the event loop until `call` settles. After each turn, while the call has not settled, it
 * calls `runTimers`, which should be `mock.timers.runAll()`: it fires every pending timer and
 * moves the clock to the last of them, and does nothing when no timer is pending. So the clock
 * stands still while the call loads its client, and a poll interval or a budget passes at once.
 *
 * It resolves when `call` settles, whether `call` resolves or rejects; the caller awaits `call`
 * for its outcome. It rejects when the call has not settled after `maxTurns` turns.
 *
 * @example
 * ```ts
 * const pending = verify(input, { fetch });
 * await driveMockClock(pending, () => t.mock.timers.runAll());
 * const result = await pending;
 * ```
 */
export async function driveMockClock(
  call: Promise<unknown>,
  runTimers: () => void,
  { onTurn, maxTurns = MAX_TURNS }: DriveOptions = {},
): Promise<void> {
  const state = { settled: false };
  const settle = (): void => {
    state.settled = true;
  };
  call.then(settle, settle);
  for (let turn = 0; turn < maxTurns; turn += 1) {
    await nextTurn();
    onTurn?.();
    if (state.settled) {
      return;
    }
    runTimers();
  }
  throw new Error(`the call did not settle within ${String(maxTurns)} event-loop turns`);
}

/**
 * Turns the event loop, without running a timer, until `condition` holds, such as "the call has
 * submitted". Use it in place of a fixed number of turns, which a slow first client load can
 * outlast. It rejects when `condition` still fails after `maxTurns` turns.
 *
 * @example
 * ```ts
 * await turnUntil(() => events.includes("verify.submitted"));
 * ```
 */
export async function turnUntil(
  condition: () => boolean,
  maxTurns: number = MAX_TURNS,
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (condition()) {
      return;
    }
    await nextTurn();
  }
  throw new Error(`the condition did not hold within ${String(maxTurns)} event-loop turns`);
}
