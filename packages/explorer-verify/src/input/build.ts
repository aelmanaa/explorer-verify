import { newError } from "../error-hints.ts";
// References: R-IN-7.
/**
 * The format-detecting input builder: turns compiler JSON of unknown origin into the
 * `compiler` part of `VerifyInput` and the fully qualified contract name.
 */
import { ExplorerVerifyError } from "../errors.ts";
import type { DetailsOf, InputIssue } from "../errors.ts";
import { ownKeys, unknownKeys } from "../internal/known-keys.ts";
import { readFields } from "../internal/read-fields.ts";
import type { Hex, VerifyInput } from "../types.ts";
import {
  checkSourceHashes,
  parseMetadata,
  readMetadata,
  rebuildInput,
  sourceFingerprint,
} from "./metadata.ts";
import type { RebuiltInput, SolidityMetadata } from "./metadata.ts";
import { isIndexedPath, isLocalPath } from "./paths.ts";
import { isCreationBytecode, validateInput, VYPER_STORAGE_HINT } from "./validate.ts";
import { rewriteVyperKey, rewriteVyperSearchPath, vyperLongVersion } from "./vyper.ts";

/**
 * Options for {@link buildVerifyInput}. Every field is optional, and a field set to `undefined`
 * counts as absent. Any other key throws `invalid-input` naming it and, when one is close, the
 * option it may mean.
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
  contract?: string | undefined;
  /**
   * The full compiler version, such as `0.8.24+commit.e11b9ed9`, or `0.4.3+commit.bff19ea2` for
   * Vyper. Used only when the documents hold no full version; when they do, it must be the same
   * version.
   */
  compilerVersion?: string | undefined;
  /**
   * Source contents by source path, as the Solidity metadata lists the paths, such as
   * `{ "src/Greeter.sol": "// SPDX-License-Identifier: MIT\n..." }`. Used only when the input is
   * rebuilt from metadata, for each source whose content the metadata does not embed. Each content
   * must hash to the metadata's `keccak256` for that path.
   */
  sources?: Readonly<Record<string, string>> | undefined;
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
  // References: R-IN-3.
  /**
   * The contract's compiled creation bytecode, when the documents hold it: `evm.bytecode.object`
   * of a build-info output, or an artifact's `bytecode`. Absent when they do not, or when they
   * hold different values for the contract. `verify()` uses it to derive missing constructor
   * arguments.
   */
  creationBytecode?: Hex;
}

const STANDARD_JSON_FIELDS = ["language", "sources", "settings"] as const;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_CANDIDATES = 20;
// The `_format` of a hardhat-zksync artifact.
const ZKSOLC_ARTIFACT_FORMAT = "hh-zksolc-artifact-1";
// The `_format` of a Hardhat 2 Vyper artifact (`@nomiclabs/hardhat-vyper`).
const VYPER_ARTIFACT_FORMAT = "hh-vyper-artifact-1";
// The fields of a contract's zksolc metadata that name the zksolc version.
const ZKSOLC_METADATA_FIELDS = ["zk_version", "zksolcVersion"] as const;
const MAX_POSITIONS = 5;
// The deepest nesting compared between two metadata documents, as validateInput allows.
const MAX_DEPTH = 64;
// The most missing source paths an error lists; the message gives the full count.
const MAX_MISSING = 1000;
// Stand-ins so validateInput checks the built part; they never leave this module.
const PLACEHOLDER_CHAIN_ID = 1;
const PLACEHOLDER_ADDRESS = `0x${"0".repeat(40)}`;

const STUB_HINT =
  "The build-info holds no compiler input. Rebuild with build-info enabled (forge build --build-info), then pass the new build-info file.";
const METADATA_ONLY_HINT =
  "Pass the build-info of the same build, or Solidity metadata with language, compiler.version, settings.compilationTarget and a keccak256 hash for each source.";
const SOURCES_HINT =
  "Pass each missing source file (details.candidates) in the sources (options.sources), keyed by its path, with its exact content, or pass the build-info of the same build.";
const METADATA_TARGET_HINT =
  "Pass the metadata of one contract: settings.compilationTarget must name exactly one contract.";
const OUTPUT_ONLY_HINT =
  "Pass the build-info that holds the compiler input, next to its output file or artifact.";
const VERSION_HINT =
  "Pass the full compiler version (options.compilerVersion), such as 0.8.24+commit.e11b9ed9, or add an artifact or build-info output that holds the contract metadata.";
const CONTRACT_HINT =
  "Pass the contract (options.contract) as path:Name, or as a Name that matches one of the candidates (details.candidates).";
const NO_CONTRACTS_HINT =
  "Pass the contract (options.contract) as path:Name, with a path that is a key of the compiler input's sources.";
const CONTRACT_PATH_HINT = "Pass the contract (options.contract) as path:Name.";
const ZKSOLC_HINT =
  "zksolc (EraVM) builds are not supported. A contract compiled with plain solc verifies with the solc build-info; a zksolc contract needs the ZKsync tooling.";
const ABSOLUTE_HINT =
  "Rebuild with source paths and remappings relative to the project root, so no local path is published.";
const VYPER_PATH_HINT =
  "Compile from the project root, so each path is relative to it. Only a module from a Python environment, under site-packages, is moved to its package path.";
const VYPER_ARTIFACT_HINT =
  "Pass the output of vyper -f solc_json for the contract, a Foundry build-info (build_info = true), or the Vyper Standard JSON input with the full compiler version (options.compilerVersion) and the contract (options.contract).";
const VYPER_COMMIT_HINT =
  "Pass the full Vyper version (options.compilerVersion) with the 8-character commit from the name of the Vyper release asset, such as 0.4.0+commit.e9db8d9f.";
const VYPER_VERSION_HINT =
  "Pass the full Vyper version (options.compilerVersion), such as 0.4.3+commit.bff19ea2, with the 8-character commit from the name of the Vyper release asset.";

