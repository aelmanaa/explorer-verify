// Mutation score check. Reads the Stryker JSON report, prints the score of each mutated file next
// to its floor as a Markdown table, and fails when a file is below its floor, has no floor, or has
// a floor and is missing from the report.
//
// Usage: node scripts/check-mutation-score.ts <mutation-floors.json> <mutation.json>.
// `pnpm run test:mutation` passes the package's mutation-floors.json and
// reports/mutation/mutation.json after `stryker run`.
import { readFileSync } from "node:fs";
import path from "node:path";

import { compareScores, countMutants, formatReport, parseFloors } from "./mutation-score.ts";

const [floorsFile, reportFile] = process.argv.slice(2);
if (floorsFile === undefined || reportFile === undefined) {
  throw new Error(
    "usage: node scripts/check-mutation-score.ts <mutation-floors.json> <mutation.json>",
  );
}
const read = (file: string): unknown => JSON.parse(readFileSync(path.resolve(file), "utf8"));
const lines = compareScores(parseFloors(read(floorsFile)), countMutants(read(reportFile)));
process.stdout.write(formatReport(lines));
process.exitCode = lines.every(({ ok }) => ok) ? 0 : 1;
