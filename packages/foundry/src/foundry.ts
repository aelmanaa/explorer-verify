// References: R-DX-2, R-IN-7.
/**
 * Finds a contract's build files in a Foundry project and passes them to the core's input builder.
 * It reads files and picks which ones belong to the contract. It does not detect formats:
 * `buildVerifyInput` in the core does that.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { buildVerifyInput, ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
import type { BuildVerifyInputOptions, BuiltVerifyInput } from "explorer-verify";

import { ownKeys, unknownKeys } from "./known-keys.ts";

/**
 * Options for {@link findFoundryBuild}. `@explorer-verify/hardhat` takes the same fields, except
 * `buildInfoDir`: Hardhat always writes build-info files inside its output directory. An optional
 * field set to `undefined` counts as absent. Any other key throws `invalid-input` naming it and,
 * when one is close, the option it may mean.
 *
 * @example
 * ```ts
 * import type { FindBuildOptions } from "@explorer-verify/foundry";
 *
 * const options: FindBuildOptions = {
 *   root: ".",
 *   contract: "src/Greeter.sol:Greeter",
 * };
 * ```
 * @experimental
 */
export interface FindBuildOptions {
  /**
   * The project root, the directory that holds `foundry.toml`. A relative path resolves against
   * the current working directory.
   */
  root: string;
  /**
   * The contract: `path:Name`, with the source path relative to the root as Foundry names it,
   * such as `src/Greeter.sol:Greeter`, or a bare `Name` that matches one artifact.
   */
  contract: string;
  /**
   * The output directory of the build (the `out` setting of `foundry.toml`), relative to `root` or
   * absolute. Default: `out`.
   */
  outDir?: string | undefined;
  /**
   * The build-info directory, relative to `root` or absolute. Default: `build-info` inside
   * `outDir`. When set, it must be a directory.
   */
  buildInfoDir?: string | undefined;
  /**
   * The contract's artifact file, relative to `root` or absolute, such as
   * `out/Context.sol/Context.0.8.20.json`. Skips the search under `outDir`. Use it when Foundry
   * built the contract with several compiler versions or profiles and wrote one artifact for each.
   */
  artifact?: string | undefined;
}

/**
 * Options for {@link buildVerifyInputFromFoundry}: where to find the build, as for
 * {@link findFoundryBuild}, and the `compilerVersion` and `sources` options of `buildVerifyInput`.
 *
 * @example
 * ```ts
 * import type { BuildFromProjectOptions } from "@explorer-verify/foundry";
 *
 * const options: BuildFromProjectOptions = {
 *   root: ".",
 *   contract: "src/Greeter.sol:Greeter",
 *   compilerVersion: "0.8.24+commit.e11b9ed9",
 * };
 * ```
 * @experimental
 */
export type BuildFromProjectOptions = FindBuildOptions & Omit<BuildVerifyInputOptions, "contract">;

/**
 * What {@link findFoundryBuild} returns: the parsed documents and source contents to pass to
 * `buildVerifyInput`. `findHardhatBuild` in `@explorer-verify/hardhat` returns the same shape.
 *
 * @example
 * ```ts
 * import { buildVerifyInput } from "explorer-verify";
 * import type { ProjectBuild } from "@explorer-verify/foundry";
 *
 * declare const build: ProjectBuild;
 * const built = buildVerifyInput(build.documents, {
 *   contract: build.contract,
 *   sources: build.sources,
 * });
 * ```
 * @experimental
 */
