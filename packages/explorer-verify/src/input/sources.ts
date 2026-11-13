// References: R-IN-7, R-DX-2, R-RUN-1, R-RUN-3.
/**
 * Builds the verification input from Solidity sources, compiler settings and remappings, for a
 * package that ships its sources but no build-info, Standard JSON input or metadata.
 *
 * It follows the import directives from the contract's file, resolves each import as solc does,
 * and passes the reachable sources and the settings to `buildVerifyInput`. It reads no file: the
 * caller passes the contents or a function that returns them, so it runs in a browser too.
 *
 * @packageDocumentation
 */

import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import { ownKeys, unknownKeys } from "../internal/known-keys.ts";
import { readFields, readOwn } from "../internal/read-fields.ts";
import { buildVerifyInput } from "./build.ts";
import type { BuiltVerifyInput } from "./build.ts";
import { importPaths, parseRemapping, resolveImport } from "./imports.ts";
import type { Remapping } from "./imports.ts";
import { OUTPUT_SELECTION } from "./metadata.ts";
import { isLocalPath } from "./paths.ts";

/**
 * Returns the content of one source file by its source unit name, such as
 * `lib/acl/src/Ownable.sol`, or `undefined` when there is none. It may return a promise.
 *
 * @example
 * ```ts
 * import type { SourceReader } from "explorer-verify/sources";
 *
 * const files = new Map([["src/Vault.sol", "// SPDX-License-Identifier: MIT\n"]]);
 * const read: SourceReader = (name) => files.get(name);
 * ```
 * @experimental
 */
export type SourceReader = (
  sourceUnitName: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Options for {@link buildVerifyInputFromSources}. A field set to `undefined` counts as absent.
 * Any other key throws `invalid-input` naming it and, when one is close, the option it may mean.
 *
 * @example
 * ```ts
 * import type { BuildFromSourcesOptions } from "explorer-verify/sources";
 *
 * const options: BuildFromSourcesOptions = {
 *   contract: "src/Vault.sol:Vault",
 *   compilerVersion: "0.8.24+commit.e11b9ed9",
 *   settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
 *   remappings: ["@acl/=lib/acl/src/"],
 *   sources: { "src/Vault.sol": "// SPDX-License-Identifier: MIT\n" },
 * };
 * ```
 * @experimental
 */
export interface BuildFromSourcesOptions {
  /** The contract to verify, as `path:Name`, with the path as a source unit name. */
  contract: string;
  /** The full compiler version, such as `0.8.24+commit.e11b9ed9`. */
  compilerVersion: string;
  /**
   * The Standard JSON `settings` of the build: `optimizer`, `viaIR`, `evmVersion`, `metadata`,
   * `libraries` and the others, as the package's compiler configuration sets them for this
   * contract. When it has no `outputSelection`, one for the ABI, the bytecode and the metadata is
   * added.
   */
  settings: Readonly<Record<string, unknown>>;
  /**
   * The solc remappings, `context:prefix=target` with an optional context, such as
   * `@acl/=lib/acl/src/`. They go into `settings.remappings`. Pass them here or in `settings`,
   * not in both.
   */
  remappings?: readonly string[] | undefined;
  /**
   * The source contents by source unit name, or a {@link SourceReader} that returns one. Only
   * the files the contract imports, directly or not, are read and put in the input.
   */
  sources: Readonly<Record<string, string>> | SourceReader;
}

const OPTIONS_HINT =
  "Fix the fields that the issues list (details.issues). Pass the contract as path:Name, the full compiler version, the settings object, the remappings as context:prefix=target strings, and the sources.";
const LOCAL_HINT =
  "Pass source unit names and remappings relative to the project root, so no local path is published.";
const SOURCES_HINT =
  "Pass each missing source file (details.candidates) in the sources (options.sources), keyed by its source unit name, or add the remapping that maps its import to a file you pass.";
// The most missing source names an error lists; the message gives the full count.
const MAX_MISSING = 1000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NO_REMAPPING: Remapping = { context: "", prefix: "", target: "" };

/** The checked options. */
interface ReadOptions {
  readonly path: string;
  readonly contract: string;
  readonly compilerVersion: string;
  readonly settings: Map<string, unknown>;
  readonly remappings: readonly string[];
  readonly read: (name: string) => Promise<unknown>;
}

function invalid(issues: InputIssue[], hint = OPTIONS_HINT): ExplorerVerifyError {
  return newError(
    { code: "invalid-input", issues },
    `The input is invalid: ${issues.map(({ field }) => field).join(", ")}.`,
    // The message names only fields, never a value or a path.
    { hint, secrets: [] },
  );
}

/** The keys of {@link BuildFromSourcesOptions}, in documentation order. */
function optionKeys(): readonly string[] {
  return Object.keys({
    contract: null,
    compilerVersion: null,
    settings: null,
    remappings: null,
    sources: null,
  } satisfies Record<keyof BuildFromSourcesOptions, null>);
}

/** The remappings as a list of strings, or `undefined` when `value` is not one. */
function readStrings(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const strings: string[] = [];
    for (const item of Array.from<unknown>(value)) {
      if (typeof item !== "string") {
        return undefined;
      }
      strings.push(item);
    }
    return strings;
  } catch {
    // A Proxy trap threw: not a readable list.
    return undefined;
  }
}

