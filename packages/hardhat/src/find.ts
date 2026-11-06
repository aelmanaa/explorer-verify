/**
 * Finds the build files of one contract in a Hardhat project (R-DX-2). It reads files and parses
 * JSON; it does not interpret the compiler input. The core's `buildVerifyInput` does that.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";

import { ownKeys, unknownKeys } from "./known-keys.ts";

/**
 * Options for {@link findHardhatBuild}. `@explorer-verify/foundry` takes the same fields, and also
 * `buildInfoDir`: Hardhat always writes build-info files inside its output folder. An optional
 * field set to `undefined` counts as absent. Any other key throws `invalid-input` naming it and,
 * when one is close, the option it may mean.
 *
 * @example
 * ```ts
 * import type { FindBuildOptions } from "@explorer-verify/hardhat";
 *
 * const options: FindBuildOptions = {
 *   root: ".",
 *   contract: "contracts/Greeter.sol:Greeter",
 * };
 * ```
 * @experimental
 */
export interface FindBuildOptions {
  /** The project directory: the folder that holds the Hardhat config. */
  root: string;
  /**
   * The contract: `path:Name`, with the source path as Hardhat names it in the artifacts folder
   * (such as `contracts/Greeter.sol`), or a bare `Name` that matches exactly one artifact. A
   * Hardhat 3 input source name, such as `project/contracts/Greeter.sol`, also works: when no
   * artifact exists under that path, the leading `project/` is dropped.
   */
  contract: string;
  /**
   * The output folder of the build (the `paths.artifacts` setting of the Hardhat config), relative
   * to `root` or absolute. Defaults to `artifacts`.
   */
  outDir?: string | undefined;
  /**
   * The contract's artifact file, relative to `root` or absolute, such as
   * `artifacts/contracts/Greeter.sol/Greeter.json`. Skips the search under `outDir`. The file must
   * be inside `outDir` and be the artifact of `contract`: named `<Name>.json`, and under the
   * contract's source path when `contract` has one.
   */
  artifact?: string | undefined;
}

/**
 * The build files of one contract, parsed: the artifact, the build-info and, for Hardhat 3, the
 * build-info output file. Pass `documents` to `buildVerifyInput` from `explorer-verify`.
 * `findFoundryBuild` in `@explorer-verify/foundry` returns the same shape.
 *
 * @example
 * ```ts
 * import type { ProjectBuild } from "@explorer-verify/hardhat";
 *
 * function describe(build: ProjectBuild): string {
 *   return build.files.join(", "); // "artifacts/contracts/Greeter.sol/Greeter.json, ..."
 * }
 * ```
 * @experimental
 */
export interface ProjectBuild {
  /**
   * The contract as `path:Name`, with the source path as Hardhat names it in the output folder,
   * such as `contracts/Greeter.sol:Greeter`. It comes from where the artifact is, not from its
   * content; `buildVerifyInput` reads the full name from the documents.
   */
  contract: string;
  /** The parsed JSON documents, in the order of `files`. */
  documents: unknown[];
  /** Always empty: a Hardhat build-info file holds every source. */
  sources: Record<string, string>;
  /** The path of each file read, relative to `root`, with `/` as the separator. */
  files: string[];
}

const DEFAULT_ARTIFACTS = "artifacts";
// Hardhat writes build-info files to this folder of the artifacts folder.
const BUILD_INFO_DIR = "build-info";
// Hardhat 3 prefixes the input source name of a project file with this folder.
const PROJECT_PREFIX = "project/";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// A Hardhat 3 build id is a file name: letters, digits, `_`, `-` and `.`, never a separator.
const BUILD_ID = /^[A-Za-z0-9_.-]+$/;
const MAX_CANDIDATES = 20;
// The largest file the helper reads: 256 MiB, far above the build-info of a large project.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

const COMPILE_HINT =
  "Compile the project (npx hardhat compile on Hardhat 2, npx hardhat build on Hardhat 3), then try again.";