/** What the documents hold, collected in one pass. */
class Findings {
  /** Standard JSON inputs, from build-info or bare. */
  readonly inputs: Map<string, unknown>[] = [];
  /** `solcLongVersion` values in the long form. */
  readonly longVersions = new Set<string>();
  /** Versions from contract metadata. */
  readonly metadataVersions = new Set<string>();
  /** `solcLongVersion` values without a commit, such as Foundry's `0.4.3` for Vyper. */
  readonly shortVersions = new Set<string>();
  /** `compiler_version` values of bare inputs, as `vyper -f solc_json` writes them. */
  readonly vyperVersions = new Set<string>();
  /** Whether a Hardhat 2 Vyper artifact was seen. */
  vyperArtifact = false;
  /** Fully qualified names listed in build-info output. */
  readonly listed = new Set<string>();
  /** Fully qualified names that artifacts or their metadata point at. */
  readonly identities = new Set<string>();
  /** Hardhat-style user source name to input source name. */
  readonly userSourceNames = new Map<string, string>();
  /** The field naming a compiler other than solc, when one was seen. */
  unsupported: string | undefined;
  /** The fields that marked a document as zksolc output. */
  readonly zksolc = new Set<string>();
  /** Build ids: a build-info's or output file's `id`, an artifact's `buildInfoId`. */
  readonly buildIds = new Set<string>();
  stub = false;
  /** Whether Solidity metadata was seen, in an artifact or on its own. */
  metadata = false;
  /** Metadata, in an artifact or on its own, complete enough to rebuild the input from. */
  readonly rebuildable: SolidityMetadata[] = [];
  /** Whether a build-info output without its input was seen. */
  output = false;
  // Stryker disable next-line BooleanLiteral: equivalent. Only artifacts and build-info outputs reach the check, and an output sets output, so the flag adds nothing; it stays as defence in depth.
  plainArtifact = false;
  /** 1-based positions of documents that match no shape. */
  readonly unknown: number[] = [];
  /** Creation bytecode by `path:Name` as the documents name it, without `0x`, in lower case. */
  readonly bytecodes = new Map<string, Set<string>>();
}

/** The fields of `value`, or none when it is not an object. */
function fieldsOf(value: unknown): Map<string, unknown> {
  return readFields(value) ?? new Map<string, unknown>();
}

/**
 * Records the creation bytecode of `name`: a string, or an object with an `object` string, as
 * Foundry writes it. Anything that is not bytecode `validateInput` accepts is ignored.
 */
