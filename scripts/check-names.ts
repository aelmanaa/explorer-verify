// Per-name size check (R-RUN-3, decisions 0008 and 0014). Lists the value exports of every code
// entry in each package's package.json `exports` by importing the built file, so a new export is
// measured without editing a list. Bundles each name three ways (esbuild with splitting, esbuild
// as one file, Rollup with esbuild minification, as Vite builds), and compares the gzipped initial
// load with name-budget.json. A name with no row fails, and so does a row for a name that is gone.
// It also checks the light-name rule and reports the size-budget.json model beside the measured
// sizes for the names under `model`.
//
// Usage: node scripts/check-names.ts <name-budget.json> [--add-missing] [--root <dir>].
// `--add-missing` appends a row, measured size plus 20%, for each name that has none; it never
// changes a row that exists. `--root` is the folder that holds `packages/` (the repository by
// default). `pnpm run size` builds, then passes name-budget.json at the repository root.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { bundleApart, gzipSize } from "./bundle.ts";
import { measureEsbuild, measureRollup } from "./name-bundle.ts";
import type { NameTarget, RollupState } from "./name-bundle.ts";
import {
  checkLight,
  codeEntries,
  compareNames,
  formatModel,
  formatNameReport,
  parseNameBudget,
  rowFor,
  specifierOf,
} from "./name-size.ts";
import type { MeasuredName, ModelComparison } from "./name-size.ts";

const USAGE =
  "usage: node scripts/check-names.ts <name-budget.json> [--add-missing] [--root <dir>]";

const { values, positionals } = parseArgs({
  options: { "add-missing": { type: "boolean", default: false }, root: { type: "string" } },
  allowPositionals: true,
});
const [file] = positionals;
if (file === undefined || positionals.length > 1) {
  throw new Error(USAGE);
}
const addMissing = values["add-missing"];
const root = path.resolve(
  values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const budgetFile = path.resolve(file);
const parsed: unknown = JSON.parse(readFileSync(budgetFile, "utf8"));
const budget = parseNameBudget(parsed);

/** The keys of an object, such as a package.json `dependencies` or a module namespace. */
function strings(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

const specifiers: string[] = [];
const packageDirs = new Map<string, string>();
/** The names of each package; a package's Rollup builds share one cache. */
const groups: NameTarget[][] = [];
const packagesDir = path.join(root, "packages");
for (const folder of readdirSync(packagesDir).toSorted()) {
  const packageDir = path.join(packagesDir, folder);
  const manifest = path.join(packageDir, "package.json");
  if (!existsSync(manifest)) {
    continue;
  }
  const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const entries = codeEntries(pkg);
  if (entries.length === 0) {
    continue;
  }
  const packageName = String(Reflect.get(Object(pkg), "name"));
  const platform = budget.packages.get(packageName);
  if (platform === undefined) {
    throw new Error(
      `name-budget.json: \`packages\` has no platform for ${packageName}; add "browser" or "node"`,
    );
  }
  packageDirs.set(packageName, packageDir);
  const external = [
    ...strings(Reflect.get(Object(pkg), "dependencies")),
    ...strings(Reflect.get(Object(pkg), "peerDependencies")),
  ];
  const group: NameTarget[] = [];
  for (const { subpath, target: entryFile } of entries) {
    const specifier = specifierOf(packageName, subpath);
    specifiers.push(specifier);
    const module: unknown = await import(pathToFileURL(path.resolve(packageDir, entryFile)).href);
    for (const name of strings(module).toSorted()) {
      group.push({
        packageDir,
        packageName,
        exports: Reflect.get(Object(pkg), "exports"),
        sideEffectFree: Reflect.get(Object(pkg), "sideEffects") === false,
        specifier,
        name,
        platform,
        external,
      });
    }
  }
  groups.push(group);
}

// esbuild builds in its own process and Rollup in this one, so they run side by side. A
// package's Rollup builds run one at a time and share one cache; packages run at once.
const measured: MeasuredName[] = (
  await Promise.all(
    groups.map(async (group) => {
      const state: RollupState = {};
      const names: MeasuredName[] = [];
      for (const target of group) {
        const [esbuildSplit, esbuildOneFile, rollup] = await Promise.all([
          measureEsbuild(target, true),
          measureEsbuild(target, false),
          measureRollup(target, state),
        ]);
        names.push({
          entry: target.specifier,
          name: target.name,
          modes: { esbuildSplit, esbuildOneFile, rollup },
        });
      }
      return names;
    }),
  )
).flat();

const comparisons: ModelComparison[] = [];
for (const { entry, name } of budget.model) {
  const item = measured.find((one) => one.entry === entry && one.name === name);
  const packageDir = [...packageDirs].find(
    ([packageName]) => entry === packageName || entry.startsWith(`${packageName}/`),
  )?.[1];
  if (item === undefined || packageDir === undefined) {
    throw new Error(`name-budget.json: model names ${name} from ${entry}, which is not exported`);
  }
  const apart = await bundleApart({
    contents: `export { ${name} } from ${JSON.stringify(entry)};`,
    resolveDir: packageDir,
  });
  comparisons.push({ modelBytes: gzipSize(apart.entry), measured: item });
}

const lines = [
  ...compareNames(budget.rows, measured),
  ...checkLight(budget.light, specifiers, measured),
  ...formatModel(comparisons),
];

if (addMissing) {
  const known = new Set(budget.rows.map(({ entry, name }) => `${entry} ${name}`));
  const added = measured.filter(({ entry, name }) => !known.has(`${entry} ${name}`));
  const names: unknown = Reflect.get(Object(parsed), "names");
  const existing: unknown[] = Array.isArray(names) ? names : [];
  const rows = [...existing, ...added.map(rowFor)];
  writeFileSync(budgetFile, `${JSON.stringify({ ...Object(parsed), names: rows }, null, 2)}\n`);
  process.stdout.write(`Added ${String(added.length)} rows to ${path.basename(budgetFile)}.\n`);
  const rest = lines.filter(({ text }) => !text.startsWith("NONE "));
  process.stdout.write(formatNameReport(rest));
  process.exitCode = rest.every(({ ok }) => ok) ? 0 : 1;
} else {
  process.stdout.write(formatNameReport(lines));
  process.exitCode = lines.every(({ ok }) => ok) ? 0 : 1;
}