const ARTIFACTS_HINT =
  "Compile the project first, or pass options.outDir with the paths.artifacts value of the Hardhat config.";
const CONTRACT_HINT =
  "Pass options.contract as path:Name, such as contracts/Greeter.sol:Greeter, or as a Name that matches one entry of details.candidates.";

/** `invalid-input` with one issue. The message repeats the issue, which holds no secret. */
function invalid(
  field: string,
  message: string,
  hint: string = ERROR_HINTS["invalid-input"],
): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "invalid-input", issues: [{ field, message }] },
    `The input is invalid: ${field} ${message}.`,
    { hint, secrets: [] },
  );
}

function missingInput(message: string): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "incomplete-input", field: "input", candidates: [] },
    message,
    { hint: COMPILE_HINT, secrets: [] },
  );
}

/** Whether `error` is a file-system error with one of `codes`. */
function hasCode(error: unknown, codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

const NOT_FOUND = ["ENOENT", "ENOTDIR"] as const;

/** An own field of a JSON object, or `undefined`. */
function ownField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, name)?.value;
}

/** Whether `child` is `parent` or inside it. A name that starts with `..`, such as `..x`, is inside. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Reads the project's files and names them relative to the project root. */
class Project {
  readonly root: string;
  readonly artifacts: string;
  /** The artifacts folder with its symlinks resolved, set by {@link Project.open}. */
  private real = "";

  constructor(root: string, artifacts: string) {
    this.root = path.resolve(root);
    this.artifacts = path.resolve(this.root, artifacts);
  }

  /** `file` relative to the root, with `/` as the separator. */
  show(file: string): string {
    return path.relative(this.root, file).split(path.sep).join("/");
  }

  /** `invalid-input` for a file or folder that exists but cannot be read, with the cause kept. */
  unreadable(file: string, cause: unknown): ExplorerVerifyError {
    return new ExplorerVerifyError(
      { code: "invalid-input", issues: [{ field: this.show(file), message: "cannot be read" }] },
      `The input is invalid: ${this.show(file)} cannot be read.`,
      { hint: ERROR_HINTS["invalid-input"], cause, secrets: [] },
    );
  }

  /** Checks that the artifacts folder exists and is a folder, and resolves its symlinks. */
  async open(): Promise<void> {
    const shown = this.show(this.artifacts);
    try {
      this.real = await realpath(this.artifacts);
    } catch (error) {
      if (hasCode(error, NOT_FOUND)) {
        throw invalid("outDir", `names no folder: ${shown} does not exist`, ARTIFACTS_HINT);
      }
      throw this.unreadable(this.artifacts, error);
    }
    if (!(await stat(this.real)).isDirectory()) {
      throw invalid("outDir", `names no folder: ${shown} is a file`, ARTIFACTS_HINT);
    }
  }

  /**
   * The parsed JSON of `file`, or `undefined` when the file does not exist. The file, with its
   * symlinks resolved, must be a regular file inside the artifacts folder and at most
   * {@link MAX_FILE_BYTES} long.
   */
  async read(file: string): Promise<unknown> {
    const shown = this.show(file);
    let text: string;
    try {
      const real = await realpath(file);
      if (!isInside(this.real, real)) {
        throw invalid(shown, "resolves to a path outside the artifacts folder");
      }
      const info = await stat(real);
      if (!info.isFile()) {
        throw invalid(shown, "is not a file");
      }
      if (info.size > MAX_FILE_BYTES) {
        throw invalid(shown, "is larger than 256 MiB");
      }
      text = await readFile(real, "utf8");
    } catch (error) {
      if (error instanceof ExplorerVerifyError) {
        throw error;
      }
      if (hasCode(error, NOT_FOUND)) {
        return undefined;
      }
      throw this.unreadable(file, error);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch {
      throw invalid(shown, "is not valid JSON", COMPILE_HINT);
    }
  }

  /**
   * The files named `<name>.json` in the artifacts folder, relative to it with `/` as the
   * separator. The walk never follows a symlink and skips the top-level build-info folder.
   */
  async search(name: string): Promise<string[]> {
    const found: string[] = [];
    await this.walk(this.real, "", `${name}.json`, found);
    return found;
  }

  private async walk(
    folder: string,
    relative: string,
    file: string,
    found: string[],
  ): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
      throw this.unreadable(path.join(this.artifacts, relative), error);
    });
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      // A Dirent describes the entry itself: a symlink is neither a directory nor a file here.
      if (entry.isDirectory() && !(relative === "" && entry.name === BUILD_INFO_DIR)) {
        await this.walk(path.join(folder, entry.name), child, file, found);
      } else if (entry.isFile() && entry.name === file) {
        found.push(child);
      }
    }
  }
}