export interface ProjectBuild {
  /**
   * The contract as `path:Name`, read from the artifact's Solidity metadata, or the bare `Name`
   * when the artifact holds no metadata.
   */
  contract: string;
  /**
   * The parsed artifact, then the parsed build-info file when one lists the contract with the
   * same metadata. Pass them to `buildVerifyInput` as they are.
   */
  documents: unknown[];
  /**
   * When no build-info lists the contract: the content of each source file the artifact's
   * metadata names that is a regular file under the root, by its metadata path. Else empty. The
   * contents are not checked here: `buildVerifyInput` checks each one's keccak-256 hash.
   */
  sources: Record<string, string>;
  /**
   * The files read, relative to the root with `/` as the separator: the artifact, then the
   * build-info file when one lists the contract, else the source files in `sources`, sorted.
   */
  files: string[];
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_LISTED = 20;
// The deepest directory level under `outDir` that the artifact search enters.
const MAX_DEPTH = 32;
const MEGABYTE = 1024 * 1024;
// The largest artifact or build-info file read, and the largest source file.
const JSON_LIMIT = 256 * MEGABYTE;
const SOURCE_LIMIT = 16 * MEGABYTE;
// A Unix or Windows root, a home path, a drive or a file URL: never read, never returned.
const LOCAL_PATH = /^\s*(?:[/\\]|~|[a-z]:|file:)/i;
// The Solidity metadata file that `extra_output_files = ["metadata"]` writes next to an artifact.
const METADATA_FILE = ".metadata.json";
const ARTIFACT_FIELDS = ["abi", "bytecode", "deployedBytecode"];

const OUT_HINT =
  "Run forge build in the project root, or pass outDir with the output directory of the build (the out setting of foundry.toml).";
const MISSING_HINT =
  "Check the contract name and the outDir option, then run forge build so the output directory holds the contract's artifact.";
const AMBIGUOUS_HINT =
  "Pass contract as path:Name with one of the paths listed, or pass artifact with one of the files listed.";
const VERSIONS_HINT =
  "Foundry built this contract with several compiler versions or profiles and wrote one artifact for each; a clean build writes them all again. Pass artifact with the file of the build you deployed, one of the files listed.";
const ROOT_HINT =
  "Check that the project folder (options.root) exists and can be read. It should hold foundry.toml.";
const READ_HINT = "Check that the file exists and that this process may read it.";
const JSON_HINT = "Run forge build again to rewrite the file.";
const REBUILD_HINT =
  "No build-info file lists the contract, so the input was rebuilt from the artifact's metadata and the source files under root. Run forge build --build-info, then call again. Or restore each listed source file exactly as it was compiled.";

/** A contract named by the caller: the bare name, and the source path when one was given. */
interface ContractSpec {
  path: string | undefined;
  name: string;
}

/** The checked options, with every path resolved. */
interface Options {
  root: string;
  spec: ContractSpec;
  out: string;
  buildInfoDir: string;
  /** Whether `buildInfoDir` was passed. */
  buildInfoDirSet: boolean;
  artifact: string | undefined;
}

/** An artifact whose file name and metadata match the contract. */
interface ArtifactMatch {
  /** Path relative to the root. */
  file: string;
  document: unknown;
  /** The `path:Name` its metadata targets, or `undefined` when it holds no metadata. */
  target: string | undefined;
  /** The parsed metadata, from `rawMetadata` or `metadata`. */
  metadata: Map<string, unknown> | undefined;
  /** The metadata string exactly as solc wrote it. */
  rawMetadata: string | undefined;
}

/** `invalid-input` with one issue. The message repeats the issue, which holds no secret. */
function invalid(
  field: string,
  message: string,
  hint: string = ERROR_HINTS["invalid-input"],
  cause?: unknown,
): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "invalid-input", issues: [{ field, message }] },
    `The input is invalid: ${field} ${message}.`,
    { hint, ...(cause === undefined ? {} : { cause }), secrets: [] },
  );
}

