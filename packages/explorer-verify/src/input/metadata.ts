// References: R-IN-7.
/**
 * Rebuilding a Standard JSON input from Solidity metadata and source files. The metadata
 * is the JSON whose hash solc appends to the bytecode: it records the language, the compiler
 * version, the settings, the target contract and the keccak-256 hash of every source. Format:
 * https://docs.soliditylang.org/en/v0.8.24/metadata.html.
 */
import { newError } from "../error-hints.ts";
import { hashOf } from "../errors.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import { keccak256 } from "../internal/keccak.ts";
import { readFields } from "../internal/read-fields.ts";

/** The output the rebuilt input asks for: what explorers read back from a compilation. */
export const OUTPUT_SELECTION = {
  "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] },
} as const;
// solc 0.8.2, 0.8.3 and 0.8.4, with or without a leading v.
const INLINER_VERSIONS = /^v?0\.8\.[234](?!\d)/;

const MISMATCH_HINT =
  "Pass the source file exactly as it was compiled, byte for byte, line endings included. The error names the file (details.path) and the hash that the metadata records for it (details.expected).";

/** One source the metadata lists. */
interface MetadataSource {
  /** The source path, a key of the Standard JSON `sources`. */
  path: string;
  /** The keccak-256 hash of the source's UTF-8 bytes, lowercase, as solc recorded it. */
  keccak256: string;
  /** The content, when the metadata embeds it (`useLiteralContent`). */
  content: string | undefined;
}

/** Solidity metadata with every field a rebuild needs. */
export interface SolidityMetadata {
  /** `language`, such as `Solidity`. */
  language: string;
  /** `compiler.version`, the full version. */
  version: string;
  /** `settings`, with `compilationTarget` still in it. */
  settings: Map<string, unknown>;
  /** The `compilationTarget` entries whose name is a string, `path:Name`, in the metadata's order. */
  targets: string[];
  /** `sources`, in the metadata's order. */
  sources: MetadataSource[];
}

/** One source with its content, for {@link checkSourceHashes}. */
export interface SuppliedSource {
  /** The source path. */
  path: string;
  /** The content, from the metadata or from the caller. */
  content: string;
  /** The hash the metadata records, lowercase. */
  expected: string;
}

/** What {@link rebuildInput} returns: the input, and the sources with and without content. */
export interface RebuiltInput {
  /** The Standard JSON input: `language`, `sources` and `settings`. */
  input: { language: string; sources: Record<string, { content: string }>; settings: unknown };
  /** Every source path the metadata lists, in its order, with content or not. */
  paths: string[];
  /** The sources that have content, in the metadata's order. */
  supplied: SuppliedSource[];
  /** The paths of the sources that neither the metadata nor the caller supplied, sorted. */
  missing: string[];
}

/** The fields of a metadata object, or of a metadata JSON string. */
export function readMetadata(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "string") {
    return readFields(value);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return readFields(parsed);
  } catch {
    // Not JSON: no fields.
  }
  return undefined;
}

/**
 * `value` as metadata a Standard JSON input can be rebuilt from: an object or a JSON string with
 * `language`, `compiler.version`, `settings.compilationTarget`, and `sources` whose entries each
 * have a `keccak256` hash. `undefined` when any of these is missing.
 */
export function parseMetadata(value: unknown): SolidityMetadata | undefined {
  const fields = readMetadata(value);
  const language = fields?.get("language");
  const version = readFields(fields?.get("compiler"))?.get("version");
  const settings = readFields(fields?.get("settings"));
  const sourceFields = readFields(fields?.get("sources"));
  if (typeof language !== "string" || typeof version !== "string" || settings === undefined) {
    return undefined;
  }
  const target = readFields(settings.get("compilationTarget"));
  if (target === undefined || sourceFields === undefined) {
    return undefined;
  }
  const sources: MetadataSource[] = [];
  for (const [path, entry] of sourceFields) {
    const source = readFields(entry) ?? new Map<string, unknown>();
    const hash = source.get("keccak256");
    if (typeof hash !== "string") {
      return undefined;
    }
    const content = source.get("content");
    sources.push({
      path,
      keccak256: hash.toLowerCase(),
      content: typeof content === "string" ? content : undefined,
    });
  }
  const targets = [...target].flatMap(([path, name]) =>
    typeof name === "string" ? [`${path}:${name}`] : [],
  );
  return { language, version, settings, targets, sources };
}

/**
 * The source paths and their hashes as one string, sorted by path, so two metadata documents of
 * one build give the same string whatever their order.
 */
export function sourceFingerprint(metadata: SolidityMetadata): string {
  return metadata.sources
    .map(({ path, keccak256: hash }) => `${JSON.stringify(path)}:${hash}`)
    .toSorted()
    .join(",");
}

function invalid(field: string, message: string): ExplorerVerifyError {
  const issues: InputIssue[] = [{ field, message }];
  return newError(
    { code: "invalid-input", issues },
    `The input is invalid: ${field}.`,
    // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent. The message and the issue name only a field, never a key.
    { secrets: [] },
  );
}

/**
 * `settings.libraries` from the metadata form `{ "path:Name": address }` to the Standard JSON form
 * `{ path: { Name: address } }`. solc 0.7.4 and earlier write a bare `Name`; it goes under the
 * empty path, which those versions read as a library of any file.
 */
