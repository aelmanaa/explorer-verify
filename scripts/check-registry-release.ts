// Checks a version on npm before the promote workflow moves `latest` to it. It never publishes and
// never moves a tag; it only reads the registry with `npm view`, without a token. For each package
// the tagged commit publishes (scripts/release-packages.ts at that commit):
// - the version is on npm;
// - the `beta` dist-tag points at it, so only a version the release workflow staged moves on;
// - its `gitHead` is the tagged commit;
// - it has a SLSA provenance attestation (R-SEC-4) whose statement names this package and
//   version, the repository aelmanaa/explorer-verify, the workflow .github/workflows/release.yml,
//   the ref refs/tags/v<version> and the tagged commit. The attestation is fetched from the URL
//   npm lists for it. The registry checked its Sigstore signature at publish time; this check reads
//   what the statement says, and does not verify the signature again.
// - `latest` is not above it, so `latest` never moves backwards.
// A package whose `latest` already is the version passes and is left out of the moves, so a re-run
// after a partial promotion moves only what is left.
//
// Usage: node scripts/check-registry-release.ts --version X.Y.Z --commit SHA [--output FILE]
//   [--repository OWNER/NAME]
// The packages are read at `--commit` in the current repository. `--output` appends
// `move=<names>` (space-separated) to FILE (GITHUB_OUTPUT). Exits 1 on the first failure.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

import { errorMessage, gitIn, releasePackagesAt } from "./release-packages.ts";
import { STABLE_VERSION } from "./verify-release-tag.ts";

/** What `npm view <spec> --json` returned. */
export interface ViewResult {
  status: number | null;
  stdout: string;
}

/** Runs `npm view <spec> --json`. Tests pass a stub. */
export type View = (spec: string) => ViewResult;

/** Fetches the attestations at a URL and returns the parsed JSON. Tests pass a stub. */
export type Attestations = (url: string) => Promise<unknown>;

/** One package's state on npm, once it passed. */
export interface Checked {
  name: string;
  /** True when `latest` already points at the version. */
  alreadyLatest: boolean;
  /** Where npm serves the package's attestations. */
  attestationsUrl: string;
}

/** What the provenance statement of a release must name. */
export interface ExpectedProvenance {
  name: string;
  version: string;
  commit: string;
  /** `owner/name` on GitHub. */
  repository: string;
}

/** The repository every release is built in. */
export const REPOSITORY = "aelmanaa/explorer-verify";
/** The workflow that publishes, as the provenance statement names it. */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
/** The predicate type of npm's SLSA provenance attestation. */
export const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";

const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/;

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/**
 * Runs `npm view` against the registry npm is configured for.
 * @param spec The package and version, `name@X.Y.Z`.
 * @param env The environment for npm; tests pass one without npm on the PATH.
 * @returns The exit status and the JSON output.
 */
export function npmView(spec: string, env: NodeJS.ProcessEnv = process.env): ViewResult {
  const result = spawnSync("npm", ["view", spec, "--json"], { encoding: "utf8", env });
  if (result.error !== undefined) {
    throw new Error(`cannot run npm: ${result.error.message}`, { cause: result.error });
  }
  return { status: result.status, stdout: result.stdout };
}

/** The entries of a JSON array, or none when the value is not an array. */
function items(value: unknown): unknown[] {
  const entries: unknown[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry: unknown) => entries.push(entry));
  }
  return entries;
}

/**
 * Fetches an attestations document with the global `fetch`.
 * @param url The URL from `dist.attestations.url`.
 * @returns The parsed JSON.
 * @throws When the answer is not 200 or not JSON.
 */
export async function fetchAttestations(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const body: unknown = await response.json();
  return body;
}

/**
 * Reads the SLSA provenance statement of an attestations document and checks what it names.
 * @param document The JSON npm serves at `dist.attestations.url`.
 * @param expected The package, version, commit and repository it must name.
 * @throws With the first field that differs.
 */
export function checkProvenance(document: unknown, expected: ExpectedProvenance): void {
  const spec = `${expected.name}@${expected.version}`;
  const list = field(document, "attestations");
  const slsa = items(list).find((entry) => field(entry, "predicateType") === SLSA_PROVENANCE);
  const payload = field(field(field(slsa, "bundle"), "dsseEnvelope"), "payload");
  if (typeof payload !== "string") {
    throw new Error(`${spec} has no SLSA provenance attestation (R-SEC-4)`);
  }
  let statement: unknown;
  try {
    statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    throw new Error(`the provenance statement of ${spec} is not JSON`);
  }
  const subjects = field(statement, "subject");
  const subject = field(items(subjects)[0], "name");
  const definition = field(field(statement, "predicate"), "buildDefinition");
  const workflow = field(field(definition, "externalParameters"), "workflow");
  const dependencies = field(definition, "resolvedDependencies");
  const source = items(dependencies)[0];
  const checks: [string, unknown, string][] = [
    ["subject", subject, `pkg:npm/${expected.name.replace(/^@/, "%40")}@${expected.version}`],
    ["repository", field(workflow, "repository"), `https://github.com/${expected.repository}`],
    ["workflow", field(workflow, "path"), RELEASE_WORKFLOW],
    ["ref", field(workflow, "ref"), `refs/tags/v${expected.version}`],
    ["commit", field(field(source, "digest"), "gitCommit"), expected.commit],
  ];
  for (const [label, actual, want] of checks) {
    if (actual !== want) {
      throw new Error(
        `the provenance of ${spec} names ${label} ${JSON.stringify(actual)}, expected ${want} (R-SEC-4)`,
      );
    }
  }
}