function readBytecode(name: string, value: unknown, findings: Findings): void {
  const code = typeof value === "string" ? value : readFields(value)?.get("object");
  if (typeof code !== "string" || !isCreationBytecode(code)) {
    return;
  }
  // `isCreationBytecode` refuses an empty value, such as the `0x` of an abstract contract.
  // Stryker disable next-line MethodExpression,Regex: equivalent. Only one case for every value matters, and validateInput lowers it; the pattern allows 0x only at the start.
  const digits = code.replace(/^0x/, "").toLowerCase();
  const found = findings.bytecodes.get(name) ?? new Set<string>();
  found.add(digits);
  findings.bytecodes.set(name, found);
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
 * Records the version of one metadata value. With `target`, for metadata on its own or in an
 * artifact, also records its compilation target and keeps it for a rebuild when it is complete;
 * `bytecode`, the artifact's, is recorded as the target's creation bytecode.
 */
function readMetadataFacts(
  value: unknown,
  findings: Findings,
  target: boolean,
  bytecode?: unknown,
): void {
  const metadata = readMetadata(value);
  if (metadata === undefined) {
    return;
  }
  const complete = target ? parseMetadata(value) : undefined;
  if (complete !== undefined) {
    findings.rebuildable.push(complete);
  }
  const version = readFields(metadata.get("compiler"))?.get("version");
  if (typeof version === "string") {
    findings.metadataVersions.add(version);
  }
  if (!target) {
    return;
  }
  const settings = readFields(metadata.get("settings"));
  for (const [path, name] of fieldsOf(settings?.get("compilationTarget"))) {
    if (typeof name === "string") {
      findings.identities.add(`${path}:${name}`);
      readBytecode(`${path}:${name}`, bytecode, findings);
    }
  }
}

/** Lists the contracts of a build-info output and reads the version from their metadata. */
function readOutput(value: unknown, findings: Findings): void {
  for (const [path, byName] of fieldsOf(readFields(value)?.get("contracts"))) {
    for (const [name, entry] of fieldsOf(byName)) {
      findings.listed.add(`${path}:${name}`);
      const fields = readFields(entry);
      readMetadataFacts(fields?.get("metadata"), findings, false);
      readBytecode(
        `${path}:${name}`,
        readFields(readFields(fields?.get("evm"))?.get("bytecode"))?.get("object"),
        findings,
      );
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
      findings.shortVersions.add(longVersion);
    }
  }
  for (const [user, inputName] of fieldsOf(fields.get("userSourceNameMap"))) {
    // Stryker disable next-line ConditionalExpression: equivalent when always true. sourceKey finds a mapped name only when it is a source key, which a value that is not a string never is.
    if (typeof inputName === "string") {
      findings.userSourceNames.set(user, inputName);
    }
  }
  readOutput(fields.get("output"), findings);
}

function readArtifact(fields: Map<string, unknown>, findings: Findings): void {
  findings.plainArtifact = true;
  if (fields.get("_format") === VYPER_ARTIFACT_FORMAT) {
    findings.vyperArtifact = true;
  }
  readBuildId(fields.get("buildInfoId"), findings);
  const inputSourceName = fields.get("inputSourceName");
  const sourceName = fields.get("sourceName");
  const path = typeof inputSourceName === "string" ? inputSourceName : sourceName;
  const name = fields.get("contractName");
  if (typeof path === "string" && typeof name === "string") {
    findings.identities.add(`${path}:${name}`);
    readBytecode(`${path}:${name}`, fields.get("bytecode"), findings);
  }
}

/** The field of a contract's zksolc metadata that names the zksolc version, if any. */
function zksolcMetadataField(value: unknown): string | undefined {
  const metadata = readMetadata(value);
  return ZKSOLC_METADATA_FIELDS.find((name) => metadata?.has(name) === true);
}

/**
 * The field that marks a document as zksolc (EraVM) output, or `undefined` for none. zksolc
 * build documents share the solc shapes, so without this check they would be read as solc.
 */
function zksolcField(fields: Map<string, unknown>): string | undefined {
  if (fields.get("_format") === ZKSOLC_ARTIFACT_FORMAT) {
    return "_format";
  }
  for (const name of ["solcVersion", "solcLongVersion"]) {
    const version = fields.get(name);
    if (typeof version === "string" && version.startsWith("zkVM-")) {
      return name;
    }
  }
  if (readFields(fields.get("input"))?.has("zksolc_version") === true) {
    return "input.zksolc_version";
  }
  const output = readFields(fields.get("output"));
  if (output?.has("zk_version") === true) {
    return "output.zk_version";
  }
  if (readFields(output?.get("metadata"))?.has("zksolcVersion") === true) {
    return "output.metadata.zksolcVersion";
  }
  const own = zksolcMetadataField(fields.get("metadata"));
  if (own !== undefined) {
    return `metadata.${own}`;
  }
  for (const [, byName] of fieldsOf(output?.get("contracts"))) {
    for (const [, entry] of fieldsOf(byName)) {
      const found = zksolcMetadataField(readFields(entry)?.get("metadata"));
      if (found !== undefined) {
        return `metadata.${found}`;
      }
    }
  }
  return undefined;
}

/** Classifies one document by its shape and records what it holds. */
function classify(document: unknown, position: number, findings: Findings): void {
  if (typeof document === "string") {
    // A metadata JSON string, such as the `metadata` of a build-info output contract.
    const parsed = readMetadata(document);
    if (parsed !== undefined && !parsed.has("input") && hasMetadataShape(parsed)) {
      findings.metadata = true;
      readMetadataFacts(document, findings, true);
    } else {
      findings.unknown.push(position);
    }
    return;
  }
  const fields = readFields(document);
  if (fields === undefined) {
    findings.unknown.push(position);
    return;
  }
  const zksolc = zksolcField(fields);
  if (zksolc !== undefined) {
    findings.zksolc.add(zksolc);
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
    // `vyper -f solc_json` adds the version, such as v0.4.3+commit.bff19ea2.
    const version = fields.get("compiler_version");
    if (typeof version === "string") {
      findings.vyperVersions.add(version);
    }
  } else if (fields.has("metadata") || fields.has("rawMetadata")) {
    findings.metadata = true;
    readBuildId(fields.get("buildInfoId"), findings);
    // rawMetadata is the exact string solc wrote and the metadata object a parsed copy, so the
    // string is read first.
    const raw = fields.get("rawMetadata");
    const metadata = readMetadata(raw) === undefined ? fields.get("metadata") : raw;
    readMetadataFacts(metadata, findings, true, fields.get("bytecode"));
  } else if (fields.has("abi") && fields.has("bytecode")) {
    readArtifact(fields, findings);
  } else {
    findings.unknown.push(position);
  }
}

function invalid(field: string, message: string, hint?: string): ExplorerVerifyError {
  const issues: InputIssue[] = [{ field, message }];
  return newError({ code: "invalid-input", issues }, `The input is invalid: ${field}.`, {
    // Stryker disable next-line ConditionalExpression: equivalent when always false. An undefined hint takes the catalogue's hint, as an absent one does.
    ...(hint === undefined ? {} : { hint }),
    // Stryker disable next-line ArrayDeclaration: equivalent. The message and the issue name only a field, never a key.
    secrets: [],
  });
}

function incomplete(
  field: DetailsOf<"incomplete-input">["field"],
  message: string,
  hint: string,
  candidates: readonly string[] = [],
  limit = MAX_CANDIDATES,
): ExplorerVerifyError {
  return newError(
    {
      code: "incomplete-input",
      field,
      candidates: [...candidates].toSorted().slice(0, limit),
    },
    message,
    { hint, secrets: [] },
  );
}

function unsupportedCompiler(field: string, hint?: string): ExplorerVerifyError {
  return newError(
    { code: "unsupported-compiler", field },
    `The documents come from a compiler other than solc: ${field}.`,
    {
      // Stryker disable next-line ConditionalExpression: equivalent when always false. An undefined hint takes the catalogue's hint, as an absent one does.
      ...(hint === undefined ? {} : { hint }),
      // Stryker disable next-line ArrayDeclaration: equivalent. The message names only a field, never a key.
      secrets: [],
    },
  );
}

/**
 * `value` as JSON text with the keys of every object sorted, to compare two values whose key
 * order may differ.
 */
function canonical(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    // The caller reads any throw as "not JSON data", so the error needs no message.
    throw new RangeError();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonical(item, depth + 1)).join(",")}]`;
  }
  const fields = readFields(value);
  if (fields === undefined) {
    return JSON.stringify(value);
  }
  const keys = [...fields.keys()].toSorted();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonical(fields.get(key), depth + 1)}`,
  );
  return `{${entries.join(
    // Stryker disable next-line StringLiteral: equivalent. Each entry starts with a quoted key and ends with a whole JSON value, so the entries split one way without the comma.
    ",",
  )}}`;
}

/** Metadata documents that target one contract: the first one found and any others. */
interface MetadataGroup {
  first: SolidityMetadata;
  others: SolidityMetadata[];
}

/**
 * The metadata to rebuild from: the one contract the metadata documents target, or the one
 * `contract` names when they target several.
 */
