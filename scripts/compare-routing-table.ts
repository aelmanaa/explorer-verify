// Prints the differences between the routing table and the public chain lists it was built from
// (#60, R-RT-1). It fetches the Etherscan chainlist and Sourcify's chain list, which need no key,
// and never writes the table. It exits with 1 when it finds a difference, so the weekly check can
// open an issue; a pull request applies the change.
//
// Usage: node scripts/compare-routing-table.ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./routing-seed.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { differences, notes } = await run(root, globalThis.fetch);
for (const line of [...notes, ...differences]) {
  process.stdout.write(`${line}\n`);
}
process.stdout.write(
  differences.length === 0
    ? "routing table: no differences\n"
    : `routing table: ${String(differences.length)} differences\n`,
);
process.exitCode = differences.length === 0 ? 0 : 1;
