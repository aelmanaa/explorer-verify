// Merges the Stryker JSON reports of the shards of a mutation run into one file, which
// scripts/check-mutation-score.ts then reads. The same command merges the shards' incremental
// files. With --only, it instead keeps the part of one shard's report that the shard owns
// (`keepShard`), which an incremental shard needs before the merge. scripts/mutation-merge.ts
// holds the rules.
//
// Usage: node scripts/merge-mutation-reports.ts <out.json> <shard report.json>...
//        node scripts/merge-mutation-reports.ts --only <mutate list> <out.json> <report.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { keepShard, mergeReports } from "./mutation-merge.ts";

const args = process.argv.slice(2);
const only = args[0] === "--only" ? args[1] : undefined;
const [out, ...inputs] = only === undefined ? args : args.slice(2);
if (out === undefined || inputs.length === 0 || (only !== undefined && inputs.length !== 1)) {
  throw new Error(
    "usage: node scripts/merge-mutation-reports.ts [--only <mutate list>] <out.json> <report.json>...",
  );
}
const reports = inputs.map((file): unknown => JSON.parse(readFileSync(path.resolve(file), "utf8")));
const result = only === undefined ? mergeReports(reports) : keepShard(reports[0], only);
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(path.resolve(out), JSON.stringify(result));
process.stdout.write(
  only === undefined
    ? `Merged ${String(inputs.length)} reports into ${out}.\n`
    : `Kept the shard's part of the report in ${out}.\n`,
);