function pickMetadata(findings: Findings, contract: string | undefined): MetadataGroup {
  const groups = new Map<string, MetadataGroup>();
  for (const metadata of findings.rebuildable) {
    const [target, ...more] = metadata.targets;
    if (target === undefined || more.length > 0) {
      throw invalid(
        "metadata.settings.compilationTarget",
        "must name exactly one contract",
        METADATA_TARGET_HINT,
      );
    }
    const group = groups.get(target);
    if (group === undefined) {
      groups.set(target, { first: metadata, others: [] });
    } else {
      group.others.push(metadata);
    }
  }
  const all = [...groups];
  // options.contract must name the metadata's own target: another contract may come from
  // another build.
  const matching =
    contract === undefined
      ? all
      : all.filter(([target]) =>
          contract.includes(":") ? target === contract : target.endsWith(`:${contract}`),
        );
  const [chosen, ...rest] = matching;
  if (chosen === undefined) {
    throw invalid("contract", "matches no contract in the documents");
  }
  if (rest.length > 0) {
    throw incomplete(
      "contract",
      `The documents hold Solidity metadata of ${String(matching.length)} contracts and none was chosen.`,
      CONTRACT_HINT,
      matching.map(([target]) => target),
    );
  }
  return chosen[1];
}

/**
 * The Standard JSON input rebuilt from the chosen metadata and `provided` sources. Metadata
 * documents that target the same contract must rebuild to the same input.
 */
function rebuildFromMetadata(
  findings: Findings,
  contract: string | undefined,
  provided: ReadonlyMap<string, string>,
): RebuiltInput {
  const { first, others } = pickMetadata(findings, contract);
  const rebuilt = rebuildInput(first, provided);
  if (others.length === 0) {
    return rebuilt;
  }
  // Every document must list the same sources with the same hashes, so the one that is checked
  // does not depend on the order of the documents.
  const fingerprint = sourceFingerprint(first);
  if (others.some((other) => sourceFingerprint(other) !== fingerprint)) {
    throw invalid("documents", "come from different builds; pass the documents of one build");
  }
  let same: boolean;
  try {
    const expected = canonical(rebuilt.input, 0);
    same = others.every((other) => canonical(rebuildInput(other, provided).input, 0) === expected);
  } catch (error) {
    // An ExplorerVerifyError from rebuildInput is the caller's answer; any other throw comes from
    // a value that is not JSON data, and its text may hold a caller value, so it is dropped.
    if (error instanceof ExplorerVerifyError) {
      throw error;
    }
    throw invalid("documents", "hold Solidity metadata that is not JSON data");
  }
  if (!same) {
    throw invalid(
      "documents",
      "hold different Solidity metadata for one contract; pass the documents of one build",
    );
  }
  return rebuilt;
}

/** The compiler input, and the rebuild it came from when it was rebuilt from metadata. */
interface PickedInput {
  input: Map<string, unknown>;
  rebuilt: RebuiltInput | undefined;
}

/**
 * The one compiler input, else the input rebuilt from Solidity metadata, else the error that
 * explains why there is none.
 */
function pickInput(
  findings: Findings,
  contract: string | undefined,
  provided: ReadonlyMap<string, string>,
): PickedInput {
  const [input, ...others] = findings.inputs;
  if (others.length > 0) {
    throw invalid(
      "documents",
      "hold more than one compiler input; pass the documents of one build",
    );
  }
  if (input !== undefined) {
    return { input, rebuilt: undefined };
  }
  if (findings.rebuildable.length > 0) {
    const rebuilt = rebuildFromMetadata(findings, contract, provided);
    return { input: new Map<string, unknown>(Object.entries(rebuilt.input)), rebuilt };
  }
  if (findings.stub) {
    throw incomplete(
      // Stryker disable next-line StringLiteral: equivalent. The error maps a field outside its list to "input", its first entry.
      "input",
      "The documents hold no compiler input: the build-info was written without it.",
      STUB_HINT,
    );
  }
  if (findings.metadata) {
    throw incomplete(
      // Stryker disable next-line StringLiteral: equivalent. The error maps a field outside its list to "input", its first entry.
      "input",
      "The documents hold no compiler input: only Solidity metadata.",
      METADATA_ONLY_HINT,
    );
  }
  if (findings.vyperArtifact) {
    throw newError(
      // Stryker disable next-line StringLiteral: equivalent. The error maps a field outside its list to "input", its first entry.
      { code: "insufficient-artifact", field: "input" },
      "The documents hold no compiler input or settings: a Hardhat 2 Vyper artifact holds only ABI and bytecode.",
      // Stryker disable next-line ArrayDeclaration: equivalent. The message is fixed text.
      { hint: VYPER_ARTIFACT_HINT, secrets: [] },
    );
  }
  if (findings.plainArtifact && !findings.output) {
    throw newError(
      // Stryker disable next-line StringLiteral: equivalent. The error maps a field outside its list to "input", its first entry.
      { code: "insufficient-artifact", field: "input" },
      "The documents hold no compiler input or settings: only ABI and bytecode.",
      // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent. The message is fixed text.
      { secrets: [] },
    );
  }
  // Stryker disable next-line StringLiteral: equivalent. The error maps a field outside its list to "input", its first entry.
  throw incomplete("input", "The documents hold no compiler input.", OUTPUT_ONLY_HINT);
}

/** Throws when any entry of `local` is true, naming `field` and the positions, never a path. */
function rejectLocal(local: readonly boolean[], field: string): void {
  const at = local.flatMap((isLocal, index) => (isLocal ? [index + 1] : []));
  if (at.length > 0) {
    throw invalid(field, `has a local path at ${positions(at)}`, ABSOLUTE_HINT);
  }
}

