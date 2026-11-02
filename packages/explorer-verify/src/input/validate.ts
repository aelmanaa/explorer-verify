import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import type { Hex, SolidityStandardJsonInput, VerifyInput } from "../types.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Group 1 is the version without the optional `v`. Nightly builds carry `-nightly.YYYY.M.D`.
const VERSION =
  /^v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-nightly\.\d{4}\.\d{1,2}\.\d{1,2})?\+commit\.[0-9a-f]{8})$/;
const SHORT_VERSION = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_POSITIONS = 5;

const SHORT_VERSION_HINT =
  "Pass the full compiler version with its commit, such as 0.8.24+commit.e11b9ed9.";
const KIND_HINT = 'Set compiler.kind to "solc", the only supported compiler kind.';

/**
 * Own enumerable fields of `value`, read once. `undefined` when `value` is not a non-array object
 * or when reading it throws, as a hostile Proxy or getter does.
 */
function readFields(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    if (Array.isArray(value)) {
      return undefined;
    }
    return new Map<string, unknown>(Object.entries(value));
  } catch {
    return undefined;
  }
}

/** Collects the issues found so far and the specific hints that go with some of them. */
class Problems {
  readonly issues: InputIssue[] = [];
  readonly hints: string[] = [];

  add(field: string, message: string, hint?: string): undefined {
    this.issues.push({ field, message });
    if (hint !== undefined) {
      this.hints.push(hint);
    }
    return undefined;
  }
}

function checkChainId(value: unknown, problems: Problems): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : problems.add("chainId", "must be a positive integer");
}

function checkAddress(value: unknown, problems: Problems): Hex | undefined {
  return typeof value === "string" && ADDRESS.test(value)
    ? `0x${value.slice(2).toLowerCase()}`
    : problems.add("address", "must be 0x followed by 40 hex digits");
}

function checkKind(value: unknown, problems: Problems): "solc" | undefined {
  return value === "solc"
    ? value
    : problems.add("compiler.kind", 'must be "solc", the only supported kind', KIND_HINT);
}

function checkVersion(value: unknown, problems: Problems): string | undefined {
  const version = typeof value === "string" ? VERSION.exec(value)?.[1] : undefined;
  if (version !== undefined) {
    return version;
  }
  if (typeof value === "string" && SHORT_VERSION.test(value)) {
    return problems.add(
      "compiler.version",
      "is a short version; pass the full version with its commit, such as 0.8.24+commit.e11b9ed9",
      SHORT_VERSION_HINT,
    );
  }
  return problems.add(
    "compiler.version",
    "must be a full solc version, such as 0.8.24+commit.e11b9ed9",
  );
}

function checkLanguage(value: unknown, problems: Problems): "Solidity" | undefined {
  return value === "Solidity"
    ? value
    : problems.add("compiler.input.language", 'must be "Solidity"');
}

/**
 * The sources, copied entry by entry with every field kept, and every source path. `undefined`
 * when the sources are not an object or are empty. Entries without a string `content` are
 * reported by position, never by path: the input chose the paths. `sources` is `undefined` when
 * any entry is bad, while `paths` still lets `contractName` be checked.
 */
