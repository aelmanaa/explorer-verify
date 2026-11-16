import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import { addressDigits, readChainId, readFields } from "../internal/read-fields.ts";
import type {
  Hex,
  SolidityStandardJsonInput,
  VerifyInput,
  VyperStandardJsonInput,
} from "../types.ts";
import { isLocalPath } from "./paths.ts";

// Group 1 is the version without the optional `v`. Nightly builds carry `-nightly.YYYY.M.D`,
// official pre-releases `-pre.N`.
const VERSION =
  /^v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-nightly\.\d{4}\.\d{1,2}\.\d{1,2}|-pre\.\d{1,4})?\+commit\.[0-9a-f]{8})$/;
// A full version followed by a platform suffix, as `solc --version` prints it (`.Linux.g++`).
const PLATFORM_VERSION =
  /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-nightly\.\d{4}\.\d{1,2}\.\d{1,2}|-pre\.\d{1,4})?\+commit\.[0-9a-f]{8}\.[A-Za-z]/;
// Group 1 is the version without the optional `v`: a short solc version, a zksolc version or a
// revision of ZKsync's solc fork.
const SHORT_VERSION = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
// Hex bytes and solc's library placeholders, `__$`, 34 hex digits and `$__` (20 bytes each), with
// or without `0x`, as the compiler writes `evm.bytecode.object`.
const CREATION_BYTECODE = /^(?:0x)?(?:[0-9a-fA-F]{2}|__\$[0-9a-fA-F]{34}\$__)+$/;
// 65536 bytes as hex, and `0x`.
const MAX_CREATION_BYTECODE = 2 + 2 * 65_536;
const MAX_POSITIONS = 5;
const MAX_PATH = 1024;
// Unicode format characters: bidirectional overrides, zero-width characters and the like.
const FORMAT_CHARACTER = /\p{Cf}/u;
const MAX_DEPTH = 64;
const STANDARD_JSON_FIELDS: readonly string[] = ["language", "sources", "settings"];
const VYPER_JSON_FIELDS: readonly string[] = [...STANDARD_JSON_FIELDS, "interfaces"];
// References: decision 0075.
// Groups 1 to 3 are the major, minor and patch numbers, group 4 a prerelease tag (`rc1`, `b2`,
// `a1`, or `-rc6` as Blockscout lists it), group 5 the commit. A 7-character commit is matched so
// that it gets its own message.
const VYPER_VERSION =
  /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(-?(?:a|b|rc)\d{1,4})?\+commit\.([0-9a-f]{7,8})$/;
// The first release whose bytecode trailer every explorer was seen to read: 0.3.10.
const VYPER_FLOOR = [0, 3, 10] as const;
// `vyper -f solc_json` turns each `..` of a path into its index: `0/1/2/<absolute path>`.
const INDEXED_PATH = /^0[/\\]/;

const SHORT_VERSION_HINT =
  "Pass the full compiler version with its commit, such as 0.8.24+commit.e11b9ed9.";
const ZKVM_HINT =
  "Pass only the revision: for zkVM-0.8.24-1.0.2, set solcFork to 1.0.2 and solcVersion to 0.8.24 with its commit.";
const KIND_HINT = 'Set compiler.kind to "solc", "zksolc" or "vyper".';
const VYPER_VERSION_HINT =
  "Pass the version with the 8-character commit of its Vyper release asset, such as 0.4.3+commit.bff19ea2. PyPI wheels of Vyper 0.3.x print 7 characters.";
const VYPER_NAME_HINT = "Name a Vyper contract after its file, such as src/Counter.vy:Counter.";
const VYPER_PATH_HINT =
  'Rename each such key to its path in the project or package, such as snekmate/auth/ownable.vy, and set settings.search_paths to ["."].';
const VYPER_LIBRARIES_HINT = "Vyper has no linked libraries: remove them.";
const LIBRARY_KEY_HINT =
  "Key each entry of libraries by the path of a file in compiler.input.sources, a colon and the library's name, such as src/Lib.sol:Lib.";
