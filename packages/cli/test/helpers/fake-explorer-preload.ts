// Loaded with `node --import` before the bin in the bin tests: puts the fake explorer in
// `globalThis.fetch`, so the bin sends nothing to the network. FAKE_EXPLORER names the scenario
// (default `verified`), and FAKE_EXPLORER_LOG names a file that gets one JSON line per request.
import { appendFileSync } from "node:fs";
import process from "node:process";

import { SCENARIOS, fakeExplorer } from "./fake-explorer.ts";

const name = process.env["FAKE_EXPLORER"] ?? "verified";
const scenario = SCENARIOS.find((known) => known === name);
if (scenario === undefined) {
  throw new Error("FAKE_EXPLORER names no scenario");
}
const log = process.env["FAKE_EXPLORER_LOG"];

globalThis.fetch = fakeExplorer(scenario, (seen) => {
  if (log !== undefined) {
    appendFileSync(log, `${JSON.stringify(seen)}\n`);
  }
});