/** Own fields of a parsed JSON object, or `undefined` for anything else. */
function fieldsOf(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return new Map<string, unknown>(Object.entries(value));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `file` relative to `root`, with forward slashes. */
function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * `file` as an error names it: relative to `root` when it is inside, else the absolute path, so a
 * file outside the project is not shown as a path that starts with `..`.
 */
function shown(root: string, file: string): string {
  return isInside(root, file) ? relative(root, file) : file.split(path.sep).join("/");
}

/** Whether `file` is `dir` or inside it. */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// References: R-DX-2.
/**
 * Checks that the project root is a folder, before the output directory under it. The issue never
 * repeats the path, as the Hardhat helper's does not.
 */
async function checkRoot(root: string): Promise<void> {
  const reason = await folderProblem(root);
  if (reason !== undefined) {
    throw invalid("root", `is not a folder: it ${reason}`, ROOT_HINT);
  }
}

/**
 * Why `dir` is not a folder this process can use: "does not exist", "is a file" or "cannot be
 * read", or `undefined` for a folder.
 */
async function folderProblem(dir: string): Promise<string | undefined> {
  try {
    return (await stat(dir)).isDirectory() ? undefined : "is a file";
  } catch (error) {
    return error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
      ? "does not exist"
      : "cannot be read";
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads a regular file of at most `limit` bytes. A file-system error becomes `invalid-input` on
 * `field`, naming the file relative to the root, with the Node error as its cause.
 */
async function readText(root: string, file: string, field: string, limit: number): Promise<string> {
  const name = shown(root, file);
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      throw invalid(field, `is not a file: ${name}`);
    }
    if (info.size > limit) {
      throw invalid(field, `holds a file larger than ${String(limit / MEGABYTE)} MB: ${name}`);
    }
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      throw error;
    }
    throw invalid(field, `could not be read: ${name}`, READ_HINT, error);
  }
}

/** The entries of a directory, or `invalid-input` on `field` when it cannot be read. */
async function readDirectory(
  root: string,
  dir: string,
  field: string,
): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // A symbolic link is neither: the walk never follows one.
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  } catch (error) {
    throw invalid(field, `could not be read: ${shown(root, dir)}`, READ_HINT, error);
  }
}

/**
 * Every regular file under `dir`, at most {@link MAX_DEPTH} levels down, sorted. It never enters a
 * symbolic link or `skip`.
 */
async function listFiles(root: string, dir: string, skip: string, depth = 0): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readDirectory(root, dir, "outDir")) {
    const file = path.join(dir, entry.name);
    if (entry.isFile) {
      files.push(file);
    } else if (entry.isDirectory && depth < MAX_DEPTH && !isInside(skip, file)) {
      files.push(...(await listFiles(root, file, skip, depth + 1)));
    }
  }
  return files.toSorted();
}

/** The keys of {@link FindBuildOptions}, in documentation order. */
function findKeys(): readonly string[] {
  return Object.keys({
    root: true,
    contract: true,
    outDir: true,
    buildInfoDir: true,
    artifact: true,
  } satisfies Record<keyof FindBuildOptions, true>);
}

/** The keys of {@link BuildFromProjectOptions}, in documentation order. */
function buildKeys(): readonly string[] {
  return Object.keys({
    root: true,
    contract: true,
    outDir: true,
    buildInfoDir: true,
    artifact: true,
    compilerVersion: true,
    sources: true,
  } satisfies Record<keyof BuildFromProjectOptions, true>);
}

// References: R-IN-6.
/**
 * Reads the options. A key outside `known` throws `invalid-input` naming it, never its value.
 */
function readOptions(options: FindBuildOptions, known: readonly string[]): Options {
  // The keys first, so a getter on an unknown key never runs (R-IN-6).
  const keys = ownKeys(options);
  if (keys === undefined) {
    throw invalid("options", "must be an object");
  }
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
  const fields = new Map<string, unknown>(Object.entries(options));
  const rootOption = fields.get("root");
  if (typeof rootOption !== "string" || rootOption.trim() === "") {
    throw invalid("root", "must be the project root as a non-empty string");
  }
  const contract = fields.get("contract");
  if (typeof contract !== "string") {
    throw invalid("contract", "must be path:Name or Name as a string");
  }
  const strings = new Map<string, string>();
  for (const name of ["outDir", "buildInfoDir", "artifact"]) {
    const value = fields.get(name);
    if (typeof value === "string" && value.trim() !== "") {
      strings.set(name, value);
    } else if (value !== undefined) {
      throw invalid(name, "must be a non-empty string when set");
    }
  }
  const root = path.resolve(rootOption);
  const out = path.resolve(root, strings.get("outDir") ?? "out");
  const buildInfoOption = strings.get("buildInfoDir");
  const artifactOption = strings.get("artifact");
  return {
    root,
    spec: readContract(contract),
    out,
    buildInfoDir:
      buildInfoOption === undefined
        ? path.join(out, "build-info")
        : path.resolve(root, buildInfoOption),
    buildInfoDirSet: buildInfoOption !== undefined,
    artifact: artifactOption === undefined ? undefined : path.resolve(root, artifactOption),
  };
}

