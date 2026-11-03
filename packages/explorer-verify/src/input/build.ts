/**
 * The format-detecting input builder (R-IN-7): turns compiler JSON of unknown origin into the
 * `compiler` part of `VerifyInput` and the fully qualified contract name.
 */
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { readFields } from "../internal/read-fields.ts";
import type { VerifyInput } from "../types.ts";
import { validateInput } from "./validate.ts";

/**
 * Options for {@link buildVerifyInput}. Every field is optional.
 *
 * @example
 * ```ts
 * import type { BuildVerifyInputOptions } from "explorer-verify";
 *
 * const options: BuildVerifyInputOptions = {
 *   contract: "src/Greeter.sol:Greeter",
 *   compilerVersion: "0.8.24+commit.e11b9ed9",
 * };
 * ```
 * @experimental
 */
export interface BuildVerifyInputOptions {
  /**
   * The contract to verify: `path:Name`, or a bare `Name` that matches exactly one contract in the
   * documents. Required when the documents name no single contract.
   */
  contract?: string;
  /**
   * The full compiler version, such as `0.8.24+commit.e11b9ed9`. Used only when the documents hold
   * no full version; when they do, it must be the same version.
   */
  compilerVersion?: string;
}

/**
 * What {@link buildVerifyInput} returns: the two fields of `VerifyInput` that come from the build.
 *
 * @example
 * ```ts
 * import type { BuiltVerifyInput, VerifyInput } from "explorer-verify";
 *
 * function complete(built: BuiltVerifyInput, chainId: number, address: `0x${string}`): VerifyInput {
 *   return { chainId, address, ...built };
 * }
 * ```
 * @experimental
 */
export interface BuiltVerifyInput {
  /** The compiler kind, the full version and the Standard JSON input. */
  compiler: VerifyInput["compiler"];
  /** The fully qualified contract name, as `path:Name`, with a path that is a key of the sources. */
  contractName: string;
}

const STANDARD_JSON_FIELDS = ["language", "sources", "settings"] as const;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// After optional spaces: a Unix or Windows root (`/`, `\`, UNC), a home path (`~`, `~name/`), a
// drive (`C:\`, `C:/` or drive-relative `C:file`) or a file URL, in any case.
const ABSOLUTE_PATH = /^\s*(?:[/\\]|~|[a-z]:|file:)/i;
const SEGMENT_SEPARATOR = /[/\\]/;
const MAX_CANDIDATES = 20;
const MAX_POSITIONS = 5;
// Stand-ins so validateInput checks the built part; they never leave this module.
const PLACEHOLDER_CHAIN_ID = 1;
const PLACEHOLDER_ADDRESS = `0x${"0".repeat(40)}`;

const STUB_HINT =
  "The build-info holds no compiler input. Rebuild with build-info enabled (forge build --build-info), then pass the new build-info file.";
const METADATA_ONLY_HINT =
  "Pass the build-info of the same build. Rebuilding the input from Solidity metadata alone arrives in #21.";
const OUTPUT_ONLY_HINT =
  "Pass the build-info that holds the compiler input, next to its output file or artifact.";
const VERSION_HINT =
  "Pass options.compilerVersion with the full version, such as 0.8.24+commit.e11b9ed9, or add an artifact or build-info output that holds the contract metadata.";
const CONTRACT_HINT =
  "Pass options.contract as path:Name, or as a Name that matches one entry of details.candidates.";
const ABSOLUTE_HINT =
  "Rebuild with source paths and remappings relative to the project root, so no local path is published.";

/** What the documents hold, collected in one pass. */
class Findings {
  /** Standard JSON inputs, from build-info or bare. */
  readonly inputs: Map<string, unknown>[] = [];
  /** `solcLongVersion` values in the long form. */
  readonly longVersions = new Set<string>();
  /** Versions from contract metadata. */
  readonly metadataVersions = new Set<string>();
  /** Whether a short version was seen with no commit. */
  shortVersion = false;
  /** Fully qualified names listed in build-info output. */
  readonly listed = new Set<string>();
  /** Fully qualified names that artifacts or their metadata point at. */
  readonly identities = new Set<string>();
  /** Hardhat-style user source name to input source name. */
  readonly userSourceNames = new Map<string, string>();
  /** The field naming a compiler other than solc, when one was seen. */
  unsupported: string | undefined;
  /** Build ids: a build-info's or output file's `id`, an artifact's `buildInfoId`. */
  readonly buildIds = new Set<string>();
  stub = false;
  /** Whether Solidity metadata was seen, in an artifact or on its own. */
  metadata = false;
  /** Whether a build-info output without its input was seen. */
  output = false;
  plainArtifact = false;
  /** 1-based positions of documents that match no shape. */
  readonly unknown: number[] = [];
}

