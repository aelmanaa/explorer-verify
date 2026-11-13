// References: R-IN-7.
/**
 * Solidity import directives and solc's import path resolution, for the sources builder.
 * Internal: not exported from any entry point.
 */

/** A remapping, `context:prefix=target`, split as solc splits it. */
export interface Remapping {
  readonly context: string;
  readonly prefix: string;
  readonly target: string;
}

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const HEX_DIGITS = /^[0-9a-fA-F]+$/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };
const LINE_END = /[\n\r]/;
const UTF8 = new TextEncoder();

/** The index after the comment that starts at `at`, or `at` when none starts there. */
function skipComment(text: string, at: number): number {
  if (text.startsWith("//", at)) {
    // solc's scanner ends a line comment at LF or at CR.
    const rest = text.slice(at).search(LINE_END);
    return rest === -1 ? text.length : at + rest + 1;
  }
  if (text.startsWith("/*", at)) {
    const end = text.indexOf("*/", at + 2);
    return end === -1 ? text.length : end + 2;
  }
  return at;
}

/** The value of `width` hex digits at `at`, or `undefined` when they are not all hex digits. */
function hexValue(text: string, at: number, width: number): number | undefined {
  const digits = text.slice(at, at + width);
  return digits.length === width && HEX_DIGITS.test(digits)
    ? Number.parseInt(digits, 16)
    : undefined;
}

/**
 * The bytes one escape adds, from the backslash at `at`, and the escape's length. As in solc
 * 0.8.24: `\xNN` is one byte, `\uNNNN` the UTF-8 of the code point, a backslash before a line
 * break (LF, CR or CRLF) adds nothing, and any other character stands for itself.
 */
function readEscape(text: string, at: number): { bytes: Uint8Array; length: number } {
  const next = text.charAt(at + 1);
  if (next === "\r") {
    return { bytes: new Uint8Array(), length: text.startsWith("\n", at + 2) ? 3 : 2 };
  }
  if (next === "\n") {
    return { bytes: new Uint8Array(), length: 2 };
  }
  if (next === "x" || next === "u") {
    const width = next === "x" ? 2 : 4;
    const value = hexValue(text, at + 2, width);
    if (value !== undefined) {
      const bytes = next === "x" ? Uint8Array.of(value) : UTF8.encode(String.fromCodePoint(value));
      return { bytes, length: 2 + width };
    }
  }
  return { bytes: UTF8.encode(SIMPLE_ESCAPES[next] ?? next), length: 2 };
}

/**
 * Reads the string literal whose opening quote is at `at`. The value has its escapes decoded and
 * its bytes read as UTF-8; a literal cut off by a line break or the end of the text ends there.
 */
function readString(text: string, at: number): { value: string; end: number } {
  const quote = text.charAt(at);
  const bytes: number[] = [];
  let index = at + 1;
  let end = text.length;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === quote) {
      end = index + 1;
      break;
    }
    if (LINE_END.test(char)) {
      end = index;
      break;
    }
    if (char === "\\") {
      const escape = readEscape(text, index);
      bytes.push(...escape.bytes);
      index += escape.length;
      continue;
    }
    // One code point at a time, so a surrogate pair stays whole.
    const point = String.fromCodePoint(text.codePointAt(index) ?? 0);
    bytes.push(...UTF8.encode(point));
    index += point.length;
  }
  return { value: new TextDecoder().decode(Uint8Array.from(bytes)), end };
}

/**
 * The path of the import directive whose `import` keyword ends at `at`: the first string literal
 * before the `;` that ends the directive, comments skipped. `end` is the index after that `;`.
 */
function readDirective(text: string, at: number): { path: string | undefined; end: number } {
  let path: string | undefined;
  let index = at;
  while (index < text.length) {
    const after = skipComment(text, index);
    if (after !== index) {
      index = after;
      continue;
    }
    const char = text.charAt(index);
    if (char === ";") {
      return { path, end: index + 1 };
    }
    if (char === '"' || char === "'") {
      const literal = readString(text, index);
      path ??= literal.value;
      index = literal.end;
      continue;
    }
    index++;
  }
  return { path, end: index };
}