function convertLibraries(value: unknown): Record<string, Record<string, unknown>> {
  const fields = readFields(value);
  if (fields === undefined) {
    throw invalid("metadata.settings.libraries", "must be an object of addresses by path:Name");
  }
  const byPath = new Map<string, [string, unknown][]>();
  for (const [key, address] of fields) {
    const colon = key.lastIndexOf(":");
    const path = colon === -1 ? "" : key.slice(0, colon);
    const entries = byPath.get(path) ?? [];
    entries.push([key.slice(colon + 1), address]);
    byPath.set(path, entries);
  }
  // Object.fromEntries defines each key as an own property, so a path named __proto__ stays a key.
  return Object.fromEntries(
    [...byPath].map(([path, entries]) => [path, Object.fromEntries(entries)]),
  );
}

/** Whether `version` is solc 0.8.2, 0.8.3 or 0.8.4. */
function recordsInliner(version: string): boolean {
  return INLINER_VERSIONS.test(version);
}

/**
 * `settings.optimizer` as the input needs it. solc 0.8.2 to 0.8.4 write `details.inliner` in the
 * metadata, a key their input parser rejects; in those versions the inliner runs exactly when the
 * optimizer is enabled, so `enabled` takes its value and the key is dropped.
 */
function rebuildOptimizer(value: unknown, version: string): unknown {
  // A value that is not an object has no details, and no inliner.
  const optimizer = readFields(value) ?? new Map<string, unknown>();
  const details = readFields(optimizer.get("details")) ?? new Map<string, unknown>();
  const inliner = details.get("inliner");
  if (inliner === undefined || !recordsInliner(version)) {
    return value;
  }
  details.delete("inliner");
  optimizer.set("details", Object.fromEntries(details));
  optimizer.set("enabled", inliner);
  return Object.fromEntries(optimizer);
}

/**
 * `settings.metadata` as the input needs it. With `appendCBOR: false`, solc still records
 * `bytecodeHash`, which it then rejects in an input, so `bytecodeHash` is dropped. solc 0.5.0 and
 * earlier embed `content` without recording `useLiteralContent`; it is set when a source embeds
 * its content and the metadata does not say.
 */
function rebuildMetadataSettings(value: unknown, literal: boolean): unknown {
  const fields = value === undefined ? new Map<string, unknown>() : readFields(value);
  if (fields === undefined) {
    return value;
  }
  if (fields.get("appendCBOR") === false) {
    fields.delete("bytecodeHash");
  }
  if (literal && !fields.has("useLiteralContent")) {
    fields.set("useLiteralContent", true);
  }
  return fields.size === 0 ? undefined : Object.fromEntries(fields);
}

/**
 * The Standard JSON input that produced the bytecode the metadata describes. `language` comes from
 * the metadata. `settings` copies every metadata setting (`optimizer`, `evmVersion`,
 * `remappings`, `metadata`, `viaIR`, `debug` and any later one) except `compilationTarget`,
 * converts `libraries` to the Standard JSON form, and adds an `outputSelection` for the ABI, the
 * bytecode and the metadata. Two settings are adjusted so the compiler accepts them: see
 * {@link rebuildOptimizer} and {@link rebuildMetadataSettings}. Each source takes the metadata's
 * `content` when present, else `provided[path]`, so embedded content wins; a source with neither
 * is listed in `missing`.
 */
export function rebuildInput(
  metadata: SolidityMetadata,
  provided: ReadonlyMap<string, string>,
): RebuiltInput {
  const literal = metadata.sources.some(({ content }) => content !== undefined);
  const settings: [string, unknown][] = [];
  for (const [name, value] of metadata.settings) {
    if (name === "libraries") {
      settings.push([name, convertLibraries(value)]);
    } else if (name === "optimizer") {
      settings.push([name, rebuildOptimizer(value, metadata.version)]);
    } else if (name !== "compilationTarget" && name !== "metadata") {
      settings.push([name, value]);
    }
  }
  const metadataSettings = rebuildMetadataSettings(metadata.settings.get("metadata"), literal);
  if (metadataSettings !== undefined) {
    settings.push(["metadata", metadataSettings]);
  }
  settings.push(["outputSelection", OUTPUT_SELECTION]);
  const supplied: SuppliedSource[] = [];
  const missing: string[] = [];
  for (const { path, content, keccak256: expected } of metadata.sources) {
    const text = content ?? provided.get(path);
    if (text === undefined) {
      missing.push(path);
    } else {
      supplied.push({ path, content: text, expected });
    }
  }
  return {
    input: {
      language: metadata.language,
      sources: Object.fromEntries(supplied.map(({ path, content }) => [path, { content }])),
      settings: Object.fromEntries(settings),
    },
    paths: metadata.sources.map(({ path }) => path),
    supplied,
    missing: missing.toSorted(),
  };
}

/**
 * Hashes each source's UTF-8 bytes with keccak-256 and compares the hash with the metadata's.
 * Throws `source-mismatch` for the first source, in the metadata's order, that differs.
 */
export function checkSourceHashes(supplied: readonly SuppliedSource[]): void {
  const encoder = new TextEncoder();
  for (const { path, content, expected } of supplied) {
    const actual = keccak256(encoder.encode(content));
    if (actual !== expected) {
      throw newError(
        {
          code: "source-mismatch",
          path,
          // `0x` when the metadata records a hash that is not `0x` and 64 lowercase hex digits.
          expected: hashOf(expected),
          actual: `0x${actual.slice(2)}`,
        },
        "A source file does not match the keccak-256 hash the metadata records for it.",
        { hint: MISMATCH_HINT, secrets: [] },
      );
    }
  }
}
