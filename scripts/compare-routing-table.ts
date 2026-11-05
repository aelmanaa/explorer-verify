// Prints the differences between the routing table and the public chain lists it was built from
// (#60, R-RT-1). It fetches the Etherscan chainlist and Sourcify's chain list, which need no key,
// and never writes the table. As text, it exits with 1 when it finds a difference. With `--json`,
// it prints the table's date, the notes and each difference with its chain and list, and exits
// with 0: .github/workflows/routing-table.yml passes that JSON to scripts/routing-table-issue.ts,
// which opens or updates one issue. A pull request applies the change.
//
// With `--rows`, it prints instead the table the rules give for the live lists, dated today (UTC),
// for a pull request to save as `table.json` and format with oxfmt (#166, decision 0036).
//
// Usage: node scripts/compare-routing-table.ts [--json | --rows]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fetchLists, output, run, tableOf } from "./routing-seed.ts";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    rows: { type: "boolean", default: false },
  },
});
if (values.rows) {
  const table = tableOf(await fetchLists(globalThis.fetch), new Date().toISOString().slice(0, 10));
  process.stdout.write(`${JSON.stringify(table, null, 2)}\n`);
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { text, exitCode } = output(await run(root, globalThis.fetch), values.json);
  process.stdout.write(text);
  process.exitCode = exitCode;
}