/** `path:Name` or `Name`, checked; the path uses forward slashes and loses a leading `./`. */
function readContract(contract: string): ContractSpec {
  const colon = contract.lastIndexOf(":");
  const name = contract.slice(colon + 1);
  if (!IDENTIFIER.test(name)) {
    throw invalid("contract", "must be path:Name or Name, with a Solidity identifier as the name");
  }
  if (colon === -1) {
    return { path: undefined, name };
  }
  let sourcePath = contract.slice(0, colon).replaceAll("\\", "/");
  while (sourcePath.startsWith("./")) {
    sourcePath = sourcePath.slice(2);
  }
  if (sourcePath === "") {
    throw invalid("contract", "must have a source path before the colon");
  }
  return { path: sourcePath, name };
}

/**
 * Whether a file name may be the artifact of `name`: `Name.json`, or `Name.<suffix>.json`, but not
 * the `Name.metadata.json` file that holds only the Solidity metadata.
 */
function isArtifactName(base: string, name: string): boolean {
  return (
    base === `${name}.json` ||
    (base.startsWith(`${name}.`) && base.endsWith(".json") && !base.endsWith(METADATA_FILE))
  );
}

/** The Solidity metadata of an artifact: `rawMetadata` parsed, else the `metadata` object. */
function metadataOf(artifact: Map<string, unknown>): {
  parsed: Map<string, unknown> | undefined;
  raw: string | undefined;
} {
  const raw = artifact.get("rawMetadata");
  if (typeof raw === "string") {
    const parsed = fieldsOf(parseJson(raw));
    if (parsed !== undefined) {
      return { parsed, raw };
    }
  }
  return { parsed: fieldsOf(artifact.get("metadata")), raw: undefined };
}

/** The `path:Name` entries of the metadata's `settings.compilationTarget`. */
function targetsOf(metadata: Map<string, unknown> | undefined): string[] {
  const settings = fieldsOf(metadata?.get("settings"));
  const target = fieldsOf(settings?.get("compilationTarget"));
  return [...(target ?? [])].flatMap(([sourcePath, name]) =>
    typeof name === "string" ? [`${sourcePath}:${name}`] : [],
  );
}

/**
 * Reads one candidate file. It is the artifact of `spec` when it holds `abi`, `bytecode` or
 * `deployedBytecode`, and its metadata targets the contract or it holds no metadata.
 */
async function readArtifact(
  root: string,
  file: string,
  field: string,
  spec: ContractSpec,
): Promise<{ match: ArtifactMatch | undefined; artifact: boolean }> {
  const parsed = parseJson(await readText(root, file, field, JSON_LIMIT));
  const fields = fieldsOf(parsed);
  if (fields === undefined) {
    throw invalid(field, `holds a file that is not a JSON object: ${shown(root, file)}`, JSON_HINT);
  }
  if (!ARTIFACT_FIELDS.some((name) => fields.has(name))) {
    return { match: undefined, artifact: false };
  }
  const { parsed: metadata, raw } = metadataOf(fields);
  const targets = targetsOf(metadata);
  const wanted = spec.path === undefined ? undefined : `${spec.path}:${spec.name}`;
  const target = targets.find((candidate) =>
    wanted === undefined ? candidate.endsWith(`:${spec.name}`) : candidate === wanted,
  );
  // An artifact without metadata cannot be told apart by path; its file name matched.
  if (target === undefined && targets.length > 0) {
    return { match: undefined, artifact: true };
  }
  return {
    match: { file: relative(root, file), document: parsed, target, metadata, rawMetadata: raw },
    artifact: true,
  };
}

/**
 * The artifacts of `spec` under `outDir`: files named after the contract, in a directory named
 * after
 * the source file when a path is given, whose metadata targets the contract.
 */
async function findArtifacts(
  root: string,
  files: readonly string[],
  spec: ContractSpec,
): Promise<ArtifactMatch[]> {
  const sourceBase = spec.path === undefined ? undefined : path.posix.basename(spec.path);
  const matches: ArtifactMatch[] = [];
  for (const file of files) {
    if (
      !isArtifactName(path.basename(file), spec.name) ||
      (sourceBase !== undefined && path.basename(path.dirname(file)) !== sourceBase)
    ) {
      continue;
    }
    const { match } = await readArtifact(root, file, "outDir", spec);
    if (match !== undefined) {
      matches.push(match);
    }
  }
  return matches;
}

