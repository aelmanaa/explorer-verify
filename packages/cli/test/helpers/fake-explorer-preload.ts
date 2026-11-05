// Loaded with `node --import` before the bin in the bin tests: puts the fake explorer in
// `globalThis.fetch`, so the bin sends nothing to the network. FAKE_EXPLORER names the scenario
// (default `verified`), and FAKE_EXPLORER_LOG names a file that gets one JSON line per request.
//
// FAKE_CLI_BUG makes listing the environment variables throw a plain Error with that message. The
// CLI lists them once per run, when it builds the command's context, after it has read the
// request and the keys. So the throw stands for a bug in a command: the run ends with
// `internal-error` (exit 6) on the built bin, and every key the run read is a known secret by
// then. This file is never packed, so the CLI ships no way to raise it.
import { appendFileSync } from "node:fs";
import process from "node:process";

import { SCENARIOS, fakeExplorer } from "./fake-explorer.ts";

const name = process.env["FAKE_EXPLORER"] ?? "verified";
const scenario = SCENARIOS.find((known) => known === name);
if (scenario === undefined) {
  throw new Error("FAKE_EXPLORER names no scenario");
}
const log = process.env["FAKE_EXPLORER_LOG"];
const bug = process.env["FAKE_CLI_BUG"];
if (bug !== undefined) {
  // Reading one variable still works; only listing them all throws.
  process.env = new Proxy(process.env, {
    ownKeys: () => {
      throw new Error(bug);
    },
  });
}

globalThis.fetch = fakeExplorer(scenario, (seen) => {
  if (log !== undefined) {
    appendFileSync(log, `${JSON.stringify(seen)}\n`);
  }
});
