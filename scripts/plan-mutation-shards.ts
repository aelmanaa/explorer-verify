// Plans the shards of the full mutation run. Reads the package's stryker.config.json, expands its
// `mutate` list, weighs each file by an earlier Stryker report when one is given and exists, and
// prints the GitHub Actions matrix: `{"include":[{"shard":1,"mutate":"src/a.ts,src/b.ts:1-120"}]}`.
// The weight of each shard goes to stderr. scripts/mutation-shards.ts holds the rules.
//
// Usage: node scripts/plan-mutation-shards.ts <package dir> <shards> [<report.json>]
// The Mutation workflow passes the incremental file of the latest full run on main as the report.
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import { mutantTimes, planShards } from "./mutation-shards.ts";

const [dir, count, reportFile] = process.argv.slice(2);
if (dir === undefined || count === undefined) {
  throw new Error("usage: node scripts/plan-mutation-shards.ts <package dir> <shards> [<report>]");
}
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const config = read(path.join(dir, "stryker.config.json"));
const patterns: unknown =
  typeof config === "object" && config !== null ? Reflect.get(config, "mutate") : undefined;
if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string")) {
  throw new Error("stryker.config.json: `mutate` must be a list of file patterns");
}
const files = [...new Set(patterns.flatMap((pattern: string) => globSync(pattern, { cwd: dir })))];
const sources = files.toSorted().map((file) => ({
  file,
  text: readFileSync(path.join(dir, file), "utf8"),
}));
const report = reportFile !== undefined && existsSync(reportFile) ? read(reportFile) : undefined;
if (reportFile !== undefined && report === undefined) {
  process.stderr.write(`No report at ${reportFile}: the shards are weighed by file length.\n`);
}
const shards = planShards(sources, mutantTimes(report), Number(count));
shards.forEach((shard, index) => {
  process.stderr.write(
    `shard ${String(index + 1)}: weight ${String(Math.round(shard.weight))}, ${shard.mutate.join(", ")}\n`,
  );
});
const include = shards
  .map((shard, index) => ({ shard: index + 1, mutate: shard.mutate.join(",") }))
  .filter((shard) => shard.mutate !== "");
process.stdout.write(`${JSON.stringify({ include })}\n`);