/** The remappings of `options.remappings` or `settings.remappings`, checked and split. */
function readRemappings(option: unknown, settings: Map<string, unknown>): string[] {
  const inSettings = settings.get("remappings");
  if (option !== undefined && inSettings !== undefined) {
    throw invalid([
      { field: "remappings", message: "is set both here and in settings; pass it in one place" },
    ]);
  }
  const field = option === undefined ? "settings.remappings" : "remappings";
  const value = option ?? inSettings;
  if (value === undefined) {
    return [];
  }
  const list = readStrings(value);
  if (list === undefined) {
    throw invalid([{ field, message: "must be an array of strings" }]);
  }
  const malformed = list.findIndex((remapping) => parseRemapping(remapping) === undefined);
  if (malformed !== -1) {
    throw invalid([
      {
        field,
        message: `has a remapping at position ${String(malformed + 1)} that is not context:prefix=target with a prefix`,
      },
    ]);
  }
  const local = list.findIndex((remapping) => {
    const { context, prefix, target } = parseRemapping(remapping) ?? NO_REMAPPING;
    return [context, prefix, target].some(isLocalPath);
  });
  if (local !== -1) {
    throw invalid(
      [{ field, message: `has a local path at position ${String(local + 1)}` }],
      LOCAL_HINT,
    );
  }
  return list;
}

/** The function that reads one source: a lookup in the record, or the caller's reader. */
function readSources(
  value: BuildFromSourcesOptions["sources"] | undefined,
): (name: string) => Promise<unknown> {
  if (typeof value === "function") {
    return async (name) => {
      const content: unknown = await value(name);
      return content;
    };
  }
  const fields = readFields(value);
  if (fields === undefined) {
    throw invalid([
      { field: "sources", message: "must be an object of source contents or a function" },
    ]);
  }
  return (name) => Promise.resolve(fields.get(name));
}

/** The options, checked. Unknown keys first, so a getter on one never runs (R-IN-6). */
function readOptions(options: BuildFromSourcesOptions): ReadOptions {
  const keys = ownKeys(options);
  const fields = keys === undefined ? undefined : readFields(options);
  if (keys === undefined || fields === undefined) {
    throw invalid([{ field: "options", message: "must be an object" }]);
  }
  const unknown = unknownKeys(keys, optionKeys(), "", "options");
  if (unknown.length > 0) {
    throw invalid(unknown);
  }
  const issues: InputIssue[] = [];
  const contract = fields.get("contract");
  const colon = typeof contract === "string" ? contract.lastIndexOf(":") : -1;
  if (typeof contract !== "string" || colon < 1 || !IDENTIFIER.test(contract.slice(colon + 1))) {
    issues.push({ field: "contract", message: "must be path:Name" });
  }
  const compilerVersion = fields.get("compilerVersion");
  if (typeof compilerVersion !== "string") {
    issues.push({ field: "compilerVersion", message: "must be a string" });
  }
  const settings = readFields(fields.get("settings"));
  if (settings === undefined) {
    issues.push({ field: "settings", message: "must be the Standard JSON settings object" });
  }
  if (
    typeof contract !== "string" ||
    typeof compilerVersion !== "string" ||
    settings === undefined ||
    issues.length > 0
  ) {
    throw invalid(issues);
  }
  const path = contract.slice(0, colon);
  if (isLocalPath(path)) {
    throw invalid([{ field: "contract", message: "has a local path" }], LOCAL_HINT);
  }
  return {
    path,
    contract,
    compilerVersion,
    settings,
    remappings: readRemappings(fields.get("remappings"), settings),
    read: readSources(readOwn(options, "sources")),
  };
}

/**
 * The contents of the contract's file and of every file it imports, directly or not, by source
 * unit name, and the names that have no content.
 */
