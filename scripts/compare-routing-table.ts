// Prints the differences between the routing table and the public chain lists it was built from
// (#60, R-RT-1). It fetches the Etherscan chainlist, Sourcify's chain list and Routescan's two
// explorer lists, which need no key, and never writes the table. As text, it exits with 1 when it
// finds a difference. With `--json`, it prints the table's date, the notes and each difference
// with its chain and list, and exits with 0: .github/workflows/routing-table.yml passes that JSON
// to scripts/routing-table-issue.ts, which opens or updates one issue. A pull request applies the
// change.
//
// With `--rows`, it prints instead the table the rules give for the live lists and the Routescan
// probe data, dated today (UTC), for a pull request to save as `table.json` and format with oxfmt
// (#166, #168, decisions 0036 and 0037).
//
// With `--probe-routescan`, it probes Routescan's API for each chain of Routescan's explorer lists,
// one keyless request every 600 ms, and prints the research data for a pull request to save as
// the Routescan probe file (#168, decision 0037).
//
// Usage: node scripts/compare-routing-table.ts [--json | --rows | --probe-routescan]
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ROUTESCAN_FILE,
  parseRoutescanProbe,
  probeRoutescan,
  routescanData,
  withRoutescan,
} from "./routing-routescan.ts";
import { fetchLists, output, run, tableOf } from "./routing-seed.ts";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    rows: { type: "boolean", default: false },
    "probe-routescan": { type: "boolean", default: false },
  },
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
if (values["probe-routescan"]) {
  const probe = await probeRoutescan(
    globalThis.fetch,
    async (ms) => {
      await setTimeout(ms);
    },
    today,
  );
  process.stdout.write(`${JSON.stringify(routescanData(probe), null, 2)}\n`);
} else if (values.rows) {
  const table = tableOf(await fetchLists(globalThis.fetch), today);
  const probe = parseRoutescanProbe(
    JSON.parse(readFileSync(path.join(root, ROUTESCAN_FILE), "utf8")),
  );
  process.stdout.write(
    `${JSON.stringify({ ...table, chains: withRoutescan(table.chains, probe) }, null, 2)}\n`,
  );
} else {
  const { text, exitCode } = output(await run(root, globalThis.fetch), values.json);
  process.stdout.write(text);
  process.exitCode = exitCode;
}
