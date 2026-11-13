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

/** The index after the comment that starts at `at`, or `at` when none starts there. */
function skipComment(text: string, at: number): number {
  if (text.startsWith("//", at)) {
    const end = text.indexOf("\n", at);
    return end === -1 ? text.length : end + 1;
  }
  if (text.startsWith("/*", at)) {
    const end = text.indexOf("*/", at + 2);
    return end === -1 ? text.length : end + 2;
  }
  return at;
}

/** The character a `\x..` or `\u....` escape gives, or `undefined` when its digits are not hex. */
function hexEscape(digits: string): string | undefined {
  return HEX_DIGITS.test(digits) ? String.fromCharCode(Number.parseInt(digits, 16)) : undefined;
}

/**
 * Reads the string literal whose opening quote is at `at`. The value has its escapes decoded; a
 * literal cut off by a line break or the end of the text ends there.
 */
function readString(text: string, at: number): { value: string; end: number } {
  const quote = text.charAt(at);
  let value = "";
  let index = at + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === quote) {
      return { value, end: index + 1 };
    }
    if (char === "\n") {
      break;
    }
    if (char === "\\") {
      const next = text.charAt(index + 1);
      const width = next === "x" ? 2 : next === "u" ? 4 : 0;
      const decoded =
        width > 0
          ? hexEscape(text.slice(index + 2, index + 2 + width))
          : (SIMPLE_ESCAPES[next] ?? next);
      value += decoded ?? next;
      index += decoded === undefined ? 2 : 2 + width;
      continue;
    }
    value += char;
    index++;
  }
  return { value, end: index };
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
 * segment), against the directory of `importer`, as solc resolves it: each `.` is skipped and
 * each `..` removes the last segment, never above the root. Any other path is returned as it is.
 */
function absolutePath(path: string, importer: string): string {
  const segments = path.split("/");
  if (segments[0] !== "." && segments[0] !== "..") {
    return path;
  }
  const result = importer.split("/").slice(0, -1);
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
