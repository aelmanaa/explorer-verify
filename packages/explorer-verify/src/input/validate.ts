import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { addressDigits, readChainId, readFields } from "../internal/read-fields.ts";
import type { Hex, SolidityStandardJsonInput, VerifyInput } from "../types.ts";

// Group 1 is the version without the optional `v`. Nightly builds carry `-nightly.YYYY.M.D`,
// official pre-releases `-pre.N`.
const VERSION =
  /^v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-nightly\.\d{4}\.\d{1,2}\.\d{1,2}|-pre\.\d{1,4})?\+commit\.[0-9a-f]{8})$/;
// A full version followed by a platform suffix, as `solc --version` prints it (`.Linux.g++`).
const PLATFORM_VERSION =
  /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-nightly\.\d{4}\.\d{1,2}\.\d{1,2}|-pre\.\d{1,4})?\+commit\.[0-9a-f]{8}\.[A-Za-z]/;
const SHORT_VERSION = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_POSITIONS = 5;
const MAX_PATH = 1024;
const MAX_DEPTH = 64;
const STANDARD_JSON_FIELDS: readonly string[] = ["language", "sources", "settings"];

const SHORT_VERSION_HINT =
  "Pass the full compiler version with its commit, such as 0.8.24+commit.e11b9ed9.";
const PLATFORM_HINT =
  "Remove the platform suffix after the commit hash from compiler.version, such as .Linux.g++.";
const KIND_HINT = 'Set compiler.kind to "solc", the only supported compiler kind.';

/**
 * A deep copy of `value` through JSON, so the result shares no object with the caller. Each getter
 * and `toJSON` runs once. `"not-json"` when `value` is not JSON data: a cycle, a BigInt, a
 * function, a symbol, NaN or an infinity, an object that is not a plain object or array (a Map, a
 * Set, a class instance), or a Proxy that throws. JSON would drop or change these silently, so the
 * caller's data would not reach the explorer as given. The checks apply after `toJSON`, so a Date
 * becomes its ISO string. `"too-deep"` when an object or array sits more than {@link MAX_DEPTH}
 * levels deep: the replacer stops the copy at that level, so the result never depends on the
 * runtime's stack size.
 */
function copyJson(value: unknown): { value: unknown } | "not-json" | "too-deep" {
  // The depth of each object or array the copy has entered. The root's holder is not in the map.
  const depths = new Map<unknown, number>();
  let tooDeep = false;
  function replacer(this: unknown, _key: string, current: unknown): unknown {
    if (
      typeof current === "function" ||
      typeof current === "symbol" ||
      (typeof current === "number" && !Number.isFinite(current))
    ) {
      throw new TypeError("not JSON data");
    }
    if (typeof current === "object" && current !== null) {
      const parent = depths.get(this) ?? 0;
      if (parent >= MAX_DEPTH) {
        tooDeep = true;
        throw new RangeError("nested too deeply");
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
        throw new TypeError("not JSON data");
      }
      depths.set(current, parent + 1);
    }
    return current;
  }
  try {
    const copy: unknown = JSON.parse(JSON.stringify(value, replacer));
    return { value: copy };
  } catch {
    return tooDeep ? "too-deep" : "not-json";
  }
}