/** `"positions 1, 3"` or `"position 2"`, at most {@link MAX_POSITIONS} listed. */
function positions(list: readonly number[]): string {
  const shown = list.slice(0, MAX_POSITIONS).join(", ");
  const more = list.length > MAX_POSITIONS ? " and more" : "";
  return `${list.length === 1 ? "position" : "positions"} ${shown}${more}`;
}

function hasStandardJsonShape(fields: Map<string, unknown>): boolean {
  return STANDARD_JSON_FIELDS.every((name) => fields.has(name));
}

/**
 * Solidity metadata at the top level: no `input`, and a `compiler` or `output` object, or a
 * `settings.compilationTarget`. Standard JSON input has none of these.
 */
function hasMetadataShape(fields: Map<string, unknown>): boolean {
  return (
    readFields(fields.get("compiler")) !== undefined ||
    readFields(fields.get("output")) !== undefined ||
    readFields(readFields(fields.get("settings"))?.get("compilationTarget")) !== undefined
  );
}

/** Records a string build id. */
function readBuildId(value: unknown, findings: Findings): void {
  if (typeof value === "string") {
    findings.buildIds.add(value);
  }
}

/**
 * Whether `path` would publish a location on the build machine: an absolute path, a home path, a
 * drive, a file URL, or a relative path whose `..` segments climb above the project root.
 */
function isLocalPath(path: string): boolean {
  if (ABSOLUTE_PATH.test(path)) {
    return true;
  }
  let depth = 0;
  for (const segment of path.split(SEGMENT_SEPARATOR)) {
    if (segment === "..") {
      depth--;
      if (depth < 0) {
        return true;
      }
    } else if (segment !== "" && segment !== ".") {
      depth++;
    }
  }
  return false;
}

/** The fields of a metadata object, or of a metadata JSON string. */
function readMetadata(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "string") {
    return readFields(value);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return readFields(parsed);
  } catch {
    return undefined;
  }
}

/** Records the version and the compilation target of one metadata value. */
function readMetadataFacts(value: unknown, findings: Findings, target: boolean): void {
  const metadata = readMetadata(value);
  if (metadata === undefined) {
    return;
  }
  const version = readFields(metadata.get("compiler"))?.get("version");
  if (typeof version === "string") {
    findings.metadataVersions.add(version);
  }
  if (!target) {
    return;
  }
  const settings = readFields(metadata.get("settings"));
  const compilationTarget = readFields(settings?.get("compilationTarget"));
  for (const [path, name] of compilationTarget ?? []) {
    if (typeof name === "string") {
      findings.identities.add(`${path}:${name}`);
    }
  }
}

/** Lists the contracts of a build-info output and reads the version from their metadata. */
function readOutput(value: unknown, findings: Findings): void {
  const contracts = readFields(readFields(value)?.get("contracts"));
  for (const [path, byName] of contracts ?? []) {
    for (const [name, entry] of readFields(byName) ?? []) {
      findings.listed.add(`${path}:${name}`);
      readMetadataFacts(readFields(entry)?.get("metadata"), findings, false);
    }
  }
}

function readBuildInfo(
  fields: Map<string, unknown>,
  input: Map<string, unknown>,
  findings: Findings,
): void {
  findings.inputs.push(input);
  readBuildId(fields.get("id"), findings);
  const longVersion = fields.get("solcLongVersion");
  if (typeof longVersion === "string") {
    if (longVersion.includes("+commit.")) {
      findings.longVersions.add(longVersion);
    } else {
      findings.shortVersion = true;
    }
  }
  for (const [user, inputName] of readFields(fields.get("userSourceNameMap")) ?? []) {
    if (typeof inputName === "string") {
      findings.userSourceNames.set(user, inputName);
    }
  }
  readOutput(fields.get("output"), findings);
}