/** The checked options: `artifact` is `undefined` when it was not passed. */
interface CheckedOptions {
  root: string;
  contract: string;
  outDir: string;
  artifact: string | undefined;
}

/** The keys of {@link FindBuildOptions}, in documentation order. */
function optionKeys(): readonly string[] {
  return Object.keys({
    root: true,
    contract: true,
    outDir: true,
    artifact: true,
  } satisfies Record<keyof FindBuildOptions, true>);
}

/**
 * Reads the options; an unknown key or a wrong type gives `invalid-input` naming the option, never
 * its value.
 */
function readOptions(options: FindBuildOptions, extra: readonly string[]): CheckedOptions {
  if (Array.isArray(options)) {
    throw invalid("options", "must be a plain object");
  }
  const known = [...optionKeys(), ...extra];
  const keys = ownKeys(options);
  if (keys !== undefined) {
    const unknown = unknownKeys(keys, known, "", "options");
    if (unknown.length > 0) {
      throw new ExplorerVerifyError(
        { code: "invalid-input", issues: unknown },
        `The input is invalid: ${unknown.map((issue) => issue.field).join(", ")}.`,
        {
          hint: `Pass only ${known.slice(0, -1).join(", ")} and ${String(known.at(-1))} as options.`,
          secrets: [],
        },
      );
    }
  }
  const root: unknown = ownField(options, "root");
  const contract: unknown = ownField(options, "contract");
  const outDir: unknown = ownField(options, "outDir") ?? DEFAULT_ARTIFACTS;
  const artifact: unknown = ownField(options, "artifact");
  if (typeof root !== "string" || root === "") {
    throw invalid("root", "must be the project directory as a non-empty string");
  }
  if (typeof contract !== "string") {
    throw invalid("contract", "must be path:Name or Name as a string");
  }
  if (typeof outDir !== "string" || outDir === "") {
    throw invalid("outDir", "must be a non-empty string");
  }
  if (artifact !== undefined && (typeof artifact !== "string" || artifact === "")) {
    throw invalid("artifact", "must be a non-empty string when set");
  }
  return { root, contract, outDir, artifact };
}

/** The `Name` part of `path:Name` or `Name`, checked. */
function contractName(contract: string): string {
  const name = contract.slice(contract.lastIndexOf(":") + 1);
  if (!IDENTIFIER.test(name)) {
    throw invalid("contract", "must be path:Name or Name, with a Solidity identifier as Name");
  }
  return name;
}

/**
 * The artifact files of `path:Name`, absolute, in the order to try: the path, then the path
 * without a leading `project/`.
 */
function sourceArtifacts(project: Project, source: string, name: string): [string, ...string[]] {
  const fallback = source.startsWith(PROJECT_PREFIX) ? [source.slice(PROJECT_PREFIX.length)] : [];
  const sources = [source, ...fallback];
  const file = (each: string): string => path.resolve(project.artifacts, each, `${name}.json`);
  if (
    sources.some(
      (each) => each === "" || path.isAbsolute(each) || !isInside(project.artifacts, file(each)),
    )
  ) {
    throw invalid("contract", "must have a source path relative to the artifacts folder");
  }
  return [file(source), ...fallback.map(file)];
}