/** A path of at most {@link MAX_PATH} characters, with no C0 control character and no DEL. */
function isSafePath(path: string): boolean {
  if (path.length > MAX_PATH) {
    return false;
  }
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** `"1 file"` or `"2 files"`. */
function count(amount: number, noun: string): string {
  return `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;
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
  return readChainId(value) ?? problems.add("chainId", "must be a positive integer");
}

function checkAddress(value: unknown, problems: Problems): Hex | undefined {
  const digits = addressDigits(value);
  return digits === undefined
    ? problems.add("address", "must be 0x followed by 40 hex digits")
    : `0x${digits.toLowerCase()}`;
}

function checkKind(value: unknown, problems: Problems): "solc" | undefined {
  return value === "solc"
    ? value
    : problems.add("compiler.kind", 'must be "solc", the only supported kind', KIND_HINT);
}

function checkVersion(value: unknown, problems: Problems): string | undefined {
  const field = "compiler.version";
  if (typeof value !== "string") {
    return problems.add(field, "must be a full solc version, such as 0.8.24+commit.e11b9ed9");
  }
  const version = VERSION.exec(value)?.[1];
  if (version !== undefined) {
    return version;
  }
  if (SHORT_VERSION.test(value)) {
    return problems.add(
      field,
      "is a short version; pass the full version with its commit, such as 0.8.24+commit.e11b9ed9",
      SHORT_VERSION_HINT,
    );
  }
  if (PLATFORM_VERSION.test(value)) {
    return problems.add(
      field,
      "has a platform suffix; pass the version up to the commit hash, such as 0.8.24+commit.e11b9ed9",
      PLATFORM_HINT,
    );
  }
  return problems.add(field, "must be a full solc version, such as 0.8.24+commit.e11b9ed9");
}

function checkLanguage(value: unknown, problems: Problems): "Solidity" | undefined {
  return value === "Solidity"
    ? value
    : problems.add("compiler.input.language", 'must be "Solidity"');
}

/** `"2 files without a string content, at positions 1, 3"`, or `undefined` when none. */
function describePositions(positions: number[], noun: string, what: string): string | undefined {
  if (positions.length === 0) {
    return undefined;
  }
  const shown = positions.slice(0, MAX_POSITIONS).join(", ");
  const more = positions.length > MAX_POSITIONS ? " and more" : "";
  const at = positions.length === 1 ? "position" : "positions";
  return `${count(positions.length, noun)} ${what}, at ${at} ${shown}${more}`;
}

/**
 * The sources, each entry deep-copied with every field kept, and every source path. `undefined`
 * when the sources are not an object or are empty. Bad entries and bad paths are reported by
 * position, never by path: the input chose the paths. `sources` is `undefined` when any entry or
 * path is bad, while `paths` still lets `contractName` be checked.
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
  const noContent: number[] = [];
  const unreadable: number[] = [];
  const tooDeep: number[] = [];
  const badPaths: number[] = [];
  let position = 0;
  for (const [path, entry] of entries) {
    position++;
    if (!isSafePath(path)) {
      badPaths.push(position);
    }
    const copy = typeof entry === "object" && entry !== null ? copyJson(entry) : { value: entry };
    if (copy === "not-json") {
      unreadable.push(position);
      continue;
    }
    if (copy === "too-deep") {
      tooDeep.push(position);
      continue;
    }
    const fields = readFields(copy.value);
    const content = fields?.get("content");
    if (fields === undefined || typeof content !== "string") {
      noContent.push(position);
    } else {
      good.push([path, { ...Object.fromEntries(fields), content }]);
    }
  }
  const paths = new Set(entries.keys());
  const parts = [
    describePositions(noContent, "file", "without a string content"),
    describePositions(unreadable, "file", "that cannot be read as JSON data"),
    describePositions(tooDeep, "file", "nested more than 64 levels deep"),
    describePositions(badPaths, "path", "of more than 1024 characters or with control characters"),
  ].filter((part) => part !== undefined);
  if (parts.length > 0) {
    problems.add(field, `has ${parts.join("; ")}`);
    return { paths };
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return { sources: Object.fromEntries(good), paths };
}

function checkSettings(value: unknown, problems: Problems): Record<string, unknown> | undefined {
  const field = "compiler.input.settings";
  if (typeof value !== "object" || value === null) {
    return problems.add(field, "must be an object");
  }
  const copy = copyJson(value);
  if (copy === "not-json") {
    return problems.add(field, "must be JSON data");
  }
  if (copy === "too-deep") {
    return problems.add(field, "is nested more than 64 levels deep");
  }
  const fields = readFields(copy.value);
  return fields === undefined
    ? problems.add(field, "must be an object")
    : Object.fromEntries(fields);
}

/**
 * The Standard JSON fields other than language, sources and settings, deep-copied. A field whose
 * value is `undefined` is left out, as JSON leaves it out. Fields that are not JSON data are
 * counted, never named: the input chose the names.
 */
function checkExtraFields(
  fields: Map<string, unknown>,
  problems: Problems,
): [string, unknown][] | undefined {
  const extras: [string, unknown][] = [];
  let notJson = 0;
  let tooDeep = 0;
  for (const [name, value] of fields) {
    if (STANDARD_JSON_FIELDS.includes(name) || value === undefined) {
      continue;
    }
    const copy = copyJson(value);
    if (copy === "not-json") {
      notJson++;
    } else if (copy === "too-deep") {
      tooDeep++;
    } else {
      extras.push([name, copy.value]);
    }
  }
  const parts: string[] = [];
  if (notJson > 0) {
    parts.push(`${count(notJson, "field")} that ${notJson === 1 ? "is" : "are"} not JSON data`);
  }
  if (tooDeep > 0) {
    parts.push(`${count(tooDeep, "field")} nested more than 64 levels deep`);
  }
  if (parts.length > 0) {
    return problems.add("compiler.input", `has ${parts.join("; ")}`);
  }
  return extras;
}

/** A checked value, `undefined` when invalid, and the source paths when the sources were read. */
interface WithPaths<T> {
  value: T | undefined;
  paths: ReadonlySet<string> | undefined;
}

/** The Standard JSON input, deep-copied with every field kept. */
function checkStandardJson(
  value: unknown,
  problems: Problems,
): WithPaths<SolidityStandardJsonInput> {
  const fields = readFields(value);
  if (fields === undefined) {
    problems.add("compiler.input", "must be the Standard JSON input object");
    return { value: undefined, paths: undefined };
  }
  const extras = checkExtraFields(fields, problems);
  const language = checkLanguage(fields.get("language"), problems);
  const checked = checkSources(fields.get("sources"), problems);
  const settings = checkSettings(fields.get("settings"), problems);
  const sources = checked?.sources;
  const paths = checked?.paths;
  if (
    extras === undefined ||
    language === undefined ||
    sources === undefined ||
    settings === undefined
  ) {
    return { value: undefined, paths };
  }
  return { value: { language, sources, settings, ...Object.fromEntries(extras) }, paths };
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
  const path = value.slice(0, colon);
  if (!isSafePath(path)) {
    return problems.add(
      "contractName",
      "must have a path of at most 1024 characters, without control characters",
    );
  }
  // When the sources did not parse, their own issue is enough.
  if (paths !== undefined && !paths.has(path)) {
    return problems.add("contractName", "must start with a key of compiler.input.sources");
  }
  return value;
}

/** An optional hex field in lower case: `{}` when absent, `undefined` when present and invalid. */
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
    ? { value: `0x${value.slice(2).toLowerCase()}` }
    : problems.add(field, message);
}

/**
 * Checks a verification input before any request is sent (R-IN-6), and returns it normalised
 * (R-IN-1): the compiler version without a leading `v`, and the address, `constructorArgs` and
 * `creationTxHash` in lower case. Each backend adds the prefix or checksum it needs.
 *
 * The result is a deep copy that shares no object with the input, so changing the input later does
 * not change it. Sources, settings and any extra Standard JSON fields go through a JSON round trip:
 * their values are kept, and each getter and `toJSON` runs once. A value that JSON would drop or
 * change is rejected rather than changed: a cycle, a BigInt, a function, a symbol, NaN or an
 * infinity, a Map, a Set, a class instance or a Proxy that throws. A Date is kept as the ISO string
 * its `toJSON` returns. A value nested more than 64 levels deep is rejected on every runtime;
 * real Standard JSON is about 5 levels deep. Fields that `VerifyInput` does not declare are left
 * out.
 *
 * It finds every problem, not only the first. Each issue names its field with a dotted path, such
 * as `compiler.version`, so a form can show it next to the field. Messages never repeat a value,
 * a source path or anything else the input chose. The address check is format only: the EIP-55
 * checksum is not checked. Source paths and the path in `contractName` are at most 1024 characters
 * with no control characters. It sends nothing and calls no `fetch`.
 *
 * `compiler.version` needs an 8-character commit hash, so solc 0.1.1 and 0.1.2, whose long
 * versions carry a 7-character hash, are rejected.
 *
 * `constructorArgs` and `creationTxHash` are optional, not nullable: leave them out or set them to
 * `undefined`; `null` is rejected. `constructorArgs: "0x"` means the constructor takes no arguments.
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
      ? { secrets: [] }
      : {
          hint: issues.length > 1 ? `${hint} Then fix the other fields in details.issues.` : hint,
          secrets: [],
        };
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The input is invalid: ${fields}.`,
    options,
  );
}