function checkSources(
  value: unknown,
  problems: Problems,
): { sources?: SolidityStandardJsonInput["sources"]; paths: ReadonlySet<string> } | undefined {
  const field = "compiler.input.sources";
  const entries = readFields(value);
  if (entries === undefined) {
    return problems.add(field, "must be an object of source files by path");
  }
  if (entries.size === 0) {
    return problems.add(field, "must hold at least one source file");
  }
  const good: [string, { content: string }][] = [];
  const bad: number[] = [];
  let position = 0;
  for (const [path, entry] of entries) {
    position++;
    const fields = readFields(entry);
    const content = fields?.get("content");
    if (fields === undefined || typeof content !== "string") {
      bad.push(position);
    } else {
      good.push([path, { ...Object.fromEntries(fields), content }]);
    }
  }
  const paths = new Set(entries.keys());
  if (bad.length > 0) {
    const shown = bad.slice(0, MAX_POSITIONS).join(", ");
    const more = bad.length > MAX_POSITIONS ? " and more" : "";
    const [files, positions] = bad.length === 1 ? ["file", "position"] : ["files", "positions"];
    problems.add(
      field,
      `has ${String(bad.length)} ${files} without a string content, at ${positions} ${shown}${more}`,
    );
    return { paths };
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return { sources: Object.fromEntries(good), paths };
}

function checkSettings(value: unknown, problems: Problems): Record<string, unknown> | undefined {
  const fields = readFields(value);
  return fields === undefined
    ? problems.add("compiler.input.settings", "must be an object")
    : Object.fromEntries(fields);
}

/** A checked value, `undefined` when invalid, and the source paths when the sources were read. */
interface WithPaths<T> {
  value: T | undefined;
  paths: ReadonlySet<string> | undefined;
}

/** The Standard JSON input, copied with every field kept. */
function checkStandardJson(
  value: unknown,
  problems: Problems,
): WithPaths<SolidityStandardJsonInput> {
  const fields = readFields(value);
  if (fields === undefined) {
    problems.add("compiler.input", "must be the Standard JSON input object");
    return { value: undefined, paths: undefined };
  }
  const language = checkLanguage(fields.get("language"), problems);
  const checked = checkSources(fields.get("sources"), problems);
  const settings = checkSettings(fields.get("settings"), problems);
  const sources = checked?.sources;
  const paths = checked?.paths;
  if (language === undefined || sources === undefined || settings === undefined) {
    return { value: undefined, paths };
  }
  return { value: { ...Object.fromEntries(fields), language, sources, settings }, paths };
}

function checkCompiler(value: unknown, problems: Problems): WithPaths<VerifyInput["compiler"]> {
  const fields = readFields(value);
  if (fields === undefined) {
    problems.add("compiler", "must be an object with kind, version and input");
    return { value: undefined, paths: undefined };
  }
  const kind = checkKind(fields.get("kind"), problems);
  const version = checkVersion(fields.get("version"), problems);
  const { value: input, paths } = checkStandardJson(fields.get("input"), problems);
  if (kind === undefined || version === undefined || input === undefined) {
    return { value: undefined, paths };
  }
  return { value: { kind, version, input }, paths };
}

function checkContractName(
  value: unknown,
  paths: ReadonlySet<string> | undefined,
  problems: Problems,
): string | undefined {
  const colon = typeof value === "string" ? value.lastIndexOf(":") : -1;
  if (typeof value !== "string" || colon < 1 || !IDENTIFIER.test(value.slice(colon + 1))) {
    return problems.add(
      "contractName",
      "must be path:Name, with a Solidity identifier after the last colon",
    );
  }
  // When the sources did not parse, their own issue is enough.
  if (paths !== undefined && !paths.has(value.slice(0, colon))) {
    return problems.add("contractName", "must start with a key of compiler.input.sources");
  }
  return value;
}

/** An optional hex field: `{}` when absent, `undefined` when present and invalid. */
function checkOptionalHex(
  fields: Map<string, unknown>,
  field: "constructorArgs" | "creationTxHash",
  pattern: RegExp,
  message: string,
  problems: Problems,
): { value?: Hex } | undefined {
  const value = fields.get(field);
  if (value === undefined) {
    return {};
  }
  return typeof value === "string" && pattern.test(value)
    ? { value: `0x${value.slice(2)}` }
    : problems.add(field, message);
}

/**
 * Checks a verification input before any request is sent (R-IN-6), and returns it normalised: the
 * compiler version without a leading `v` and the address in lower case (R-IN-1). Each backend adds
 * the prefix or checksum it needs. Sources and settings are copied unchanged, with any extra
 * Standard JSON fields; fields that `VerifyInput` does not declare are left out.
 *
 * It finds every problem, not only the first. Each issue names its field with a dotted path, such
 * as `compiler.version`, so a form can show it next to the field. Messages never repeat a value,
 * a source path or anything else the input chose. The address check is format only: the EIP-55
 * checksum is not checked. It sends nothing and calls no `fetch`.
 *
 * @param input - The input to check. Any value is accepted, for example `JSON.parse` of a request
 *   body; a value whose fields cannot be read, such as a Proxy whose traps throw, is rejected.
 * @returns A new, normalised {@link VerifyInput}.
 * @throws ExplorerVerifyError with code `invalid-input`, listing each problem in `details.issues`.
 * @example
 * ```ts
 * import { ExplorerVerifyError, validateInput } from "explorer-verify";
 *
 * try {
 *   const input = validateInput({
 *     chainId: 11155111,
 *     address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
 *     compiler: { kind: "solc", version: "v0.8.24+commit.e11b9ed9", input: standardJson },
 *     contractName: "src/Token.sol:Token",
 *   });
 *   console.log(input.compiler.version); // "0.8.24+commit.e11b9ed9"
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.details.code === "invalid-input") {
 *     for (const issue of error.details.issues) {
 *       console.error(`${issue.field} ${issue.message}`);
 *     }
 *   }
 * }
 * ```
 * @experimental
 */
export function validateInput(input: unknown): VerifyInput {
  const problems = new Problems();
  const fields = readFields(input);
  if (fields === undefined) {
    problems.add("input", "must be a plain object whose fields can be read");
    throw invalid(problems);
  }
  const chainId = checkChainId(fields.get("chainId"), problems);
  const address = checkAddress(fields.get("address"), problems);
  const { value: compiler, paths } = checkCompiler(fields.get("compiler"), problems);
  const contractName = checkContractName(fields.get("contractName"), paths, problems);
  const constructorArgs = checkOptionalHex(
    fields,
    "constructorArgs",
    EVEN_HEX,
    "must be 0x followed by an even number of hex digits",
    problems,
  );
  const creationTxHash = checkOptionalHex(
    fields,
    "creationTxHash",
    TX_HASH,
    "must be 0x followed by 64 hex digits",
    problems,
  );

  if (
    problems.issues.length > 0 ||
    chainId === undefined ||
    address === undefined ||
    compiler === undefined ||
    contractName === undefined ||
    constructorArgs === undefined ||
    creationTxHash === undefined
  ) {
    throw invalid(problems);
  }
  const result: VerifyInput = { chainId, address, compiler, contractName };
  if (constructorArgs.value !== undefined) {
    result.constructorArgs = constructorArgs.value;
  }
  if (creationTxHash.value !== undefined) {
    result.creationTxHash = creationTxHash.value;
  }
  return result;
}

function invalid({ issues, hints }: Problems): ExplorerVerifyError {
  const fields = issues.map((issue) => issue.field).join(", ");
  const [hint] = hints;
  const options =
    hint === undefined
      ? {}
      : { hint: issues.length > 1 ? `${hint} Then fix the other fields in details.issues.` : hint };
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The input is invalid: ${fields}.`,
    options,
  );
}
