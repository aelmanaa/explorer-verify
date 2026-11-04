// A page script that starts the scenario after a top-level `await`, 1 second late, as a page that
// first loads a client chunk does. Chromium fires the load event without waiting for it.
// scripts/test-browser/browser-smoke.test.ts runs the smoke test with this page and expects a pass:
// the test must wait for the result, not read it at the load event. In Node the scenario starts at
// once.
import { start } from "./scenario.ts";

const LATE_MS = 1_000;

if (typeof document !== "undefined") {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, LATE_MS);
  });
}
start();
