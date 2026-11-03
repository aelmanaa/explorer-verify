// Refuses a `major` changeset while the core is on 0.x (decision 0017). During 0.x a breaking
// change is a `minor` changeset whose text starts with "Breaking:", and changesets would turn a
// `major` into 1.0.0. The 1.0.0 release pull request is the one place a `major` appears: it adds
// it in a changeset named `release-1-0-0.md`, which this check accepts.
//
// The bumps are read with changesets' own parser, so every YAML spelling changesets accepts
// (quoted values, comments, flow mappings) is read the same way here. A changeset changesets
// cannot parse is refused too.
//
// Usage: node scripts/check-changesets.ts [root]
// `pnpm run check` runs it. Prints each refused changeset and exits 1 when there is one.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseChangesetFile } from "@changesets/parse";

import { errorMessage } from "./release-packages.ts";

/** The folder of pending changesets. */
export const CHANGESETS = ".changeset";
/** The one changeset file that may carry a `major` during 0.x: the 1.0.0 release. */
export const RELEASE_1_0_0 = "release-1-0-0.md";
/** The manifest whose version decides whether the project is on 0.x. */
export const CORE_MANIFEST = "packages/explorer-verify/package.json";

/**
 * Reads the bumps of one changeset, as changesets reads them.
 * @param text The changeset file.
 * @returns Each package with its bump, in file order.
 * @throws When changesets cannot parse the file.
 */
export function changesetBumps(text: string): { name: string; bump: string }[] {
  return parseChangesetFile(text).releases.map((release) => ({
    name: release.name,
    bump: release.type,
  }));
}

/**
 * Lists the `major` bumps that 0.x refuses, and the changesets that cannot be parsed.
 * @param root The repository root.
 * @returns One message per problem, or none when the core is at 1.0.0 or above.
 */
export function majorProblems(root: string): string[] {
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, CORE_MANIFEST), "utf8"));
  const version: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : "";
  if (typeof version !== "string" || !version.startsWith("0.")) {
    return [];
  }
  const files = readdirSync(path.join(root, CHANGESETS))
    .filter((name) => name.endsWith(".md") && name !== "README.md" && name !== RELEASE_1_0_0)
    .toSorted();
  return files.flatMap((file) => {
    let bumps: { name: string; bump: string }[];
    try {
      bumps = changesetBumps(readFileSync(path.join(root, CHANGESETS, file), "utf8"));
    } catch (error: unknown) {
      return [`${CHANGESETS}/${file}: ${errorMessage(error).split("\n", 1).join("")}`];
    }
    return bumps
      .filter((entry) => entry.bump === "major")
      .map(
        (entry) =>
          `${CHANGESETS}/${file}: "${entry.name}": major is not used during 0.x (decision 0017). Use minor and start the text with "Breaking:". Only ${CHANGESETS}/${RELEASE_1_0_0} may bump major.`,
      );
  });
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name: an optional root, relative to the default.
 * @param scriptDirectory The directory of this script; the default root is its parent.
 * @returns The problems; empty when the check passes.
 */
export function main(argv: readonly string[], scriptDirectory: string): string[] {
  const root = path.resolve(scriptDirectory, "..", ...argv);
  return majorProblems(root);
}

if (import.meta.main) {
  const problems = main(process.argv.slice(2), path.dirname(fileURLToPath(import.meta.url)));
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  }
}