/** The one artifact of the contract, or `invalid-input` when there is none or more than one. */
async function pickArtifact(
  root: string,
  files: readonly string[],
  spec: ContractSpec,
): Promise<ArtifactMatch> {
  const matches = await findArtifacts(root, files, spec);
  const [match, ...others] = matches;
  if (match === undefined) {
    // A path that names no artifact: list the contracts of that name, so the caller can fix it.
    const elsewhere =
      spec.path === undefined
        ? []
        : (await findArtifacts(root, files, { path: undefined, name: spec.name })).flatMap(
            ({ target }) => (target === undefined ? [] : [target]),
          );
    const known = [...new Set(elsewhere)].toSorted().slice(0, MAX_LISTED);
    throw invalid(
      "contract",
      known.length === 0
        ? "matches no artifact in the output directory"
        : `matches no artifact in the output directory; artifacts of that name: ${known.join(", ")}`,
      MISSING_HINT,
    );
  }
  if (others.length > 0) {
    const listed = matches
      .slice(0, MAX_LISTED)
      .map(({ file, target }) => `${target ?? "a contract without metadata"} (${file})`);
    const more = matches.length > MAX_LISTED ? ", and more" : "";
    const oneContract =
      match.target !== undefined && others.every(({ target }) => target === match.target);
    throw invalid(
      "contract",
      `matches ${String(matches.length)} artifacts: ${listed.join(", ")}${more}`,
      oneContract ? VERSIONS_HINT : AMBIGUOUS_HINT,
    );
  }
  return match;
}

/** The artifact the `artifact` option names, checked against the contract. */
async function readNamedArtifact(
  root: string,
  file: string,
  spec: ContractSpec,
): Promise<ArtifactMatch> {
  const { match, artifact } = await readArtifact(root, file, "artifact", spec);
  if (!artifact) {
    throw invalid(
      "artifact",
      `is not a Foundry artifact with abi or bytecode: ${shown(root, file)}`,
    );
  }
  if (match === undefined) {
    throw invalid("artifact", "holds the artifact of another contract");
  }
  return match;
}

/**
 * The first build-info file, by name, that lists the artifact's contract with the same metadata
 * string. A build-info whose entry or artifact has no metadata string matches on the name alone.
 */
async function findBuildInfo(
  options: Options,
  artifact: ArtifactMatch,
): Promise<{ file: string; document: unknown } | undefined> {
  const { root, buildInfoDir, spec } = options;
  if (!(await isDirectory(buildInfoDir))) {
    if (options.buildInfoDirSet) {
      throw invalid("buildInfoDir", "is not a directory", OUT_HINT);
    }
    return undefined;
  }
  const quoted = JSON.stringify(spec.name);
  const entries = await readDirectory(root, buildInfoDir, "buildInfoDir");
  const names = entries.filter((entry) => entry.isFile && entry.name.endsWith(".json"));
  const sourcePath =
    artifact.target === undefined
      ? undefined
      : artifact.target.slice(0, artifact.target.lastIndexOf(":"));
  for (const entry of names.map(({ name }) => name).toSorted()) {
    const file = path.join(buildInfoDir, entry);
    const text = await readText(root, file, "buildInfoDir", JSON_LIMIT);
    // Most build-info files of a large project do not mention the contract: skip them unparsed.
    if (!text.includes(quoted)) {
      continue;
    }
    const document = parseJson(text);
    if (document === undefined) {
      throw invalid(
        "buildInfoDir",
        `holds a file that is not JSON: ${shown(root, file)}`,
        JSON_HINT,
      );
    }
    const output = fieldsOf(fieldsOf(document)?.get("output"));
    const contracts = fieldsOf(output?.get("contracts"));
    const byPath =
      sourcePath === undefined
        ? [...(contracts ?? new Map<string, unknown>()).values()]
        : [contracts?.get(sourcePath)];
    for (const byName of byPath) {
      const entryFields = fieldsOf(fieldsOf(byName)?.get(spec.name));
      if (entryFields === undefined) {
        continue;
      }
      const metadata = entryFields.get("metadata");
      if (
        artifact.rawMetadata === undefined ||
        typeof metadata !== "string" ||
        metadata === artifact.rawMetadata
      ) {
        return { file: relative(root, file), document };
      }
    }
  }
  return undefined;
}