function readArtifact(fields: Map<string, unknown>, findings: Findings): void {
  findings.plainArtifact = true;
  readBuildId(fields.get("buildInfoId"), findings);
  const inputSourceName = fields.get("inputSourceName");
  const sourceName = fields.get("sourceName");
  const path = typeof inputSourceName === "string" ? inputSourceName : sourceName;
  const name = fields.get("contractName");
  if (typeof path === "string" && typeof name === "string") {
    findings.identities.add(`${path}:${name}`);
  }
}

/** Classifies one document by its shape and records what it holds. */
function classify(document: unknown, position: number, findings: Findings): void {
  const fields = readFields(document);
  if (fields === undefined) {
    findings.unknown.push(position);
    return;
  }
  const compilerType = fields.get("compilerType");
  if (compilerType !== undefined && compilerType !== "solc") {
    findings.unsupported = "compilerType";
  }
  const input = readFields(fields.get("input"));
  if (input !== undefined && hasStandardJsonShape(input)) {
    readBuildInfo(fields, input, findings);
  } else if (fields.has("source_id_to_path") && !fields.has("input")) {
    findings.stub = true;
  } else if (
    !fields.has("input") &&
    readFields(readFields(fields.get("output"))?.get("contracts")) !== undefined
  ) {
    findings.output = true;
    readBuildId(fields.get("id"), findings);
    readOutput(fields.get("output"), findings);
  } else if (!fields.has("input") && hasMetadataShape(fields)) {
    findings.metadata = true;
    readMetadataFacts(document, findings, true);
  } else if (hasStandardJsonShape(fields)) {
    findings.inputs.push(fields);
  } else if (fields.has("metadata") || fields.has("rawMetadata")) {
    findings.metadata = true;
    readBuildId(fields.get("buildInfoId"), findings);
    readMetadataFacts(fields.get("metadata") ?? fields.get("rawMetadata"), findings, true);
  } else if (fields.has("abi") && fields.has("bytecode")) {
    readArtifact(fields, findings);
  } else {
    findings.unknown.push(position);
  }
}