/** Every part of a remapping `context:prefix=target` that names a path, and the whole left side. */
function remappingParts(remapping: unknown): string[] {
  if (typeof remapping !== "string") {
    // Stryker disable next-line ArrayDeclaration: equivalent. The caller only asks whether a part is a local path, and Stryker's text is not one.
    return [];
  }
  const equals = remapping.indexOf("=");
  const left = equals === -1 ? remapping : remapping.slice(0, equals);
  // Without =, this is the whole remapping, which is also the left side.
  const target = remapping.slice(equals + 1);
  const colon = left.indexOf(":");
  return colon === -1
    ? [left, target]
    : [left, left.slice(0, colon), left.slice(colon + 1), target];
}

/**
 * `value` copied into a new array when it is an array, else `[]`. A Proxy whose traps throw gives
 * `invalid-input` on `field`; its own error text, which may hold a caller value, is dropped.
 */
function readList(value: unknown, field: string): unknown[] {
  try {
    // Stryker disable next-line ArrayDeclaration: equivalent. The caller only asks whether an entry holds a local path, and Stryker's text does not.
    return Array.isArray(value) ? Array.from<unknown>(value) : [];
  } catch {
    throw invalid(field, "could not be read as an array");
  }
}

/**
 * Rejects a source path, either side of a remapping, or a `libraries` or `outputSelection` key
 * that is a local path, so no path on the build machine is published.
 */
function checkRelativePaths(sources: Map<string, unknown>, settings: unknown): void {
  rejectLocal([...sources.keys()].map(isLocalPath), "compiler.input.sources");
  const fields = readFields(settings);
  const list = readList(fields?.get("remappings"), "compiler.input.settings.remappings");
  rejectLocal(
    list.map((remapping) => remappingParts(remapping).some(isLocalPath)),
    "compiler.input.settings.remappings",
  );
  for (const name of ["libraries", "outputSelection"]) {
    rejectLocal(
      [...fieldsOf(fields?.get(name)).keys()].map(isLocalPath),
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
      findings.shortVersions.size > 0
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
      NO_CONTRACTS_HINT,
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
    candidates.length > 0 ? CONTRACT_HINT : CONTRACT_PATH_HINT,
    // An artifact's own source name may be a path on the build machine: such a name is not listed.
    candidates.filter((name) => !isLocalPath(name) && !isIndexedPath(name)),
  );
}

/**
 * The creation bytecode the documents hold for `contractName`, or `undefined` when they hold none
 * or more than one value for it.
 */
function bytecodeOf(
  findings: Findings,
  keys: ReadonlySet<string>,
  contractName: string,
): string | undefined {
  const values = new Set<string>();
  for (const [name, found] of findings.bytecodes) {
    if (qualify(name, keys, findings) === contractName) {
      for (const value of found) {
        values.add(value);
      }
    }
  }
  const [only, ...more] = values;
  return more.length === 0 ? only : undefined;
}

/** `options.sources` as a map, checked: an object whose every value is a string. */
function readSourcesOption(value: unknown): Map<string, string> {
  const sources = new Map<string, string>();
  if (value === undefined) {
    return sources;
  }
  const fields = readFields(value);
  if (fields === undefined) {
    throw invalid("sources", "must be an object of source contents by path");
  }
  for (const [path, content] of fields) {
    if (typeof content !== "string") {
      throw invalid("sources", "must map each path to the source content as a string");
    }
    sources.set(path, content);
  }
  return sources;
}

/** The checked options. */
interface ReadOptions {
  contract?: string;
  compilerVersion?: string;
  sources: Map<string, string>;
}

const BUILD_OPTIONS_HINT = "Pass only contract, compilerVersion and sources as options.";

/** The keys of {@link BuildVerifyInputOptions}, in documentation order. */
function buildOptionKeys(): readonly string[] {
  return Object.keys({
    contract: null,
    compilerVersion: null,
    sources: null,
  } satisfies Record<keyof BuildVerifyInputOptions, null>);
}

// References: R-IN-6.
/** The options, checked. An unknown key throws `invalid-input` naming it. */
function readOptions(options: unknown): ReadOptions {
  if (options === undefined) {
    return { sources: new Map() };
  }
  // The keys first, so a getter on an unknown key never runs (R-IN-6).
  const keys = ownKeys(options);
  const unknown = unknownKeys(keys ?? [], buildOptionKeys(), "", "options");
  if (unknown.length > 0) {
    throw newError(
      { code: "invalid-input", issues: unknown },
      `The input is invalid: ${unknown.map((issue) => issue.field).join(", ")}.`,
      // Stryker disable next-line ArrayDeclaration: untestable sentinel. The message names only option keys that pass the name pattern, which Stryker's placeholder text does not.
      { hint: BUILD_OPTIONS_HINT, secrets: [] },
    );
  }
  // Stryker disable next-line ConditionalExpression: equivalent when always false. readFields gives undefined for every value whose keys cannot be listed.
  const fields = keys === undefined ? undefined : readFields(options);
  if (fields === undefined) {
    throw invalid("options", "must be an object");
  }
  const result: ReadOptions = { sources: readSourcesOption(fields.get("sources")) };
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
    // JSON.stringify gives undefined for undefined, a function or a symbol.
    const text: string | undefined = JSON.stringify(value);
    return text;
  } catch {
    // A cycle, a BigInt or a throwing toJSON(): no text.
  }
  return undefined;
}

/** The documents as a new array, or `undefined` when they are not a readable array. */
function readDocuments(documents: unknown): unknown[] | undefined {
  try {
    return Array.isArray(documents) ? Array.from<unknown>(documents) : undefined;
  } catch {
    // A Proxy trap threw: not a readable array.
  }
  return undefined;
}

/** Throws `invalid-input` on `field` when `at` lists any position, never naming a path. */
function rejectVyperPaths(at: readonly number[], field: string): void {
  if (at.length > 0) {
    throw invalid(field, `has a local path at ${positions(at)}`, VYPER_PATH_HINT);
  }
}