/**
 * Compares two versions by their `X.Y.Z` part; a prerelease sorts below its `X.Y.Z`.
 * @param a A version.
 * @param b A version.
 * @returns A negative number when `a` is lower, 0 when equal, a positive number when higher.
 * @throws When either is not a semver version.
 */
export function compareVersions(a: string, b: string): number {
  const left = VERSION_PARTS.exec(a);
  const right = VERSION_PARTS.exec(b);
  if (left === null || right === null) {
    throw new Error(`cannot compare ${a} with ${b}: not a semver version`);
  }
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  if (left[4] === right[4]) {
    return 0;
  }
  return left[4] === undefined ? 1 : -1;
}

/**
 * Checks one package's version on npm.
 * @param name The package.
 * @param version The version to promote.
 * @param commit The tagged commit.
 * @param view Runs `npm view`.
 * @returns Whether `latest` already points at the version.
 * @throws With the reason the version may not move to `latest`.
 */
export function checkPackage(name: string, version: string, commit: string, view: View): Checked {
  const spec = `${name}@${version}`;
  const result = view(spec);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  if (result.status !== 0 || field(parsed, "version") !== version) {
    throw new Error(
      `${spec} is not on npm; the promote workflow moves latest only to a version the release workflow published`,
    );
  }
  const tags = field(parsed, "dist-tags");
  const beta = field(tags, "beta");
  if (beta !== version) {
    throw new Error(
      `the beta dist-tag of ${name} is ${JSON.stringify(beta)}, not ${version}; promote the version the release workflow published last`,
    );
  }
  const gitHead = field(parsed, "gitHead");
  if (gitHead !== commit) {
    throw new Error(
      `${spec} has gitHead ${JSON.stringify(gitHead)}, but tag v${version} points at ${commit}`,
    );
  }
  const attestations = field(field(parsed, "dist"), "attestations");
  const attestationsUrl = field(attestations, "url");
  if (field(attestations, "provenance") === undefined || typeof attestationsUrl !== "string") {
    throw new Error(`${spec} has no provenance attestation (R-SEC-4)`);
  }
  const latest = field(tags, "latest");
  if (typeof latest === "string" && compareVersions(latest, version) > 0) {
    throw new Error(`latest of ${name} is ${latest}, above ${version}; latest never moves back`);
  }
  return { name, alreadyLatest: latest === version, attestationsUrl };
}

/**
 * Checks every package of a release.
 * @param names The packages, in release order.
 * @param version The version to promote.
 * @param commit The tagged commit.
 * @param view Runs `npm view`.
 * @returns Each package's state.
 */
export function checkRegistryRelease(
  names: readonly string[],
  version: string,
  commit: string,
  view: View,
): Checked[] {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`version ${version} is not a plain X.Y.Z; latest never points at a prerelease`);
  }
  if (names.length === 0) {
    throw new Error(`no package is published at ${commit}`);
  }
  return names.map((name) => checkPackage(name, version, commit, view));
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @param cwd The repository, with the tagged commit fetched.
 * @param view Runs `npm view`.
 * @param attest Fetches an attestations document.
 * @returns The lines to print.
 */
export async function main(
  argv: readonly string[],
  cwd: string,
  view: View,
  attest: Attestations,
): Promise<string[]> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      output: { type: "string" },
      repository: { type: "string" },
    },
  });
  const { version, commit, output } = values;
  const repository = values.repository ?? REPOSITORY;
  if (version === undefined || commit === undefined) {
    throw new Error(
      "usage: node scripts/check-registry-release.ts --version X.Y.Z --commit SHA [--output FILE]",
    );
  }
  const names = releasePackagesAt(commit, gitIn(cwd)).map((entry) => entry.name);
  const checked = checkRegistryRelease(names, version, commit, view);
  for (const entry of checked) {
    checkProvenance(await attest(entry.attestationsUrl), {
      name: entry.name,
      version,
      commit,
      repository,
    });
  }
  const moves = checked.filter((entry) => !entry.alreadyLatest).map((entry) => entry.name);
  if (output !== undefined) {
    appendFileSync(output, `move=${moves.join(" ")}\n`);
  }
  return checked.map(
    (entry) =>
      `ok   ${entry.name}@${version}: on beta, gitHead ${commit}, provenance from ${repository} ${RELEASE_WORKFLOW}${entry.alreadyLatest ? ", already latest" : ""}`,
  );
}

if (import.meta.main) {
  try {
    process.stdout.write(
      `${(await main(process.argv.slice(2), process.cwd(), (spec) => npmView(spec), fetchAttestations)).join("\n")}\n`,
    );
  } catch (error: unknown) {
    process.stderr.write(`FAIL ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