function invalid(field: string, message: string, hint?: string): ExplorerVerifyError {
  const issues: InputIssue[] = [{ field, message }];
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The input is invalid: ${field}.`,
    hint === undefined ? { secrets: [] } : { hint, secrets: [] },
  );
}

function incomplete(
  field: string,
  message: string,
  hint: string,
  candidates: readonly string[] = [],
): ExplorerVerifyError {
  return new ExplorerVerifyError(
    {
      code: "incomplete-input",
      field,
      candidates: [...candidates].toSorted().slice(0, MAX_CANDIDATES),
    },
    message,
    { hint, secrets: [] },
  );
}

function unsupportedCompiler(field: string): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "unsupported-compiler", field },
    `The documents come from a compiler other than solc: ${field}.`,
    { secrets: [] },
  );
}

/** The one compiler input, or the error that explains why there is none. */
function pickInput(findings: Findings): Map<string, unknown> {
  const [input, ...others] = findings.inputs;
  if (others.length > 0) {
    throw invalid(
      "documents",
      "hold more than one compiler input; pass the documents of one build",
    );
  }
  if (input !== undefined) {
    return input;
  }
  if (findings.stub) {
    throw incomplete(
      "input",
      "The documents hold no compiler input: the build-info was written without it.",
      STUB_HINT,
    );
  }
  if (findings.metadata) {
    throw incomplete(
      "input",
      "The documents hold no compiler input: only Solidity metadata.",
      METADATA_ONLY_HINT,
    );
  }
  if (findings.plainArtifact && !findings.output) {
    throw new ExplorerVerifyError(
      { code: "insufficient-artifact", field: "input" },
      "The documents hold no compiler input or settings: only ABI and bytecode.",
      { secrets: [] },
    );
  }
  throw incomplete("input", "The documents hold no compiler input.", OUTPUT_ONLY_HINT);
}

/** Throws when any of `paths` is a local path, naming `field` and the positions, never a path. */
function rejectLocalPaths(paths: readonly unknown[], field: string): void {
  const local: number[] = [];
  paths.forEach((path, index) => {
    if (typeof path === "string" && isLocalPath(path)) {
      local.push(index + 1);
    }
  });
  if (local.length > 0) {
    throw invalid(field, `has a local path at ${positions(local)}`, ABSOLUTE_HINT);
  }
}

/** Every part of a remapping `context:prefix=target` that names a path, and the whole left side. */
function remappingParts(remapping: unknown): string[] {
  if (typeof remapping !== "string") {
    return [];
  }
  const equals = remapping.indexOf("=");
  const left = equals === -1 ? remapping : remapping.slice(0, equals);
  const target = equals === -1 ? "" : remapping.slice(equals + 1);
  const colon = left.indexOf(":");
  return colon === -1
    ? [left, target]
    : [left, left.slice(0, colon), left.slice(colon + 1), target];
}

/**
 * Rejects a source path, either side of a remapping, or a `libraries` or `outputSelection` key
 * that is a local path, so no path on the build machine is published.
 */
function checkRelativePaths(sources: Map<string, unknown>, settings: unknown): void {
  rejectLocalPaths([...sources.keys()], "compiler.input.sources");
  const fields = readFields(settings);
  const remappings = fields?.get("remappings");
  const list: unknown[] = Array.isArray(remappings) ? remappings : [];
  const local = list.map((remapping) => remappingParts(remapping).some(isLocalPath));
  rejectLocalPaths(
    local.map((isLocal) => (isLocal ? "/" : "")),
    "compiler.input.settings.remappings",
  );
  for (const name of ["libraries", "outputSelection"]) {
    rejectLocalPaths(
      [...(readFields(fields?.get(name))?.keys() ?? [])],
      `compiler.input.settings.${name}`,
    );
  }
}

/**
 * Each source cut down to `content`, and `keccak256` when it is a string. Other fields, such as
 * `urls`, may hold a local path and are dropped. An entry that is not an object is kept as it is,
 * so `validateInput` reports it.
 */
function copySources(sources: Map<string, unknown>): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const [path, entry] of sources) {
    const fields = readFields(entry);
    if (fields === undefined) {
      entries.push([path, entry]);
      continue;
    }
    const keccak256 = fields.get("keccak256");
    entries.push([
      path,
      typeof keccak256 === "string"
        ? { content: fields.get("content"), keccak256 }
        : { content: fields.get("content") },
    ]);
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return Object.fromEntries(entries);
}

/** A version without its leading `v`, for comparison only. */
function bare(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

function pickVersion(findings: Findings, option: string | undefined): string {
  const [long] = findings.longVersions;
  const fromMetadata = [...findings.metadataVersions];
  const distinct = new Set([...findings.longVersions, ...fromMetadata].map(bare));
  if (distinct.size > 1) {
    throw invalid("documents", "hold different compiler versions; pass the documents of one build");
  }
  const found = long ?? fromMetadata[0];
  if (found === undefined) {
    if (option !== undefined) {
      return option;
    }
    throw incomplete(
      "compilerVersion",
      findings.shortVersion
        ? "The documents hold only the short compiler version, without its commit."
        : "The documents hold no compiler version.",
      VERSION_HINT,
    );
  }
  if (option !== undefined && bare(option) !== bare(found)) {
    throw invalid("compilerVersion", "differs from the compiler version in the documents");
  }
  return found;
}

/** `path` when it is a source key, or the input name of a user source name, else `undefined`. */
function sourceKey(
  path: string,
  keys: ReadonlySet<string>,
  findings: Findings,
): string | undefined {
  if (keys.has(path)) {
    return path;
  }
  const mapped = findings.userSourceNames.get(path);
  return mapped !== undefined && keys.has(mapped) ? mapped : undefined;
}

/** `path:Name` with the path moved to its source key, or `undefined` when it has none. */
function qualify(name: string, keys: ReadonlySet<string>, findings: Findings): string | undefined {
  const colon = name.lastIndexOf(":");
  const path = sourceKey(name.slice(0, colon), keys, findings);
  return path === undefined ? undefined : `${path}:${name.slice(colon + 1)}`;
}

function pickContract(
  findings: Findings,
  keys: ReadonlySet<string>,
  option: string | undefined,
): string {
  if (option !== undefined && option.includes(":")) {
    if (!IDENTIFIER.test(option.slice(option.lastIndexOf(":") + 1))) {
      throw invalid(
        "contract",
        "must be path:Name, with a Solidity identifier after the last colon",
      );
    }
    const name = qualify(option, keys, findings);
    if (name === undefined) {
      throw invalid("contract", "has a path that is not a key of the compiler input's sources");
    }
    return name;
  }
  const known = new Set<string>();
  for (const name of [...findings.identities, ...findings.listed]) {
    const qualified = qualify(name, keys, findings);
    if (qualified !== undefined) {
      known.add(qualified);
    }
  }
  if (option !== undefined) {
    if (!IDENTIFIER.test(option)) {
      throw invalid("contract", "must be path:Name or a Solidity identifier");
    }
    const matches = [...known].filter((name) => name.endsWith(`:${option}`));
    const [match, ...more] = matches;
    if (match !== undefined && more.length === 0) {
      return match;
    }
    if (match !== undefined) {
      throw incomplete(
        "contract",
        `The contract name matches ${String(matches.length)} contracts in the documents.`,
        CONTRACT_HINT,
        matches,
      );
    }
    if (known.size > 0) {
      throw invalid("contract", "matches no contract in the documents");
    }
    throw incomplete(
      "contract",
      "The documents list no contracts, so a bare contract name cannot be resolved.",
      "Pass options.contract as path:Name, with a path that is a key of the compiler input's sources.",
    );
  }
  const identities = [...findings.identities];
  const [identity, ...otherIdentities] = identities;
  if (identity !== undefined && otherIdentities.length === 0) {
    const name = qualify(identity, keys, findings);
    if (name === undefined) {
      throw invalid("contract", "comes from an artifact whose source is not in the compiler input");
    }
    return name;
  }
  const candidates = identities.length > 0 ? identities : [...known];
  const [only, ...rest] = candidates;
  if (only !== undefined && rest.length === 0) {
    return only;
  }
  throw incomplete(
    "contract",
    candidates.length > 0
      ? `The documents hold ${String(candidates.length)} contracts and none was chosen.`
      : "The documents name no contract.",
    CONTRACT_HINT,
    candidates,
  );
}

/** The options, checked; unknown fields are ignored. */
function readOptions(options: unknown): { contract?: string; compilerVersion?: string } {
  if (options === undefined) {
    return {};
  }
  const fields = readFields(options);
  if (fields === undefined) {
    throw invalid("options", "must be an object");
  }
  const result: { contract?: string; compilerVersion?: string } = {};
  for (const name of ["contract", "compilerVersion"] as const) {
    const value = fields.get(name);
    if (typeof value === "string") {
      result[name] = value;
    } else if (value !== undefined) {
      throw invalid(name, "must be a string");
    }
  }
  return result;
}

/** `value` as JSON text, to spot a document passed twice; `undefined` when it cannot be. */
function serialise(value: unknown): string | undefined {
  try {
    const text: unknown = JSON.stringify(value);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The documents as a new array, or `undefined` when they are not a readable array. */
function readDocuments(documents: unknown): unknown[] | undefined {
  try {
    return Array.isArray(documents) ? Array.from<unknown>(documents) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the `compiler` part of `VerifyInput` and the fully qualified contract name from compiler
 * JSON of unknown origin (R-IN-7), such as the files an SDK ships in its npm package. It takes
 * parsed objects, not paths, so it runs in a browser too.
 *
 * Each document is classified by its shape, never by a file name or a tool name:
 *
 * - build-info: an `input` with `language`, `sources` and `settings` (Hardhat 2, Hardhat 3,
 *   Foundry with `--build-info`);
 * - build-info stub: `source_id_to_path` and no `input` (Foundry without `--build-info`);
 * - build-info output: `output.contracts` and no `input` (Hardhat 3's `.output.json`);
 * - Solidity metadata: no `input`, and a top-level `compiler` or `output` object or a
 *   `settings.compilationTarget`;
 * - bare Standard JSON: `language`, `sources` and `settings` at the top level, none of the above;
 * - artifact with metadata: `metadata` or `rawMetadata` (Foundry);
 * - artifact with ABI and bytecode only (Hardhat 2 and 3).
 *
 * Metadata gives the version and the contract only next to a compiler input; rebuilding the input
 * from metadata alone arrives in #21. A document passed twice counts once. The build ids that
 * documents carry (a build-info's or output file's `id`, an artifact's `buildInfoId`) must all be
 * equal, and so must every full compiler version found.
 *
 * The compiler input returned holds only `language`, `sources` and `settings`; every other
 * top-level key is dropped, Foundry's `basePath`, `allowPaths`, `includePaths` and `version`
 * included. Each source keeps only `content`, and `keccak256` when present. A local path is
 * rejected, so none is published: an absolute, home, drive or file-URL path, or a `..` path that
 * climbs above the root, as a source path, on either side of a remapping, or as a key of
 * `settings.libraries` or `settings.outputSelection`. The version is the build-info's
 * `solcLongVersion` in its long form, else the `compiler.version` of any metadata, else
 * `options.compilerVersion`. The name is `options.contract`, else the one contract an artifact
 * points at, using Hardhat 3's `inputSourceName`, else the one contract the documents list. A
 * Hardhat 3 user source name, such as `contracts/Greeter.sol`, is mapped to its input source name
 * through `userSourceNameMap`. A bare Standard JSON input needs `options.contract` as `path:Name`.
 *
 * The order of `documents` does not change the result. The result is a deep copy that has passed
 * `validateInput`, so it shares no object with the documents. It sends nothing.
 *
 * @param documents - The parsed JSON documents of one build, in any order.
 * @param options - The contract and the full compiler version, when the documents lack them.
 * @returns The compiler part of `VerifyInput` and the contract name.
 * @throws ExplorerVerifyError `incomplete-input` naming the missing part in `details.field`
 *   (`input`, `compilerVersion` or `contract`, with `details.candidates` for an ambiguous name);
 *   `insufficient-artifact` for ABI and bytecode only; `unsupported-compiler` for a compiler other
 *   than solc; `invalid-input` for documents of no known shape, documents of different builds or
 *   versions, a path not in the sources, a local path, or an input that `validateInput` rejects.
 *   Messages never repeat a value or a path.
 * @example
 * ```ts
 * import { buildVerifyInput, validateInput } from "explorer-verify";
 *
 * // Parsed JSON files that an SDK ships, for example read with JSON.parse.
 * declare const buildInfo: unknown;
 * declare const artifact: unknown;
 *
 * const built = buildVerifyInput([buildInfo, artifact]);
 * // built.contractName: "project/contracts/Greeter.sol:Greeter" (Hardhat 3 input source name)
 *
 * const input = validateInput({
 *   chainId: 11155111,
 *   address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
 *   ...built,
 * });
 * ```
 * @experimental
 */
export function buildVerifyInput(
  documents: readonly unknown[],
  options?: BuildVerifyInputOptions,
): BuiltVerifyInput {
  const list = readDocuments(documents);
  if (list === undefined) {
    throw invalid("documents", "must be an array of parsed JSON documents");
  }
  if (list.length === 0) {
    throw invalid("documents", "must hold at least one document");
  }
  const { contract, compilerVersion } = readOptions(options);
  const findings = new Findings();
  // A document passed twice counts once.
  const seen = new Set<string>();
  list.forEach((document, index) => {
    const key = serialise(document);
    if (key !== undefined && seen.has(key)) {
      return;
    }
    if (key !== undefined) {
      seen.add(key);
    }
    classify(document, index + 1, findings);
  });
  if (findings.unknown.length > 0) {
    throw invalid("documents", `match no known shape at ${positions(findings.unknown)}`);
  }
  if (findings.unsupported !== undefined) {
    throw unsupportedCompiler(findings.unsupported);
  }
  if (findings.buildIds.size > 1) {
    throw invalid("documents", "come from different builds; pass the documents of one build");
  }
  const input = pickInput(findings);
  const language = input.get("language");
  if (typeof language === "string" && language !== "Solidity") {
    throw unsupportedCompiler("language");
  }
  const sourceFields = readFields(input.get("sources"));
  if (sourceFields === undefined) {
    throw invalid("compiler.input.sources", "must be an object of source files by path");
  }
  const settings = input.get("settings");
  checkRelativePaths(sourceFields, settings);
  const sources = copySources(sourceFields);
  const version = pickVersion(findings, compilerVersion);
  const keys = new Set(sourceFields.keys());
  const contractName = pickContract(findings, keys, contract);
  const checked = validateInput({
    chainId: PLACEHOLDER_CHAIN_ID,
    address: PLACEHOLDER_ADDRESS,
    compiler: { kind: "solc", version, input: { language, sources, settings } },
    contractName,
  });
  return { compiler: checked.compiler, contractName: checked.contractName };
}