/**
 * The content of one source file, or `undefined` when it is not a regular file of at most
 * {@link SOURCE_LIMIT} bytes whose real path, after symbolic links, is under the real root.
 */
async function readSource(
  root: string,
  realRoot: string,
  sourcePath: string,
): Promise<string | undefined> {
  const file = path.resolve(root, sourcePath);
  if (LOCAL_PATH.test(sourcePath) || file === root || !isInside(root, file)) {
    return undefined;
  }
  try {
    const real = await realpath(file);
    const info = await stat(real);
    if (!isInside(realRoot, real) || !info.isFile() || info.size > SOURCE_LIMIT) {
      return undefined;
    }
    return await readFile(real, "utf8");
  } catch {
    // A missing or unreadable file is reported by the core, which lists every missing path.
    return undefined;
  }
}

/** Reads each source file the metadata names that {@link readSource} accepts. */
async function readSources(
  root: string,
  metadata: Map<string, unknown> | undefined,
): Promise<Record<string, string>> {
  const realRoot = await realpath(root);
  const sources = fieldsOf(metadata?.get("sources"));
  const entries: [string, string][] = [];
  for (const sourcePath of [...(sources?.keys() ?? [])].toSorted()) {
    const content = await readSource(root, realRoot, sourcePath);
    if (content !== undefined) {
      entries.push([sourcePath, content]);
    }
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return Object.fromEntries(entries);
}

// References: R-DX-2, R-IN-7.
/**
 * Finds the build files of one contract in a Foundry project and returns them parsed, ready for
 * `buildVerifyInput`. It runs no `forge` command and reads no `foundry.toml`.
 *
 * 1. It finds the contract's artifact under `outDir`, or reads the file the `artifact` option
 * names.
 *    The search looks for files named `Name.json` or `Name.<suffix>.json`, such as
 *    `Context.0.8.20.json`, in a directory named after the source file when `contract` has a
 *    path. It skips `Name.metadata.json`, never follows a symbolic link, and goes at most 32
 *    directories deep. It keeps the files that hold `abi`, `bytecode` or `deployedBytecode` and
 *    whose Solidity metadata targets the contract. Foundry puts the artifact of a second source
 *    with the same file name under more of its path, such as `out/b/Token.sol/Token.json`; the
 *    metadata tells the two apart.
 * 2. It reads the build-info files in `buildInfoDir`, in name order, and takes the first whose
 *    `output.contracts` lists the contract with the artifact's exact metadata string. `forge build
 *    --build-info` writes these files; a default `forge build` writes only a stub without the
 *    compiler input, which never lists a contract.
 * 3. When no build-info lists the contract, it reads the source files that the artifact's metadata
 *    names, from the root, so the core can rebuild the input from the metadata. It reads only
 *    regular files of at most 16 MB whose real path, after symbolic links, is under the root.
 *
 * The files under `outDir` and `buildInfoDir` are trusted: they are parsed as they are, up to 256
 * MB
 * each. The source contents are not checked here; `buildVerifyInput` checks their hashes. Paths in
 * `files` are relative to the root, and the core's builder rejects a local path in the input.
 *
 * @param options - The project root, the contract, and the output and build-info directories
 *   and the artifact file when they are not the defaults.
 * @returns The contract name, the parsed documents and sources, and the files read.
 * @throws ExplorerVerifyError `invalid-input` when an option is not valid, the output directory or
 *   a set `buildInfoDir` is not a directory, no artifact matches the contract, more than one does
 *   (each is listed, with its file), the `artifact` file is not the contract's artifact, or a file
 *   is too large, cannot be read or is not JSON. A file-system error is the `cause`; the message
 *   names the file relative to the root.
 * @example
 * ```ts
 * import { buildVerifyInput } from "explorer-verify";
 * import { findFoundryBuild } from "@explorer-verify/foundry";
 *
 * const build = await findFoundryBuild({ root: ".", contract: "src/Greeter.sol:Greeter" });
 * // After a default forge build, build.documents holds only the artifact and build.sources the files.
 * const built = buildVerifyInput(build.documents, {
 *   contract: build.contract,
 *   sources: build.sources,
 * });
 * ```
 * @experimental
 */
export async function findFoundryBuild(options: FindBuildOptions): Promise<ProjectBuild> {
  return await findBuild(readOptions(options, findKeys()));
}

/** {@link findFoundryBuild} on checked options. */
async function findBuild(checked: Options): Promise<ProjectBuild> {
  const { root, spec, out } = checked;
  await checkRoot(root);
  let artifact: ArtifactMatch;
  if (checked.artifact === undefined) {
    const problem = await folderProblem(out);
    if (problem === "cannot be read") {
      throw invalid("outDir", "could not be read", READ_HINT);
    }
    if (problem !== undefined) {
      throw invalid("outDir", "is not a directory", OUT_HINT);
    }
    artifact = await pickArtifact(root, await listFiles(root, out, checked.buildInfoDir), spec);
  } else {
    artifact = await readNamedArtifact(root, checked.artifact, spec);
  }
  const contract = artifact.target ?? spec.name;
  const buildInfo = await findBuildInfo(checked, artifact);
  if (buildInfo !== undefined) {
    return {
      contract,
      documents: [artifact.document, buildInfo.document],
      sources: {},
      files: [artifact.file, buildInfo.file],
    };
  }
  const sources = await readSources(root, artifact.metadata);
  return {
    contract,
    documents: [artifact.document],
    sources,
    files: [artifact.file, ...Object.keys(sources)],
  };
}

// References: R-DX-2, R-IN-7.
/**
 * Finds the contract's build files with {@link findFoundryBuild}, then builds the `compiler` part
 * of `VerifyInput` and the contract name with the core's `buildVerifyInput`. It
 * passes the contract the build names, the source files it read, and the `compilerVersion` and
 * `sources` options. A source in `options.sources` replaces the file read for the same path.
 *
 * @param options - As for {@link findFoundryBuild}, and the `compilerVersion` and `sources`
 *   options of `buildVerifyInput`.
 * @returns The compiler part of `VerifyInput` and the fully qualified contract name. Add `chainId`
 *   and `address` to get a `VerifyInput`.
 * @throws ExplorerVerifyError Every error of {@link findFoundryBuild} and of `buildVerifyInput`.
 *   When no build-info lists the contract and the rebuild from metadata fails with
 *   `incomplete-input` (a source file is missing) or `source-mismatch` (a file changed since the
 *   build), the error keeps its code and details, and its hint says to run
 *   `forge build --build-info`.
 * @example
 * ```ts
 * import { verify } from "explorer-verify";
 * import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
 *
 * const built = await buildVerifyInputFromFoundry({ root: ".", contract: "src/Greeter.sol:Greeter" });
 * const result = await verify({
 *   chainId: 11155111,
 *   address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",...built,
 * });
 * ```
 * @experimental
 */
export async function buildVerifyInputFromFoundry(
  options: BuildFromProjectOptions,
): Promise<BuiltVerifyInput> {
  const build = await findBuild(readOptions(options, buildKeys()));
  const { compilerVersion, sources } = options;
  // With no source read, the caller's sources go to the core as they are, so the core checks them.
  const merged =
    sources === undefined || Object.keys(build.sources).length === 0
      ? (sources ?? build.sources)
      : { ...build.sources, ...sources };
  try {
    return buildVerifyInput(build.documents, {
      contract: build.contract,
      ...(compilerVersion === undefined ? {} : { compilerVersion }),
      sources: merged,
    });
  } catch (error) {
    if (
      build.documents.length === 1 &&
      error instanceof ExplorerVerifyError &&
      (error.code === "incomplete-input" || error.code === "source-mismatch")
    ) {
      throw new ExplorerVerifyError(error.details, error.message, {
        hint: REBUILD_HINT,
        cause: error,
        secrets: [],
      });
    }
    throw error;
  }
}