// References: R-IN-7, decisions 0075 and 0076.
/**
 * The entries of `files` under their rewritten keys (see `rewriteVyperKey`), each renamed key
 * recorded in `renamed`. Throws `invalid-input` on `field`, naming positions only, for a key that
 * cannot be rewritten, or for two keys that become one.
 */
function rewriteVyperFiles(
  files: Map<string, unknown>,
  field: string,
  renamed = new Map<string, string>(),
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const local: number[] = [];
  const twice: number[] = [];
  let position = 0;
  for (const [path, entry] of files) {
    position++;
    const key = rewriteVyperKey(path);
    if (key === undefined) {
      local.push(position);
    } else if (result.has(key)) {
      twice.push(position);
    } else {
      result.set(key, entry);
      renamed.set(path, key);
    }
  }
  rejectVyperPaths(local, field);
  if (twice.length > 0) {
    throw invalid(field, `names one file twice at ${positions(twice)}`, VYPER_PATH_HINT);
  }
  return result;
}

/**
 * `settings.search_paths` with each entry rewritten (see `rewriteVyperSearchPath`) and each
 * repeated entry dropped. An entry that is not a string is kept, so `validateInput` reports it.
 */
function rewriteSearchPaths(value: unknown): unknown[] {
  const field = "compiler.input.settings.search_paths";
  const result: unknown[] = [];
  const local: number[] = [];
  readList(value, field).forEach((entry, index) => {
    const path = typeof entry === "string" ? rewriteVyperSearchPath(entry) : entry;
    if (typeof entry === "string" && path === undefined) {
      local.push(index + 1);
    } else if (!result.includes(path)) {
      result.push(path);
    }
  });
  rejectVyperPaths(local, field);
  return result;
}

/**
 * One interface cut down to `content`, or to `abi` when it has no `content`. An entry that is not
 * an object is kept as it is, so `validateInput` reports it.
 */
function copyInterface(entry: unknown): unknown {
  const fields = readFields(entry);
  if (fields === undefined) {
    return entry;
  }
  return fields.has("content") || !fields.has("abi")
    ? { content: fields.get("content") }
    : { abi: fields.get("abi") };
}

/** Each interface cut down by {@link copyInterface}. */
function copyInterfaces(interfaces: Map<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...interfaces].map(([path, entry]) => [path, copyInterface(entry)]));
}

/**
 * Whether `partial`, a Vyper version as `x.y.z` or with a 7- or 8-character commit, names the
 * same release as `full`.
 */
function sameVyperRelease(partial: string, full: string): boolean {
  const given = bare(partial);
  return `${bare(full)}+`.startsWith(given.includes("+") ? given : `${given}+`);
}

/** The message for a Vyper version that the release table cannot complete. */
function partialVersionMessage(where: string, version: string): string {
  const what = version.includes("+")
    ? "a Vyper version with a 7-character commit"
    : "only the short Vyper version";
  return `${where} ${what}, and this version of explorer-verify lists no commit for that Vyper version.`;
}

/**
 * The Vyper version: the input's version (`compiler_version`, or a build-info's
 * `solcLongVersion`), else `option`. A version as `x.y.z` or with a 7-character commit is
 * completed from the release table (see `vyperLongVersion`). The documents hold one input, so at
 * most one version.
 */
function pickVyperVersion(findings: Findings, option: string | undefined): string {
  const [raw] = [...findings.longVersions, ...findings.vyperVersions, ...findings.shortVersions];
  // Stryker disable next-line ConditionalExpression: equivalent. vyperLongVersion reads undefined as the text "undefined", which it returns unchanged: undefined again.
  const found = raw === undefined ? undefined : vyperLongVersion(raw);
  if (found === null) {
    throw invalid(
      "documents",
      "hold a Vyper version whose 7-character commit is not the commit of that release",
      VYPER_COMMIT_HINT,
    );
  }
  // Stryker disable next-line ConditionalExpression: equivalent. vyperLongVersion reads undefined as the text "undefined", which it returns unchanged: undefined again.
  const given = option === undefined ? undefined : vyperLongVersion(option);
  if (given === null) {
    throw invalid(
      "compilerVersion",
      "has a 7-character commit that is not the commit of that Vyper release",
      VYPER_COMMIT_HINT,
    );
  }
  if (found !== undefined) {
    if (option !== undefined && !sameVyperRelease(option, found)) {
      throw invalid("compilerVersion", "differs from the compiler version in the documents");
    }
    return bare(found);
  }
  if (given === undefined) {
    throw incomplete(
      "compilerVersion",
      raw !== undefined
        ? partialVersionMessage("The documents hold", raw)
        : option !== undefined
          ? partialVersionMessage("The compiler version passed is", option)
          : "The documents hold no compiler version.",
      VYPER_VERSION_HINT,
    );
  }
  if (raw !== undefined && !sameVyperRelease(raw, given)) {
    throw invalid("compilerVersion", "differs from the compiler version in the documents");
  }
  return given;
}

/** The built parts, before `validateInput` checks them. */
interface BuiltParts {
  compiler: { kind: "solc" | "vyper"; version: string; input: Record<string, unknown> };
  contractName: string;
  // validateInput reads an undefined creationBytecode as an absent one.
  creationBytecode: string | undefined;
}

/**
 * The parts of a Vyper build: the input with only `language`, `sources`, `interfaces` and
 * `settings`, the keys of a module from a Python environment rewritten, the version and the
 * contract name.
 */