/**
 * The file the `artifact` option names, absolute, checked against `contract`: inside the output
 * folder, named `<Name>.json`, and one of the files of `path:Name` when the contract has a path.
 */
function namedArtifact(project: Project, contract: string, artifact: string): [string] {
  const colon = contract.lastIndexOf(":");
  const name = contractName(contract);
  const file = path.resolve(project.root, artifact);
  const allowed =
    colon === -1
      ? isInside(project.artifacts, file) && path.basename(file) === `${name}.json`
      : sourceArtifacts(project, contract.slice(0, colon), name).includes(file);
  if (!allowed) {
    throw invalid(
      "artifact",
      `is not the artifact of the contract in the artifacts folder: ${project.show(file)}`,
    );
  }
  return [file];
}

/** The contract as `path:Name`, from where its artifact is in the output folder. */
function contractOf(project: Project, artifactFile: string): string {
  const relative = path.relative(project.artifacts, artifactFile).split(path.sep).join("/");
  const name = path.posix.basename(relative, ".json");
  const source = path.posix.dirname(relative);
  return source === "." ? name : `${source}:${name}`;
}

/**
 * The artifact files that may hold `contract`, absolute, in the order to try: for `path:Name`,
 * the path, then the path without a leading `project/`; for a bare name, the one match.
 */
async function locateArtifact(project: Project, contract: string): Promise<[string, ...string[]]> {
  const colon = contract.lastIndexOf(":");
  const name = contractName(contract);
  if (colon !== -1) {
    return sourceArtifacts(project, contract.slice(0, colon), name);
  }
  const matches = await project.search(name);
  const [match, ...more] = matches;
  if (match === undefined) {
    throw invalid(
      "contract",
      `matches no artifact under ${project.show(project.artifacts)}`,
      COMPILE_HINT,
    );
  }
  if (more.length > 0) {
    const candidates = matches.map((entry) => `${path.posix.dirname(entry)}:${name}`).toSorted();
    throw new ExplorerVerifyError(
      {
        code: "incomplete-input",
        field: "contract",
        candidates: candidates.slice(0, MAX_CANDIDATES),
      },
      `The contract name matches ${String(matches.length)} artifacts.`,
      { hint: CONTRACT_HINT, secrets: [] },
    );
  }
  return [path.join(project.artifacts, match)];
}

/** The first of `files` that exists, parsed, with its path; names the first when none does. */
async function readArtifact(
  project: Project,
  files: readonly [string, ...string[]],
): Promise<{ file: string; artifact: unknown }> {
  for (const file of files) {
    const artifact = await project.read(file);
    if (artifact !== undefined) {
      return { file, artifact };
    }
  }
  throw invalid(
    "contract",
    `matches no artifact: ${project.show(files[0])} does not exist`,
    COMPILE_HINT,
  );
}

/** Reads a required build-info file, or throws `incomplete-input` naming it. */
async function readBuildFile(project: Project, file: string, what: string): Promise<unknown> {
  const document = await project.read(file);
  if (document === undefined) {
    throw missingInput(`The ${what} ${project.show(file)} was not found.`);
  }
  return document;
}

