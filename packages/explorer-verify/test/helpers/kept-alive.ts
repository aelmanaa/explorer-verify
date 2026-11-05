// Keeps the process alive while a test waits on a load deadline. The deadline of a bounded load
// runs on `AbortSignal.timeout`, which Node 22 does not count as keeping the event loop alive, and
// a loader that never settles holds no handle: without an interval, the test runner sees an empty
// event loop and cancels the test before the deadline fires.

/**
 * Runs `work` with a 1 s interval that keeps the process alive, cleared when `work` settles.
 *
 * @param work - The test's work.
 * @returns What `work` resolves with.
 */
export async function keptAlive<T>(work: () => Promise<T>): Promise<T> {
  const alive = setInterval(() => undefined, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(alive);
  }
}