const LIBRARY_ADDRESS_HINT =
  "Give each library address as 0x followed by 40 hex digits, the address the library is deployed at.";

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
  // The replacer stops the copy by throwing an error without a message: only `tooDeep` is read.
  // The depth of each object or array the copy has entered. The root's holder is not in the map.
  const depths = new Map<unknown, number>();
  let tooDeep = false;
  function replacer(this: unknown, _key: string, current: unknown): unknown {
    if (
      typeof current === "function" ||
      typeof current === "symbol" ||
      (typeof current === "number" && !Number.isFinite(current))
    ) {
      throw new TypeError();
    }
    if (typeof current === "object" && current !== null) {
      const parent = depths.get(this) ?? 0;
      if (parent >= MAX_DEPTH) {
        tooDeep = true;
        throw new RangeError();
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
        throw new TypeError();
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

/**
 * A path of at most {@link MAX_PATH} characters, with no C0 control character, no DEL and no
 * Unicode format character (category Cf, such as a bidirectional override, which can make a path
 * read differently from what it is).
 */
function isSafePath(path: string): boolean {
  if (path.length > MAX_PATH || FORMAT_CHARACTER.test(path)) {
    return false;
  }
  for (const character of path) {
    const code = character.charCodeAt(0);
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
  /** A well-formed compiler version that this release does not support, with its hint. */
  unsupported: { message: string; hint: string } | undefined;

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

function checkKind(
  value: unknown,
  problems: Problems,
): VerifyInput["compiler"]["kind"] | undefined {
  return value === "solc" || value === "zksolc" || value === "vyper"
    ? value
    : problems.add("compiler.kind", 'must be "solc", "zksolc" or "vyper"', KIND_HINT);
}

// References: decision 0075.
/**
 * A Vyper `compiler.version` without the leading `v`: a release from 0.3.10 on, with its
 * 8-character commit. A well-formed prerelease or an older release is recorded as unsupported.
 */
function checkVyperVersion(value: unknown, problems: Problems): string | undefined {
  const field = "compiler.version";
  const parts = typeof value === "string" ? VYPER_VERSION.exec(value) : null;
  if (parts === null) {
    return problems.add(
      field,
      "must be a full Vyper version with its commit, such as 0.4.3+commit.bff19ea2",
      VYPER_VERSION_HINT,
    );
  }
  const [version, major, minor, patch, prerelease, commit] = parts;
  if (commit?.length !== 8) {
    return problems.add(
      field,
      "has a 7-character commit hash; pass the 8-character hash, such as 0.4.3+commit.bff19ea2",
      VYPER_VERSION_HINT,
    );
  }
  const below =
    Number(major) === VYPER_FLOOR[0] &&
    (Number(minor) < VYPER_FLOOR[1] ||
      (Number(minor) === VYPER_FLOOR[1] && Number(patch) < VYPER_FLOOR[2]));
  if (prerelease !== undefined) {
    problems.unsupported = {
      message: "Vyper prereleases are not supported in this release: compiler.version.",
      hint: "Use a Vyper release, such as 0.4.3.",
    };
  } else if (below) {
    problems.unsupported = {
      message: "Vyper versions before 0.3.10 are not supported in this release: compiler.version.",
      hint: "Use Vyper 0.3.10 or later.",
    };
  }
  return version.replace(/^v/, "");
}

/** A full solc version without the leading `v`: `compiler.version`, or zksolc's `solcVersion`. */
function checkVersion(value: unknown, field: string, problems: Problems): string | undefined {
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
      `Remove the platform suffix after the commit hash from ${field}, such as .Linux.g++.`,
    );
  }
  return problems.add(field, "must be a full solc version, such as 0.8.24+commit.e11b9ed9");
}

function checkLanguage<L extends "Solidity" | "Vyper">(
  value: unknown,
  language: L,
  problems: Problems,
): L | undefined {
  return value === language
    ? language
    : problems.add("compiler.input.language", `must be "${language}"`);
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

// References: decision 0075.
/**
 * Adds one issue to `field` when any of `paths` is a local path, or starts with the indexes that
 * `vyper -f solc_json` writes for each `..` of a path, such as `0/1/2/`. Such a path holds a
 * location on the build machine, and the explorer would publish it. Positions only, never a path.
 *
 * @returns Whether any path was refused.
 */
function checkVyperPaths(
  paths: Iterable<unknown>,
  field: string,
  noun: string,
  problems: Problems,
): boolean {
  const local: number[] = [];
  let position = 0;
  for (const path of paths) {
    position++;
    if (typeof path === "string" && (isLocalPath(path) || INDEXED_PATH.test(path))) {
      local.push(position);
    }
  }
  const found = describePositions(local, noun, "naming a local path");
  if (found !== undefined) {
    problems.add(field, `has ${found}`, VYPER_PATH_HINT);
  }
  return found !== undefined;
}

/**
 * The interfaces of Vyper input, each entry deep-copied with every field kept: a `content` string
 * or an `abi` array. `{}` when absent, `undefined` when invalid. Reported by position, never by
 * path.
 */
function checkInterfaces(
  value: unknown,
  problems: Problems,
): { value?: NonNullable<VyperStandardJsonInput["interfaces"]> } | undefined {
  const field = "compiler.input.interfaces";
  if (value === undefined) {
    return {};
  }
  const entries = readFields(value);
  if (entries === undefined) {
    return problems.add(field, "must be an object of interface files by path");
  }
  const local = checkVyperPaths(entries.keys(), field, "key", problems);
  const good: [string, { content: string } | { abi: unknown[] }][] = [];
  const bad: number[] = [];
  let position = 0;
  for (const [path, entry] of entries) {
    position++;
    const copy = copyJson(entry);
    const fields = typeof copy === "object" ? readFields(copy.value) : undefined;
    const content = fields?.get("content");
    const abi: unknown = fields?.get("abi");
    if (fields === undefined || !isSafePath(path)) {
      bad.push(position);
    } else if (typeof content === "string") {
      good.push([path, { ...Object.fromEntries(fields), content }]);
    } else if (Array.isArray(abi)) {
      good.push([path, { ...Object.fromEntries(fields), abi }]);
    } else {
      bad.push(position);
    }
  }
  const found = describePositions(bad, "file", "without a content or abi, or with a bad path");
  if (found !== undefined) {
    return problems.add(field, `has ${found}`);
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return local ? undefined : { value: Object.fromEntries(good) };
}

/**
 * The sources, each entry deep-copied with every field kept, and every source path. `undefined`
 * when the sources are not an object or are empty. Bad entries and bad paths are reported by
 * position, never by path: the input chose the paths. `sources` is `undefined` when any entry or
 * path is bad, while `paths` still lets `contractName` be checked.
 */
function checkSources(
  value: unknown,
  vyper: boolean,
  problems: Problems,
):
  | {
      sources?: SolidityStandardJsonInput["sources"];
      paths: ReadonlySet<string>;
    }
  | undefined {
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
  // Vyper only: entries with `urls` or a `keccak256` that is not a string.
  const badFields: number[] = [];
  const local = vyper && checkVyperPaths(entries.keys(), field, "key", problems);
  let position = 0;
  for (const [path, entry] of entries) {
    position++;
    if (!isSafePath(path)) {
      badPaths.push(position);
    }
    // Only an object can hold a content. copyJson reads null as no fields, as it is.
    if (typeof entry !== "object") {
      noContent.push(position);
      continue;
    }
    const copy = copyJson(entry);
    if (copy === "not-json") {
      unreadable.push(position);
      continue;
    }
    if (copy === "too-deep") {
      tooDeep.push(position);
      continue;
    }
    const fields = readFields(copy.value) ?? new Map<string, unknown>();
    const content = fields.get("content");
    const hash = fields.get("keccak256");
    if (typeof content !== "string") {
      noContent.push(position);
    } else if (vyper && (fields.has("urls") || (hash !== undefined && typeof hash !== "string"))) {
      badFields.push(position);
    } else {
      good.push([path, { ...Object.fromEntries(fields), content }]);
    }
  }
  const paths = new Set(entries.keys());
  const parts = [
    describePositions(noContent, "file", "without a string content"),
    describePositions(badFields, "file", "with urls or a keccak256 that is not a string"),
    describePositions(unreadable, "file", "that cannot be read as JSON data"),
    describePositions(tooDeep, "file", "nested more than 64 levels deep"),
    describePositions(badPaths, "path", "of more than 1024 characters or with control characters"),
  ].filter((part) => part !== undefined);
  if (parts.length > 0) {
    problems.add(field, `has ${parts.join("; ")}`);
    return { paths };
  }
  if (local) {
    return { paths };
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return { sources: Object.fromEntries(good), paths };
}

function checkSettings(value: unknown, problems: Problems): Record<string, unknown> | undefined {
  const field = "compiler.input.settings";
  // null passes here and fails as an object below.
  if (typeof value !== "object") {
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
  known: readonly string[],
  problems: Problems,
): [string, unknown][] | undefined {
  const extras: [string, unknown][] = [];
  let notJson = 0;
  let tooDeep = 0;
  for (const [name, value] of fields) {
    if (known.includes(name) || value === undefined) {
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
  value?: T | undefined;
  paths?: ReadonlySet<string> | undefined;
}

/** The Standard JSON input of `language`, deep-copied with every field kept. */
function checkStandardJson<L extends "Solidity" | "Vyper">(
  value: unknown,
  language: L,
  problems: Problems,
): WithPaths<{
  language: L;
  sources: SolidityStandardJsonInput["sources"];
  settings: Record<string, unknown>;
}> & { fields?: Map<string, unknown> } {
  const fields = readFields(value);
  if (fields === undefined) {
    problems.add("compiler.input", "must be the Standard JSON input object");
    return {};
  }
  const vyper = language === "Vyper";
  const extras = checkExtraFields(
    fields,
    vyper ? VYPER_JSON_FIELDS : STANDARD_JSON_FIELDS,
    problems,
  );
  const checkedLanguage = checkLanguage(fields.get("language"), language, problems);
  const checked = checkSources(fields.get("sources"), vyper, problems);
  const settings = checkSettings(fields.get("settings"), problems);
  const sources = checked?.sources;
  const paths = checked?.paths;
  // References: decision 0075.
  const searchPaths: unknown = settings?.["search_paths"];
  const local =
    vyper &&
    Array.isArray(searchPaths) &&
    checkVyperPaths(searchPaths, "compiler.input.settings.search_paths", "item", problems);
  if (
    extras === undefined ||
    local ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    checkedLanguage === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    sources === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    settings === undefined
  ) {
    return { paths, fields };
  }
  return {
    value: { language: checkedLanguage, sources, settings, ...Object.fromEntries(extras) },
    paths,
    fields,
  };
}

// References: decision 0075.
/** The Vyper Standard JSON input, deep-copied with every field kept, `interfaces` included. */
function checkVyperJson(value: unknown, problems: Problems): WithPaths<VyperStandardJsonInput> {
  const { value: input, paths, fields } = checkStandardJson(value, "Vyper", problems);
  const interfaces = checkInterfaces(fields?.get("interfaces"), problems);
  if (input === undefined || interfaces === undefined) {
    return { paths };
  }
  return {
    value: {
      ...input,
      ...(interfaces.value === undefined ? {} : { interfaces: interfaces.value }),
    },
    paths,
  };
}

function checkCompiler(
  value: unknown,
  problems: Problems,
): WithPaths<VerifyInput["compiler"]> & { vyper?: true } {
  const fields = readFields(value);
  if (fields === undefined) {
    problems.add("compiler", "must be an object with kind, version and input");
    return {};
  }
  const kind = checkKind(fields.get("kind"), problems);
  // zksolc's own fields (decision 0057): its version is x.y.z, solcVersion is checked as a solc
  // version, and solcFork is optional. "" stands for a field that a kind does not have; a solc or
  // Vyper compiler that sets one is refused, as its type and the schema refuse it. Vyper has its
  // own version form and input type (decision 0075).
  const zksolc = kind === "zksolc";
  const version = zksolc
    ? checkShort(
        fields.get("version"),
        "compiler.version",
        "a version x.y.z, such as 1.5.15",
        problems,
      )
    : kind === "vyper"
      ? checkVyperVersion(fields.get("version"), problems)
      : checkVersion(fields.get("version"), "compiler.version", problems);
  const solcVersion = zksolc
    ? checkSolcVersion(fields.get("solcVersion"), problems)
    : onlyZksolc(fields, "solcVersion", kind, problems);
  const fork = fields.get("solcFork");
  const solcFork = !zksolc
    ? onlyZksolc(fields, "solcFork", kind, problems)
    : fork === undefined
      ? ""
      : checkShort(
          fork,
          "compiler.solcFork",
          "a revision x.y.z, such as 1.0.2",
          problems,
          ZKVM_HINT,
        );
  if (kind === "vyper") {
    const { value: input, paths } = checkVyperJson(fields.get("input"), problems);
    if (
      // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
      version === undefined ||
      // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
      input === undefined ||
      // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
      solcVersion === undefined ||
      // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
      solcFork === undefined
    ) {
      return { paths, vyper: true };
    }
    return { value: { kind, version, input }, paths, vyper: true };
  }
  const { value: input, paths } = checkStandardJson(fields.get("input"), "Solidity", problems);
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: equivalent for the false variant: each check that leaves a field undefined adds an issue, and validateInput fails the input on any issue. The true variant rejects valid input, which other tests catch.
  if (kind === undefined || version === undefined || input === undefined) {
    return { paths };
  }
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: equivalent for the false variant: each check that leaves a field undefined adds an issue, and validateInput fails the input on any issue. The true variant rejects valid input, which other tests catch.
  if (solcVersion === undefined || solcFork === undefined) {
    return { paths };
  }
  return {
    value:
      kind === "solc"
        ? { kind, version, input }
        : { kind, version, solcVersion, ...(solcFork === "" ? {} : { solcFork }), input },
    paths,
  };
}

/** A version `x.y.z` without the leading `v`: zksolc's version, or its solc fork's revision. */
function checkShort(
  value: unknown,
  field: string,
  what: string,
  problems: Problems,
  hint?: string,
): string | undefined {
  const version = typeof value === "string" ? SHORT_VERSION.exec(value)?.[1] : undefined;
  return version ?? problems.add(field, `must be ${what}`, hint);
}

/**
 * zksolc's `solcVersion`: a full solc version. A build-info's `zkVM-<solc>-<revision>` long version
 * gets its own message: it splits into `solcVersion` and `solcFork`.
 */
function checkSolcVersion(value: unknown, problems: Problems): string | undefined {
  const field = "compiler.solcVersion";
  return typeof value === "string" && value.startsWith("zkVM-")
    ? problems.add(
        field,
        "is a zkVM- long version; split it into solcVersion and solcFork",
        ZKVM_HINT,
      )
    : checkVersion(value, field, problems);
}

/** `""` for a zksolc field that a solc or Vyper compiler leaves out, or an issue when it sets it. */
function onlyZksolc(
  fields: Map<string, unknown>,
  name: string,
  kind: "solc" | "vyper" | undefined,
  problems: Problems,
): string | undefined {
  if (kind !== undefined && fields.get(name) !== undefined) {
    return problems.add(`compiler.${name}`, "is zksolc only");
  }
  // Stryker disable next-line StringLiteral: equivalent. A compiler that is not zksolc never reads this value.
  return "";
}

function checkContractName(
  value: unknown,
  paths: ReadonlySet<string> | undefined,
  vyper: boolean,
  problems: Problems,
): string | undefined {
  const format = "must be path:Name, with a Solidity identifier after the last colon";
  if (typeof value !== "string") {
    return problems.add("contractName", format);
  }
  const colon = value.lastIndexOf(":");
  if (colon < 1 || !IDENTIFIER.test(value.slice(colon + 1))) {
    return problems.add("contractName", format);
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
  // References: decision 0075. A Vyper source holds one contract, named after its file.
  const file = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (vyper && file !== `${value.slice(colon + 1)}.vy`) {
    return problems.add(
      "contractName",
      "must be the path of a .vy source and the file name without .vy, for Vyper",
      VYPER_NAME_HINT,
    );
  }
  return value;
}

/** What is wrong with one library entry, and the hint that says what to pass instead. */
interface LibraryProblem {
  readonly message: string;
  readonly hint: string;
}

/**
 * The address of one library entry in lower case, or what is wrong with the entry. `linked` is
 * `settings.libraries` of the input, when it is an object. A value it already holds for the same
 * library under the library's path must be the same address in any case. An entry under the empty
 * path, which solc applies to every file, is not compared: `linkLibraries` checks the shape.
 */
function checkLibrary(
  name: string,
  address: unknown,
  paths: ReadonlySet<string> | undefined,
  linked: Map<string, unknown> | undefined,
): { address: Hex } | LibraryProblem {
  const key = {
    message: "must be keyed by path:Name of compiler.input.sources",
    hint: LIBRARY_KEY_HINT,
  };
  const colon = name.lastIndexOf(":");
  const path = name.slice(0, colon);
  const library = name.slice(colon + 1);
  if (colon < 1 || !IDENTIFIER.test(library) || !isSafePath(path)) {
    return key;
  }
  if (isLocalPath(path)) {
    return { message: "must not be keyed by a local path", hint: LIBRARY_KEY_HINT };
  }
  if (paths?.has(path) === false) {
    return key;
  }
  const digits = addressDigits(address);
  if (digits === undefined) {
    return { message: "must be 0x followed by 40 hex digits", hint: LIBRARY_ADDRESS_HINT };
  }
  const lower: Hex = `0x${digits.toLowerCase()}`;
  const same = readFields(linked?.get(path))?.get(library);
  if (same !== undefined && (typeof same !== "string" || same.toLowerCase() !== lower)) {
    return {
      message: "conflicts with compiler.input.settings.libraries",
      hint: "Give each library the address compiler.input.settings.libraries holds for it, or remove the entry there.",
    };
  }
  return { address: lower };
}

// References: R-IN-4.
/**
 * The library link addresses in lower case: `{}` when absent, `undefined` when invalid.
 * Each issue names `libraries.<position>`, from 1 in the object's key order, never the key: the
 * key holds a path the input chose.
 */
function checkLibraries(
  value: unknown,
  input: { settings: Record<string, unknown> } | undefined,
  paths: ReadonlySet<string> | undefined,
  vyper: boolean,
  problems: Problems,
): { value?: Record<string, Hex> } | undefined {
  if (value === undefined) {
    return {};
  }
  // References: decision 0075.
  if (vyper) {
    return problems.add("libraries", "must be absent for Vyper", VYPER_LIBRARIES_HINT);
  }
  const entries = readFields(value);
  if (entries === undefined) {
    return problems.add("libraries", "must be an object");
  }
  const good: [string, Hex][] = [];
  let position = 0;
  for (const [name, address] of entries) {
    position++;
    const checked = checkLibrary(name, address, paths, readFields(input?.settings["libraries"]));
    if ("address" in checked) {
      good.push([name, checked.address]);
    } else {
      problems.add(`libraries.${String(position)}`, checked.message, checked.hint);
    }
  }
  // Object.fromEntries defines each key as an own property, so a key named __proto__ stays a key.
  // Stryker disable next-line ConditionalExpression: equivalent when always true. A bad library added an issue, and validateInput fails the input on any issue.
  return good.length === entries.size ? { value: Object.fromEntries(good) } : undefined;
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
 * Whether `value` is a creation bytecode `validateInput` accepts: hex bytes and solc's `__$...$__`
 * library placeholders, with or without `0x`, 1 to 65536 bytes. The length is checked before
 * the pattern, so a huge string is never matched.
 *
 * @param value - The bytecode, as the compiler wrote it.
 * @returns `true` when it is accepted.
 * @example
 * ```ts
 * isCreationBytecode("6080604052"); // true
 * ```
 */
export function isCreationBytecode(value: string): boolean {
  return value.length <= MAX_CREATION_BYTECODE && CREATION_BYTECODE.test(value);
}

/** `creationBytecode` with `0x` and in lower case: `{}` when absent, `undefined` when invalid. */
function checkCreationBytecode(
  value: unknown,
  vyper: boolean,
  problems: Problems,
): { value?: Hex } | undefined {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || !isCreationBytecode(value)) {
    return problems.add(
      "creationBytecode",
      "must be hex bytes and __$...$__ library placeholders, 1 to 65536 bytes",
    );
  }
  // References: decision 0075.
  if (vyper && value.includes("_")) {
    return problems.add(
      "creationBytecode",
      "must not hold library placeholders for Vyper",
      VYPER_LIBRARIES_HINT,
    );
  }
  // Stryker disable next-line Regex: equivalent. The pattern above allows 0x only at the start.
  return { value: `0x${value.replace(/^0x/, "").toLowerCase()}` };
}

// References: R-IN-6, R-IN-1, decision 0057, R-IN-4.
/**
 * Checks a verification input before any request is sent, and returns it normalised: the compiler
 * version without a leading `v`, and the address, `constructorArgs`,
 * `creationTxHash`, `creationBytecode` and each `libraries` address in lower case. Each backend
 * adds the prefix or checksum it needs.
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
 * `compiler.kind` is `"solc"`, `"zksolc"` or `"vyper"`. For zksolc, `compiler.version` is the
 * zksolc version, `x.y.z` such as `1.5.15`; `compiler.solcVersion` is the full solc version, with
 * the same rules as a solc `compiler.version`; and the optional `compiler.solcFork` is the
 * revision of ZKsync's solc fork, `x.y.z` such as `1.0.2`. Each comes back without a leading `v`.
 *
 * For Vyper, `compiler.version` is `x.y.z+commit.<8 hex>`, such as
 * `0.4.3+commit.bff19ea2`, and comes back without a leading `v`; a 7-character commit is rejected.
 * `compiler.input.language` is `"Vyper"`, and the optional `compiler.input.interfaces` is kept.
 * A source with `urls` is rejected. `contractName` is the path of a `.vy` source and the file name
 * without `.vy`, such as `src/Counter.vy:Counter`. `libraries` and library placeholders in
 * `creationBytecode` are rejected: Vyper has none. A key of `sources` or `interfaces`, or an entry
 * of `settings.search_paths`, that holds a local path is rejected, including the `0/1/…/` form that
 * `vyper -f solc_json` writes. A prerelease, or a release before 0.3.10, throws
 * `unsupported-compiler` on `compiler.version` before any `invalid-input`.
 *
 * `libraries`  is keyed by `path:Name`. The path must be a key of
 * `compiler.input.sources` and must not be a local path: absolute, home, drive, file URL, or
 * climbing above the root. When `settings.libraries` already holds a value for the same library
 * under its path, the value must be the same address in any case; any other value is rejected. An
 * entry under the empty path, which solc applies to every file, is not compared here;
 * `linkLibraries` compares it before it merges. Issues name `libraries.<position>`, counted from 1
 * in key order, never the key. The input is not changed: see {@link VerifyInput.libraries}.
 *
 * `constructorArgs`, `creationTxHash` and `creationBytecode` are optional, not nullable: leave them
 * out or set them to `undefined`; `null` is rejected. `constructorArgs: "0x"` means the constructor
 * takes no arguments. `creationBytecode` is 1 to 65536 bytes, may hold solc's `__$...$__` library
 * placeholders, and comes back with `0x`; `""` and `"0x"` are rejected.
 *
 * @param input - The input to check. Any value is accepted, for example `JSON.parse` of a request
 *   body; a value whose fields cannot be read, such as a Proxy whose traps throw, is rejected.
 * @returns A new, normalised {@link VerifyInput}.
 * @throws ExplorerVerifyError with code `invalid-input`, listing each problem in `details.issues`;
 *   with code `unsupported-compiler` on `compiler.version` for a Vyper version this release does
 *   not support.
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
 *   if (error instanceof ExplorerVerifyError && error.code === "invalid-input") {
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
  const { value: compiler, paths, vyper = false } = checkCompiler(fields.get("compiler"), problems);
  const contractName = checkContractName(fields.get("contractName"), paths, vyper, problems);
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
  const creationBytecode = checkCreationBytecode(fields.get("creationBytecode"), vyper, problems);
  const libraries = checkLibraries(
    fields.get("libraries"),
    compiler?.input,
    paths,
    vyper,
    problems,
  );
  // A well-formed version that this release does not support ends the check: fixing the other
  // fields would not make the input verifiable.
  if (problems.unsupported !== undefined) {
    throw newError(
      { code: "unsupported-compiler", field: "compiler.version" },
      problems.unsupported.message,
      // Stryker disable next-line ArrayDeclaration: equivalent. The message names only a field, never a key.
      { hint: problems.unsupported.hint, secrets: [] },
    );
  }

  // Every check that adds an issue returns undefined, so these checks cover every issue. The
  // issues check below fails the same input, so each of them, one at a time, only narrows a type.
  const missing =
    // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    libraries === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    chainId === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    address === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    compiler === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    contractName === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    constructorArgs === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    creationTxHash === undefined ||
    // Stryker disable next-line ConditionalExpression: equivalent when always false. The check that leaves it undefined added an issue, and validateInput fails the input on any issue; this only narrows the type.
    creationBytecode === undefined;
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent when always false. The issues check below throws the same error.
  if (missing) {
    throw invalid(problems);
  }
  // Defence in depth: a later check that adds an issue but forgets to return undefined still
  // fails the input.
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent. Every check that adds an issue also returns undefined, which the check above catches.
  if (problems.issues.length > 0) {
    throw invalid(problems);
  }
  const result: VerifyInput = { chainId, address, compiler, contractName };
  if (constructorArgs.value !== undefined) {
    result.constructorArgs = constructorArgs.value;
  }
  if (creationTxHash.value !== undefined) {
    result.creationTxHash = creationTxHash.value;
  }
  if (creationBytecode.value !== undefined) {
    result.creationBytecode = creationBytecode.value;
  }
  if (libraries.value !== undefined) {
    result.libraries = libraries.value;
  }
  return result;
}

/**
 * The `invalid-input` error of the problems found. The message names the first issue in full and
 * the fields of the others, so a reader can fix the first without opening `details.issues`. An
 * issue never repeats a value, so the message holds none.
 */
function invalid({ issues, hints }: Problems): ExplorerVerifyError {
  const [first, ...others] = issues;
  // Stryker disable next-line StringLiteral: equivalent. invalid() always gets an issue, so the next line replaces this text.
  let head = "";
  // Stryker disable next-line ConditionalExpression: equivalent when always true. invalid() always gets an issue.
  if (first !== undefined) {
    head = `${first.field} ${first.message}`;
  }
  const rest = others.length === 0 ? "" : `; also ${others.map((issue) => issue.field).join(", ")}`;
  const [hint] = hints;
  const more =
    issues.length > 1 ? " Then fix the other fields that the issues list (details.issues)." : "";
  return newError({ code: "invalid-input", issues }, `The input is invalid: ${head}${rest}.`, {
    ...(hint === undefined ? {} : { hint: `${hint}${more}` }),
    // Stryker disable next-line ArrayDeclaration: equivalent. The message and the issues name only fields, never the text Stryker puts here.
    secrets: [],
  });
}