function buildVyper(
  input: Map<string, unknown>,
  findings: Findings,
  contract: string | undefined,
  compilerVersion: string | undefined,
): BuiltParts {
  // `vyper -f solc_json --storage-layout-file` writes it, and the compiler reads it: dropping it
  // would give other bytecode.
  if (input.has("storage_layout_overrides")) {
    throw invalid(
      "compiler.input.storage_layout_overrides",
      "is not supported",
      VYPER_STORAGE_HINT,
    );
  }
  const sourceFields = readFields(input.get("sources"));
  if (sourceFields === undefined) {
    throw invalid("compiler.input.sources", "must be an object of source files by path");
  }
  const renamed = new Map<string, string>();
  const sourceMap = rewriteVyperFiles(sourceFields, "compiler.input.sources", renamed);
  // An interfaces or settings value that is not an object is kept, so validateInput reports it.
  const rawInterfaces = input.get("interfaces");
  const interfaceFields = readFields(rawInterfaces);
  const interfaces =
    interfaceFields === undefined
      ? rawInterfaces
      : copyInterfaces(rewriteVyperFiles(interfaceFields, "compiler.input.interfaces"));
  const rawSettings = input.get("settings");
  const settingsFields = readFields(rawSettings);
  let targets = new Map<string, unknown>();
  if (settingsFields !== undefined) {
    const selection = readFields(settingsFields.get("outputSelection"));
    if (selection !== undefined) {
      targets = rewriteVyperFiles(selection, "compiler.input.settings.outputSelection");
      settingsFields.set("outputSelection", Object.fromEntries(targets));
    }
    const search = settingsFields.get("search_paths");
    if (Array.isArray(search)) {
      settingsFields.set("search_paths", rewriteSearchPaths(search));
    }
  }
  const settings = settingsFields === undefined ? rawSettings : Object.fromEntries(settingsFields);
  const version = pickVyperVersion(findings, compilerVersion);
  const keys = new Set(sourceMap.keys());
  for (const [from, to] of renamed) {
    findings.userSourceNames.set(from, to);
  }
  // A Vyper contract is named after its file, so each `.vy` target of outputSelection names one.
  for (const target of targets.keys()) {
    const file = target.slice(Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1);
    if (keys.has(target) && file.endsWith(".vy")) {
      findings.listed.add(`${target}:${file.slice(0, -".vy".length)}`);
    }
  }
  const contractName = pickContract(findings, keys, contract);
  return {
    compiler: {
      kind: "vyper",
      version,
      input: {
        language: "Vyper",
        sources: copySources(sourceMap),
        // validateInput drops an interfaces key whose value is undefined.
        interfaces,
        settings,
      },
    },
    contractName,
    creationBytecode: bytecodeOf(findings, keys, contractName),
  };
}