/**
 * The import paths of a Solidity source, in order, as written: the path of each of the four
 * forms, `import "p";`, `import "p" as A;`, `import * as A from "p";` and
 * `import {a, b as c} from "p";`. An `import` inside a comment or a string literal is not one.
 *
 * @param source - The content of a Solidity source file.
 * @returns The import paths, each once, in the order they first appear.
 */
export function importPaths(source: string): string[] {
  const paths = new Set<string>();
  let index = 0;
  while (index < source.length) {
    const after = skipComment(source, index);
    if (after !== index) {
      index = after;
      continue;
    }
    const char = source.charAt(index);
    if (char === '"' || char === "'") {
      index = readString(source, index).end;
      continue;
    }
    if (!IDENTIFIER_START.test(char)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < source.length && IDENTIFIER_PART.test(source.charAt(end))) {
      end++;
    }
    if (source.slice(index, end) === "import") {
      const directive = readDirective(source, end);
      if (directive.path !== undefined) {
        paths.add(directive.path);
      }
      end = directive.end;
    }
    index = end;
  }
  return [...paths];
}

/**
 * A remapping string split as solc splits it: `context:prefix=target`, where the context is
 * optional. `undefined` when it has no `=` or an empty prefix, which solc refuses.
 *
 * @param remapping - The remapping string.
 * @returns The parts, or `undefined`.
 */
export function parseRemapping(remapping: string): Remapping | undefined {
  const equals = remapping.indexOf("=");
  if (equals === -1) {
    return undefined;
  }
  const left = remapping.slice(0, equals);
  const colon = left.indexOf(":");
  const prefix = colon === -1 ? left : left.slice(colon + 1);
  if (prefix === "") {
    return undefined;
  }
  return {
    context: colon === -1 ? "" : left.slice(0, colon),
    prefix,
    target: remapping.slice(equals + 1),
  };
}

/**
 * The source unit name of `path` when it is relative (starts with `.` or `..` as its first
 * segment), against the directory of `importer`, as solc's `util::absolutePath` resolves it with
 * Boost paths: empty segments of the importer's directory and of the path are dropped, each `.`
 * is skipped and each `..` removes the last segment, never above the root. Any other path is
 * returned as it is.
 */
function absolutePath(path: string, importer: string): string {
  const segments = path.split("/");
  if (segments[0] !== "." && segments[0] !== "..") {
    return path;
  }
  // The importer without its file name, which is empty when the importer ends in `/`.
  const result = importer
    .split("/")
    .slice(0, -1)
    .filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "..") {
      result.pop();
    } else if (segment !== "." && segment !== "") {
      result.push(segment);
    }
  }
  return result.join("/");
}

/**
 * The source unit name solc gives the import `path` in the source unit `importer`. A relative
 * path is resolved against the importer's directory first. Then the remapping whose context is a
 * prefix of `importer` and whose prefix is a prefix of the path applies: the longest context
 * wins, then the longest prefix, then the last one listed.
 *
 * @param path - The import path as written.
 * @param importer - The source unit name of the importing file.
 * @param remappings - The remappings, in the order given.
 * @returns The source unit name.
 */
export function resolveImport(
  path: string,
  importer: string,
  remappings: readonly Remapping[],
): string {
  const name = absolutePath(path, importer);
  let longestContext = 0;
  let longestPrefix = 0;
  let best: Remapping | undefined;
  for (const remapping of remappings) {
    const { context, prefix } = remapping;
    if (
      context.length < longestContext ||
      !importer.startsWith(context) ||
      (prefix.length < longestPrefix && context.length === longestContext) ||
      !name.startsWith(prefix)
    ) {
      continue;
    }
    longestContext = context.length;
    longestPrefix = prefix.length;
    best = remapping;
  }
  return best === undefined ? name : best.target + name.slice(best.prefix.length);
}
