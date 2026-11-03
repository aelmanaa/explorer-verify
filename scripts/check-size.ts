// Bundle size check (R-RUN-3, decision 0008). Bundles each entry of size-budget.json for the
// browser from the built package, gzips it and fails when one is above its ceiling. An entry with
// `withoutTable` is measured with an empty routing table: the table's rows have their own entry.
//
// Usage: node scripts/check-size.ts <budget.json>. `pnpm run size` builds, then passes the
// size-budget.json at the repository root.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleForBrowser, gzipSize } from "./bundle.ts";
import { compareSizes, formatReport, parseBudget } from "./size-budget.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [file] = process.argv.slice(2);
if (file === undefined) {
  throw new Error("usage: node scripts/check-size.ts <budget.json>");
}
const entries = parseBudget(JSON.parse(readFileSync(path.resolve(file), "utf8")));
const resolveDir = path.join(root, "packages/explorer-verify");
const sizes = new Map<string, number>();
for (const entry of entries) {
  const code = await bundleForBrowser(
    { contents: entry.code, resolveDir },
    { withoutTable: entry.withoutTable },
  );
  sizes.set(entry.name, gzipSize(code));
}
const lines = compareSizes(entries, sizes);
process.stdout.write(formatReport(lines));
process.exitCode = lines.every(({ ok }) => ok) ? 0 : 1;