async function collect(
  options: ReadOptions,
): Promise<{ found: Map<string, string>; missing: string[] }> {
  const remappings: Remapping[] = [];
  for (const remapping of options.remappings) {
    const parsed = parseRemapping(remapping);
    if (parsed !== undefined) {
      remappings.push(parsed);
    }
  }
  const found = new Map<string, string>();
  const missing: string[] = [];
  const queue = [options.path];
  // Each name is queued once, so an import cycle ends.
  const queued = new Set(queue);
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const content = await options.read(name);
    if (content === undefined) {
      missing.push(name);
      continue;
    }
    if (typeof content !== "string") {
      throw invalid([{ field: "sources", message: "must give each source content as a string" }]);
    }
    found.set(name, content);
    for (const path of importPaths(content)) {
      const resolved = resolveImport(path, name, remappings);
      if (resolved === "" || isLocalPath(resolved)) {
        throw invalid(
          [{ field: "sources", message: "has an import that resolves to a local path" }],
          LOCAL_HINT,
        );
      }
      if (!queued.has(resolved)) {
        queued.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return { found, missing };
}

// References: R-IN-7, R-DX-2.
/**
 * Builds the `compiler` part of `VerifyInput` and the contract name from Solidity sources, the
 * compiler settings and the remappings of a build, for a package that ships its sources and
 * bytecode but no build-info, Standard JSON input or metadata. It never compiles.
 *
 * 1. Reads the contract's file, then follows its `import` directives: all four Solidity forms,
 *    with imports inside comments and string literals ignored.
 * 2. Resolves each import as solc does: a path that starts with `./` or `../` against the
 *    importing file's directory, then the remapping whose context is a prefix of the importing
 *    file and whose prefix is a prefix of the path, the longest context first, then the longest
 *    prefix, then the last one listed.
 * 3. Reads each file once, so an import cycle ends, and puts only the files it reached in the
 *    input, each with its content exactly as given.
 * 4. Passes the input to `buildVerifyInput`, which keeps only `language`, `sources` and
 *    `settings`, rejects local paths and checks the result with `validateInput`.
 *
 * The bytecode a compiler gives for the input equals the package's only when the settings and
 * the remappings are the ones the package was built with. Compile the input once with the same
 * solc version and compare the creation bytecode before you ship it.
 *
 * @param options - The contract, the compiler version, the settings, the remappings and the
 *   sources.
 * @returns The compiler part of `VerifyInput` and the contract name, as `buildVerifyInput`
 *   returns them.
 * @throws ExplorerVerifyError `incomplete-input` with `details.field` `sources` when an import
 *   resolves to a file the sources do not hold, with each such source unit name in
 *   `details.candidates`, sorted, at most 1000; `invalid-input` for an option that is missing or
 *   of the wrong type, an unknown option, a malformed remapping, remappings passed twice, or a
 *   local path in the contract, a remapping or an import, with a message that names the field and
 *   never the path.
 * @throws Whatever the caller's reader throws, unchanged.
 * @example
 * ```ts
 * import { buildVerifyInputFromSources } from "explorer-verify/sources";
 *
 * const built = await buildVerifyInputFromSources({
 *   contract: "src/Vault.sol:Vault",
 *   compilerVersion: "0.8.24+commit.e11b9ed9",
 *   settings: { optimizer: { enabled: true, runs: 200 } },
 *   remappings: ["@acl/=lib/acl/src/"],
 *   sources: {
 *     "src/Vault.sol":
 *       'import {Ownable} from "@acl/Ownable.sol";\ncontract Vault is Ownable {}\n',
 *     "lib/acl/src/Ownable.sol": "contract Ownable {}\n",
 *   },
 * });
 * console.log(Object.keys(built.compiler.input.sources));
 * // ["lib/acl/src/Ownable.sol", "src/Vault.sol"]
 * ```
 * @experimental
 */
export async function buildVerifyInputFromSources(
  options: BuildFromSourcesOptions,
): Promise<BuiltVerifyInput> {
  const read = readOptions(options);
  const { found, missing } = await collect(read);
  if (missing.length > 0) {
    throw newError(
      {
        code: "incomplete-input",
        field: "sources",
        candidates: missing.toSorted().slice(0, MAX_MISSING),
      },
      `The sources lack ${String(missing.length)} of the files the contract imports.`,
      { hint: SOURCES_HINT, secrets: [] },
    );
  }
  const settings = new Map(read.settings);
  if (read.remappings.length > 0) {
    settings.set("remappings", [...read.remappings]);
  }
  if (!settings.has("outputSelection")) {
    settings.set("outputSelection", OUTPUT_SELECTION);
  }
  const names = [...found.keys()].toSorted();
  return buildVerifyInput(
    [
      {
        language: "Solidity",
        sources: Object.fromEntries(names.map((name) => [name, { content: found.get(name) }])),
        settings: Object.fromEntries(settings),
      },
    ],
    { contract: read.contract, compilerVersion: read.compilerVersion },
  );
}
