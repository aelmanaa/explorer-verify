// Lists the packages a release publishes: every `packages/*/package.json` without
// `"private": true`, the core first, then the others by name. The release and promote workflows
// read the list from this script and nowhere else, so a new package joins the release when its
// manifest drops `"private"`. The packages share one version through the changesets `fixed`
// group (decision 0017).
//
// The list is read from a git commit, not from the working tree: the release workflow reads it
// at the tagged commit, and the promote workflow, which runs on `main`, reads it at the commit of
// the version's tag. A package added on `main` after the tag is not part of that version.
//
// Usage: node scripts/release-packages.ts [--commit REF] [--names | --directories]
// Prints one name (the default) or one directory under `packages/` per line. Exits 1 when no
// package is published: the core stays private until the pull request that prepares 0.1.0.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";

/** The name of the core package, which is always first. */
export const CORE = "explorer-verify";

/** One package a release publishes. */
export interface ReleasePackage {
  /** The directory under `packages/`. */
  directory: string;
  /** The npm name. */
  name: string;
  /** The version in its manifest. */
  version: string;
}

/** What `git` returned. */
export interface GitResult {
  status: number | null;
  stdout: string;
}

/** Runs `git` with the given arguments. Tests pass a stub. */
export type Git = (args: readonly string[]) => GitResult;

/**
 * Runs `git` in a directory.
 * @param cwd The repository.
 * @returns The runner.
 */
export function gitIn(cwd: string): Git {
  return (args) => {
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    if (result.error !== undefined) {
      throw new Error(`cannot run git: ${result.error.message}`, { cause: result.error });
    }
    return { status: result.status, stdout: result.stdout };
  };
}

/**
 * The message of a thrown value, for the one line a release script prints.
 * @param error What was thrown.
 * @returns Its message, or the value as a string when it is not an `Error`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Reads one manifest's text.
 * @param directory The package's directory under `packages/`.
 * @param manifest Where it is, for the messages.
 * @param text The manifest.
 * @returns The package, or undefined when the manifest is private.
 * @throws When the manifest is not JSON or lacks a name or a version.
 */
export function readManifest(
  directory: string,
  manifest: string,
  text: string,
): ReleasePackage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${manifest} is not JSON`);
  }
  if (field(parsed, "private") === true) {
    return undefined;
  }
  const name = field(parsed, "name");
  const version = field(parsed, "version");
  if (typeof name !== "string" || name === "") {
    throw new Error(`${manifest} has no name`);
  }
  if (typeof version !== "string" || version === "") {
    throw new Error(`${manifest} has no version`);
  }
  return { directory, name, version };
}

/**
 * Puts the core first, then the other packages by name.
 * @param packages The packages, in any order.
 * @returns A new array, sorted.
 */
export function releaseOrder(packages: readonly ReleasePackage[]): ReleasePackage[] {
  return packages.toSorted((a, b) => {
    if (a.name === CORE || b.name === CORE) {
      return a.name === CORE ? -1 : 1;
    }
    return a.name < b.name ? -1 : 1;
  });
}

/**
 * Lists the published packages at a commit.
 * @param commit The commit, tag or branch to read.
 * @param git Runs `git` in the repository.
 * @returns The packages, the core first.
 * @throws When the commit cannot be read or a manifest is malformed.
 */
export function releasePackagesAt(commit: string, git: Git): ReleasePackage[] {
  const listed = git(["ls-tree", "--name-only", `${commit}:packages`]);
  if (listed.status !== 0) {
    throw new Error(`cannot list packages/ at ${commit}`);
  }
  const packages: ReleasePackage[] = [];
  for (const directory of listed.stdout.split("\n").filter((line) => line !== "")) {
    const manifest = `packages/${directory}/package.json`;
    const shown = git(["show", `${commit}:${manifest}`]);
    if (shown.status !== 0) {
      continue;
    }
    const entry = readManifest(directory, manifest, shown.stdout);
    if (entry !== undefined) {
      packages.push(entry);
    }
  }
  return releaseOrder(packages);
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @param git Runs `git` in the repository.
 * @returns What to print.
 * @throws When no package is published, or on a usage error.
 */
export function run(argv: readonly string[], git: Git): string {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      commit: { type: "string" },
      names: { type: "boolean" },
      directories: { type: "boolean" },
    },
  });
  if (values.names === true && values.directories === true) {
    throw new Error("pass --names or --directories, not both");
  }
  const commit = values.commit ?? "HEAD";
  const packages = releasePackagesAt(commit, git);
  if (packages.length === 0) {
    throw new Error(
      `no package is published at ${commit}: every packages/*/package.json is private. The pull request that prepares the first release removes "private": true (docs/contributor/releasing.md)`,
    );
  }
  const lines = packages.map((entry) =>
    values.directories === true ? entry.directory : entry.name,
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  try {
    process.stdout.write(run(process.argv.slice(2), gitIn(process.cwd())));
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
