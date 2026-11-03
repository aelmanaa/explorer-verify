// Checks the release tarballs against a list of SHA-256 sums and against the release they belong
// to. The release workflow runs it twice: in the pack job, right after packing, and in the publish
// job, on the downloaded artifact, against the sums the pack job passed as a job output. The sums
// travel outside the artifact they cover, so a swapped artifact fails here.
//
// For each line of the sums file, in order:
// - the file name is a plain `*.tgz` name and the file exists in the directory;
// - its SHA-256 equals the listed sum;
// - its package/package.json names the package expected at that position (the order of
//   scripts/release-packages.ts, the core first), at the release version, with `gitHead` set to
//   the tagged commit, and no dependency range starting with `workspace:` or `catalog:`, which
//   npm cannot install (pnpm pack rewrites them; npm pack does not).
// The directory must hold no other tarball, and the version must be a plain X.Y.Z.
//
// Usage: node scripts/check-tarballs.ts --dir DIR --sums FILE --version X.Y.Z --commit SHA
// The expected packages are read at HEAD, which in the workflow is the tagged commit. Prints one
// line per tarball, or the first failure, and exits 1 on a failure.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { errorMessage, gitIn, releasePackagesAt } from "./release-packages.ts";
import { STABLE_VERSION } from "./verify-release-tag.ts";

/** One line of a `sha256sum` listing. */
export interface SumLine {
  sha256: string;
  file: string;
}

/** What the manifest inside a tarball must say. */
export interface Expected {
  name: string;
  version: string;
  commit: string;
}

const SUM_LINE = /^[0-9a-f]{64} {2}[\w.@-]+\.tgz$/;

/**
 * Parses a `sha256sum` listing of the release tarballs.
 * @param text The listing, one `<sum>  <file>` line per tarball.
 * @param count The number of packages a release publishes.
 * @returns The lines, in order.
 * @throws When a line is malformed or the count differs.
 */
export function parseSums(text: string, count: number): SumLine[] {
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  const sums = lines.map((line, index) => {
    if (!SUM_LINE.test(line)) {
      throw new Error(
        `sums line ${index + 1} is not "<sha256>  <name>.tgz": ${JSON.stringify(line)}`,
      );
    }
    // The pattern fixed the layout: 64 hex digits, two spaces, the file name.
    return { sha256: line.slice(0, 64), file: line.slice(66) };
  });
  if (sums.length !== count) {
    throw new Error(`the sums list ${sums.length} tarballs; this release publishes ${count}`);
  }
  return sums;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Checks the manifest of one tarball.
 * @param file The tarball's name, for the message.
 * @param manifestText Its package/package.json.
 * @param expected The package, version and commit it must carry.
 * @throws When a field differs, naming the field and both values.
 */
export function checkManifest(file: string, manifestText: string, expected: Expected): void {
  const manifest: unknown = JSON.parse(manifestText);
  for (const [key, want] of [
    ["name", expected.name],
    ["version", expected.version],
    ["gitHead", expected.commit],
  ] as const) {
    const actual = field(manifest, key);
    if (actual !== want) {
      throw new Error(`${file}: ${key} is ${JSON.stringify(actual)}, expected ${want}`);
    }
  }
  const local = localRanges(manifest);
  if (local.length > 0) {
    throw new Error(
      `${file}: ${local.join(", ")} still use a workspace: or catalog: range, which npm cannot install; pack with pnpm pack, which rewrites them`,
    );
  }
}

/** The dependency fields of a manifest that a registry install reads. */
export const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Lists the dependencies whose range only a pnpm workspace understands.
 * @param manifest A parsed package.json.
 * @returns `<field>.<name>` for each `workspace:` or `catalog:` range.
 */
export function localRanges(manifest: unknown): string[] {
  return DEPENDENCY_FIELDS.flatMap((key) => {
    const ranges = field(manifest, key);
    if (typeof ranges !== "object" || ranges === null) {
      return [];
    }
    return Object.entries(ranges)
      .filter(
        ([, range]) =>
          typeof range === "string" &&
          (range.startsWith("workspace:") || range.startsWith("catalog:")),
      )
      .map(([name]) => `${key}.${name}`);
  });
}

/**
 * Runs every check on a directory of tarballs.
 * @param directory The directory the tarballs are in.
 * @param sumsText The `sha256sum` listing they must match.
 * @param names The packages, in release order.
 * @param version The release version.
 * @param commit The tagged commit.
 * @returns One line per tarball.
 */
export function checkTarballs(
  directory: string,
  sumsText: string,
  names: readonly string[],
  version: string,
  commit: string,
): string[] {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`version ${version} is not a plain X.Y.Z`);
  }
  const sums = parseSums(sumsText, names.length);
  const listed = new Set(sums.map((sum) => sum.file));
  const extra = readdirSync(directory).filter((name) => name.endsWith(".tgz") && !listed.has(name));
  if (extra.length > 0) {
    throw new Error(`${directory} holds tarballs the sums do not list: ${extra.join(", ")}`);
  }
  const lines = sums.map((sum) => {
    const tarball = path.join(directory, sum.file);
    if (!existsSync(tarball)) {
      throw new Error(`${sum.file} is listed in the sums but missing`);
    }
    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actual !== sum.sha256) {
      throw new Error(`${sum.file}: SHA-256 is ${actual}, the pack job recorded ${sum.sha256}`);
    }
    // tar runs in the directory with the plain file name, which never holds a slash.
    const manifest = execFileSync("tar", ["-xOzf", sum.file, "package/package.json"], {
      cwd: directory,
      encoding: "utf8",
    });
    const name = manifestName(manifest);
    checkManifest(sum.file, manifest, { name, version, commit });
    return { name, line: `ok   ${name}@${version} gitHead ${commit} ${sum.file} ${sum.sha256}` };
  });
  const packed = lines.map((entry) => entry.name);
  if (packed.join("\n") !== names.join("\n")) {
    throw new Error(
      `the tarballs hold ${packed.join(", ")}; this release publishes ${names.join(", ")}, in that order`,
    );
  }
  return lines.map((entry) => entry.line);
}

/**
 * Reads the name of a packed manifest.
 * @param manifestText A package/package.json.
 * @returns The name, or "" when it has none; checkManifest then names the problem.
 */
export function manifestName(manifestText: string): string {
  const name = field(JSON.parse(manifestText), "name");
  return typeof name === "string" ? name : "";
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @param cwd The repository, checked out at the tagged commit.
 * @returns The lines to print.
 */
export function main(argv: readonly string[], cwd: string): string[] {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      sums: { type: "string" },
      version: { type: "string" },
      commit: { type: "string" },
    },
  });
  const { dir, sums, version, commit } = values;
  if (dir === undefined || sums === undefined || version === undefined || commit === undefined) {
    throw new Error(
      "usage: node scripts/check-tarballs.ts --dir DIR --sums FILE --version X.Y.Z --commit SHA",
    );
  }
  const names = releasePackagesAt("HEAD", gitIn(cwd)).map((entry) => entry.name);
  return checkTarballs(dir, readFileSync(sums, "utf8"), names, version, commit);
}

if (import.meta.main) {
  try {
    process.stdout.write(`${main(process.argv.slice(2), process.cwd()).join("\n")}\n`);
  } catch (error: unknown) {
    process.stderr.write(`FAIL ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
