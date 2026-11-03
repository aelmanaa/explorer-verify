// The page script of the browser smoke test: scripts/browser-smoke.ts bundles this file and runs it
// in Node and in headless Chromium. It runs the scenario against the replay server the test names,
// and leaves the result on the global object for the test to read.
import { start } from "./scenario.ts";

start();