/**
 * Finds and parses the build files of one contract in a Hardhat 2 or Hardhat 3 project (R-DX-2).
 * It reads files only; it does not run a compile, load the Hardhat config or need `hardhat`
 * installed.
 *
 * - The artifact is `<outDir>/<path>/<Name>.json`, or the file the `artifact` option names. A bare
 *   `Name` is searched for in the output folder, outside `build-info/`, without following
 *   symlinks, and must match one file.
 * - Hardhat 3: the artifact's `buildInfoId` names `<outDir>/build-info/<id>.json` and its output
 *   file `<id>.output.json`. Both are read.
 * - Hardhat 2: the artifact has no `buildInfoId`. The `buildInfo` path in `<Name>.dbg.json`, next
 *   to the artifact, names the build-info file, which must be in `<outDir>/build-info/`.
 *
 * Each file it reads, with its symlinks resolved, must be a regular file inside the output folder
 * and at most 256 MiB long.
 *
 * @param options - The project root, the contract and, when the config moves it, the output
 *   folder; or the artifact file.
 * @returns The contract as `path:Name`, the parsed documents, an empty `sources` and the files
 *   the documents came from, relative to `root`.
 * @throws ExplorerVerifyError `invalid-input` for an option of the wrong type, an output folder
 *   that is missing or is a file, a contract with no artifact (the message names the file it
 *   looked for), an `artifact` file that is not the contract's artifact in the output folder, a
 *   source path outside the output folder, a file that is not JSON, cannot be read, is not a
 *   regular file, is larger than 256 MiB or resolves outside the output folder, or a `buildInfo`
 *   path outside the build-info folder; `incomplete-input` with `details.field`
 *   `contract` and the matches in `details.candidates` when a bare name matches several
 *   artifacts, or with `details.field` `input` and the path it looked for in the message when a
 *   build-info file or the `.dbg.json` file is missing.
 * @example
 * ```ts
 * import { buildVerifyInput } from "explorer-verify";
 * import { findHardhatBuild } from "@explorer-verify/hardhat";
 *
 * const build = await findHardhatBuild({ root: ".", contract: "Greeter" });
 * // build.files: ["artifacts/contracts/Greeter.sol/Greeter.json", "artifacts/build-info/<id>.json", ...]
 * const built = buildVerifyInput(build.documents);
 * ```
 * @experimental
 */
export async function findHardhatBuild(options: FindBuildOptions): Promise<ProjectBuild> {
  return await findBuild(options, []);
}

/**
 * {@link findHardhatBuild} for a caller whose options also hold `extra` keys, which it accepts and
 * does not read. Internal: the package entry point does not export it.
 */
export async function findBuild(
  options: FindBuildOptions,
  extra: readonly string[],
): Promise<ProjectBuild> {
  const checked = readOptions(options, extra);
  const project = new Project(checked.root, checked.outDir);
  await project.open();
  const { file: artifactFile, artifact } = await readArtifact(
    project,
    checked.artifact === undefined
      ? await locateArtifact(project, checked.contract)
      : namedArtifact(project, checked.contract, checked.artifact),
  );
  const contract = contractOf(project, artifactFile);
  const buildInfoDir = path.join(project.artifacts, BUILD_INFO_DIR);
  const buildInfoId = ownField(artifact, "buildInfoId");
  if (buildInfoId !== undefined) {
    if (typeof buildInfoId !== "string" || !BUILD_ID.test(buildInfoId)) {
      throw invalid(project.show(artifactFile), "has a buildInfoId that is not a file name");
    }
    const inputFile = path.join(buildInfoDir, `${buildInfoId}.json`);
    const outputFile = path.join(buildInfoDir, `${buildInfoId}.output.json`);
    const input = await readBuildFile(project, inputFile, "build-info file");
    const output = await readBuildFile(project, outputFile, "build-info output file");
    return {
      contract,
      documents: [artifact, input, output],
      sources: {},
      files: [artifactFile, inputFile, outputFile].map((file) => project.show(file)),
    };
  }
  const debugFile = artifactFile.replace(/\.json$/, ".dbg.json");
  const debug = await project.read(debugFile);
  if (debug === undefined) {
    throw missingInput(
      `The artifact ${project.show(artifactFile)} names no build-info: it has no buildInfoId, and ${project.show(debugFile)} was not found.`,
    );
  }
  const reference = ownField(debug, "buildInfo");
  if (typeof reference !== "string") {
    throw invalid(project.show(debugFile), "has no buildInfo path");
  }
  const inputFile = path.resolve(path.dirname(debugFile), reference);
  if (!isInside(buildInfoDir, inputFile)) {
    throw invalid(project.show(debugFile), "has a buildInfo path outside the build-info folder");
  }
  const input = await readBuildFile(project, inputFile, "build-info file");
  return {
    contract,
    documents: [artifact, input],
    sources: {},
    files: [artifactFile, inputFile].map((file) => project.show(file)),
  };
}
