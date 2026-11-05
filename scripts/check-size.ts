// Bundle size check (R-RUN-3, decisions 0008, 0031 and 0040). Bundles each entry of
// size-budget.json for the browser from the built package, gzips it and fails when one is above its
// ceiling. An entry with `withoutTable` is measured with an empty routing table. The table's rows
// are the `table` chunk, which the entries load with a dynamic `import()` (decision 0040).
//
// Each module an entry loads with a dynamic `import()`, such as a backend client, is left out of
// the entry and measured on its own, as a `chunks` line of size-budget.json: what loading it adds
// to a page that runs the entry. A chunk that several entries load counts at its largest size.
// An entry with `oneFile` is measured as one file with every dynamic import inlined, as esbuild
// without splitting ships it.
//
// Usage: node scripts/check-size.ts <budget.json>. `pnpm run size` builds, then passes the
// size-budget.json at the repository root.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleApart, bundleForBrowser, gzipSize } from "./bundle.ts";
import {
  compareChunks,
  compareSizes,
  formatReport,
  parseBudget,
  parseChunks,
} from "./size-budget.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [file] = process.argv.slice(2);
if (file === undefined) {
  throw new Error("usage: node scripts/check-size.ts <budget.json>");
}
const parsed: unknown = JSON.parse(readFileSync(path.resolve(file), "utf8"));
const entries = parseBudget(parsed);
const chunks = parseChunks(parsed);
const resolveDir = path.join(root, "packages/explorer-verify");
const sizes = new Map<string, number>();
const chunkSizes = new Map<string, Map<string, number>>();
for (const entry of entries) {
  const source = { contents: entry.code, resolveDir };
  const options = { withoutTable: entry.withoutTable };
  if (entry.oneFile) {
    sizes.set(entry.name, gzipSize(await bundleForBrowser(source, options)));
    continue;
  }
  const apart = await bundleApart(source, options);
  sizes.set(entry.name, gzipSize(apart.entry));
  for (const [name, code] of apart.chunks) {
    const byEntry = chunkSizes.get(name) ?? new Map<string, number>();
    byEntry.set(entry.name, gzipSize(code));
    chunkSizes.set(name, byEntry);
  }
}
const lines = [...compareSizes(entries, sizes), ...compareChunks(chunks, chunkSizes)];
process.stdout.write(formatReport(lines));
process.exitCode = lines.every(({ ok }) => ok) ? 0 : 1;