// References: R-IN-7.
/**
 * Builds the `compiler` part of `VerifyInput` and the fully qualified contract name from compiler
 * JSON of unknown origin, such as the files an SDK ships in its npm package. It takes
 * parsed objects, not paths, so it runs in a browser too.
 *
 * Each document is classified by its shape, never by a file name or a tool name:
 *
 * - build-info: an `input` with `language`, `sources` and `settings` (Hardhat 2, Hardhat 3,
 *   Foundry with `--build-info`);
 * - build-info stub: `source_id_to_path` and no `input` (Foundry without `--build-info`);
 * - build-info output: `output.contracts` and no `input` (Hardhat 3's `.output.json`);
 * - Solidity metadata, as an object or a JSON string: no `input`, and a top-level `compiler` or
 *   `output` object or a `settings.compilationTarget`;
 * - bare Standard JSON: `language`, `sources` and `settings` at the top level, none of the above;
 * - artifact with metadata: `metadata` or `rawMetadata` (Foundry); `rawMetadata` is read first;
 * - artifact with ABI and bytecode only (Hardhat 2 and 3).
 *
 * Next to a compiler input, metadata gives the version and the contract. Without one, the input is
 * rebuilt from metadata that has `language`, `compiler.version`, `settings.compilationTarget` with
 * exactly one entry, and a `keccak256` for each source. `language` comes from the metadata;
 * `settings` copies every metadata setting except `compilationTarget`, turns `libraries` from
 * `{ "path:Name": address }` into `{ path: { Name: address } }` (a bare `Name`, from solc 0.7.4 and
 * earlier, goes under the empty path) and adds an `outputSelection` for the ABI, the bytecode and
 * the metadata. Three settings change so solc accepts the input: with `metadata.appendCBOR: false`,
 * `metadata.bytecodeHash` is dropped; for solc 0.8.2 to 0.8.4, `optimizer.details.inliner` becomes
 * `optimizer.enabled`; when a source embeds its content and `metadata.useLiteralContent` is unset
 * (solc 0.5.0 and earlier), it is set to `true`. Each source takes the metadata's `content` when
 * present, else `options.sources[path]`: embedded content wins. Before returning, each source's
 * UTF-8 bytes are hashed with keccak-256 and compared with the metadata. When metadata of several
 * contracts is passed, `options.contract` picks one; in a rebuild, `options.contract` must name the
 * metadata's own target. Metadata documents for one contract must list the same sources and
 * hashes. A document passed twice counts once. The build ids that documents
 * carry (a build-info's or output file's `id`, an artifact's `buildInfoId`) must all be equal, and
 * so must every full compiler version found.
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
 * A compiler input with `language: "Vyper"` (a bare Vyper Standard JSON, the output of
 * `vyper -f solc_json`, or a Foundry Vyper build-info) gives `compiler.kind: "vyper"`. Its input
 * holds only `language`, `sources`, `interfaces` and `settings`: `compiler_version` and
 * `integrity` are dropped, each source keeps only `content` and `keccak256`, and each interface
 * only `content`, or `abi` when it has no `content`. An input with `storage_layout_overrides`
 * throws `invalid-input`. `vyper -f solc_json` keys a module found in a Python environment by the
 * environment's path: after an index run, such as
 * `0/1/2/home/user/.venv/lib/python3.12/site-packages/snekmate/auth/ownable.vy`, or relative to a
 * project-local `.venv`. Such a key becomes the path after its last `site-packages/`
 * (`snekmate/auth/ownable.vy`), in `sources`, `interfaces` and `settings.outputSelection`, and a
 * `settings.search_paths` entry that ends in `site-packages` becomes `.`. Any other indexed,
 * absolute or climbing path is rejected, with `.`, empty and `name/..` segments read as the
 * compiler reads them. The version is `compiler_version` without its `v`, else the build-info's
 * `solcLongVersion`, else `options.compilerVersion`. Foundry writes `solcLongVersion` without a
 * commit, such as `0.4.3`; a table of the stable releases from 0.3.10 turns it into
 * `0.4.3+commit.bff19ea2`. The table also completes the 7-character commit that the PyPI wheels
 * print, such as `0.4.0+commit.e9db8d9`. The name is `options.contract`, else the one contract an
 * artifact points at, else the one `.vy` target of `settings.outputSelection` or of the
 * build-info output, named after its file. A Hardhat 2 Vyper artifact on its own holds no input
 * and throws `insufficient-artifact`. No backend verifies Vyper yet: `verify()` refuses a
 * `kind: "vyper"` input with `unsupported-compiler`.
 *
 * The order of `documents` does not change the result. The result is a deep copy that has passed
 * `validateInput`, so it shares no object with the documents. It sends nothing.
 *
 * @param documents - The parsed JSON documents of one build, in any order.
 * @param options - The contract and the full compiler version, when the documents lack them, and
 *   the source files that Solidity metadata lists without their content.
 * @returns The compiler part of `VerifyInput` and the contract name.
 * @throws ExplorerVerifyError `incomplete-input` naming the missing part in `details.field`
 *   (`input`, `compilerVersion`, `contract` with `details.candidates` for an ambiguous name, or
 *   `sources` with every missing source path in `details.candidates`); `source-mismatch` for a
 *   source whose keccak-256 differs from the metadata, with the path and both hashes in `details`;
 *   `insufficient-artifact` for ABI and bytecode only; `unsupported-compiler` for a compiler other
 *   than solc or Vyper, zksolc (EraVM) included; `invalid-input` for documents of no known shape,
 *   documents of different builds or versions, metadata whose `compilationTarget` does not name
 *   exactly one contract, a path not in the sources, a local path, Vyper storage layout
 *   overrides, or an input that `validateInput` rejects. Messages never repeat a value or a path.
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
 *   address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",...built,
 * });
 *
 * // A Foundry artifact holds the metadata; the source files come next to it.
 * declare const foundryArtifact: unknown;
 * declare const greeterSol: string;
 * declare const baseSol: string;
 *
 * const rebuilt = buildVerifyInput([foundryArtifact], {
 *   sources: { "src/Greeter.sol": greeterSol, "src/Base.sol": baseSol },
 * });
 * // rebuilt.contractName: "src/Greeter.sol:Greeter", from settings.compilationTarget
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
  const { contract, compilerVersion, sources: provided } = readOptions(options);
  const findings = new Findings();
  // A document passed twice counts once.
  const seen = new Set<string>();
  list.forEach((document, index) => {
    const key = serialise(document);
    if (key !== undefined) {
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
    }
    classify(document, index + 1, findings);
  });
  if (findings.unknown.length > 0) {
    throw invalid("documents", `match no known shape at ${positions(findings.unknown)}`);
  }
  // Sorted, so the order of the documents does not change the field named.
  const [zksolc] = [...findings.zksolc].toSorted();
  if (zksolc !== undefined) {
    throw unsupportedCompiler(zksolc, ZKSOLC_HINT);
  }
  if (findings.unsupported !== undefined) {
    throw unsupportedCompiler(findings.unsupported);
  }
  if (findings.buildIds.size > 1) {
    throw invalid("documents", "come from different builds; pass the documents of one build");
  }
  const { input, rebuilt } = pickInput(findings, contract, provided);
  const language = input.get("language");
  if (language === "Vyper" && rebuilt === undefined) {
    return checkBuilt(buildVyper(input, findings, contract, compilerVersion));
  }
  if (typeof language === "string" && language !== "Solidity") {
    throw unsupportedCompiler("language");
  }
  const sourceFields = readFields(input.get("sources"));
  if (sourceFields === undefined) {
    throw invalid("compiler.input.sources", "must be an object of source files by path");
  }
  const settings = input.get("settings");
  // A rebuild checks every path the metadata lists, the missing ones too, before any is named.
  checkRelativePaths(
    rebuilt === undefined ? sourceFields : new Map(rebuilt.paths.map((path) => [path, path])),
    settings,
  );
  if (rebuilt !== undefined) {
    if (rebuilt.missing.length > 0) {
      throw incomplete(
        "sources",
        `The documents and options.sources lack ${String(rebuilt.missing.length)} of the source files the Solidity metadata lists.`,
        SOURCES_HINT,
        rebuilt.missing,
        MAX_MISSING,
      );
    }
    checkSourceHashes(rebuilt.supplied);
  }
  const sources = copySources(sourceFields);
  const version = pickVersion(findings, compilerVersion);
  const keys = new Set(sourceFields.keys());
  const contractName = pickContract(findings, keys, contract);
  return checkBuilt({
    compiler: { kind: "solc", version, input: { language, sources, settings } },
    contractName,
    creationBytecode: bytecodeOf(findings, keys, contractName),
  });
}

/**
 * The built parts, checked by `validateInput` and deep-copied, with `creationBytecode` only when
 * the documents hold it.
 */
function checkBuilt(parts: BuiltParts): BuiltVerifyInput {
  const checked = validateInput({
    chainId: PLACEHOLDER_CHAIN_ID,
    address: PLACEHOLDER_ADDRESS,
    ...parts,
  });
  const built: BuiltVerifyInput = {
    compiler: checked.compiler,
    contractName: checked.contractName,
  };
  if (checked.creationBytecode !== undefined) {
    built.creationBytecode = checked.creationBytecode;
  }
  return built;
}
