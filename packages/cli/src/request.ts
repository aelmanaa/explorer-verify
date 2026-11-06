/**
 * Reads what `verify` and `status` work on: the JSON files of `--input`, and the whole request of
 * `--input-json <file|->` (R-AX-16), checked against the shape of the core package's
 * `input.schema.json`. Unknown properties are one issue that counts them and never names them,
 * as `parseHandle` does (decision 0009).
 *
 * No issue repeats a path, a file's contents or a value: a path or a value typed by mistake can be
 * a key (R-AX-9). An issue names the option, and the position of a repeated option's value.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { InputIssue } from "explorer-verify";

import type { OptionValue } from "./arguments.ts";
import { usageError } from "./command.ts";
import { stdinConflict } from "./keys.ts";
import type { InputStream } from "./keys.ts";

/** The most bytes read from one `--input` file or from `--input-json`: 64 MiB. */
export const MAX_JSON_BYTES: number = 64 * 1024 * 1024;

/** The options that may accompany `--input-json` (R-AX-16), besides help and the version. */
const INPUT_JSON_COMPANIONS: readonly string[] = [
  "input-json",
  "json",
  "log-format",
  "quiet",
  "verbose",
  "color",
  "dry-run",
  "allow-sourcify-fallback",
  "api-key-file",
  "api-key-stdin",
  "rpc-url",
  "rpc-url-file",
  "rpc-url-stdin",
  "timeout",
  "poll-interval",
];

/** A JSON value read from a file or stdin, or the issue that stopped it. */
export type ReadJson = { readonly value: unknown } | { readonly issue: InputIssue };

/** Thrown when a path is not a regular file; `folder` says whether it is a folder. */
class NotRegularFile extends Error {
  readonly folder: boolean;
  constructor(folder: boolean) {
    super("not a regular file");
    this.folder = folder;
  }
}

/** The issue message of a path that names a folder. */
export const FOLDER_MESSAGE = "must name a regular file, not a folder";

/** Thrown when a file or stdin holds more than {@link MAX_JSON_BYTES}. */
class TooLarge extends Error {}

/**
 * `message` with the `code` of a Node system error, such as `ENOENT`, when it has one. The error's
 * message is dropped: it holds the path.
 */
function withCode(message: string, error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) {
      return `${message} (${code})`;
    }
  }
  return message;
}

/**
 * The text of a regular file of at most `limit` bytes. The file is opened without blocking, so a
 * FIFO with no writer cannot hang the run, and anything but a regular file is refused.
 */
async function readFileText(path: string, limit: number): Promise<string> {
  // `O_NONBLOCK` is undefined on Windows, where `| undefined` adds no flag.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new NotRegularFile(stat.isDirectory());
    }
    if (stat.size > limit) {
      throw new TooLarge();
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** The text of a stream, refused once it passes `limit` bytes. */
async function readStreamText(stream: InputStream, limit: number): Promise<string> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = "";
  let size = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("stdin gave a chunk that is neither text nor bytes");
    }
    size += bytes.byteLength;
    if (size > limit) {
      throw new TooLarge();
    }
    text += decoder.decode(bytes, { stream: true });
  }
  return text + decoder.decode();
}

/** Parses `text` as JSON, or gives an issue that never repeats the text. */
function parsed(text: string, field: string): ReadJson {
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return { issue: { field, message: "is not valid JSON" } };
  }
}

/** The issue of a read that failed. */
function readIssue(error: unknown, field: string, unreadable: string): InputIssue {
  if (error instanceof NotRegularFile) {
    return { field, message: error.folder ? FOLDER_MESSAGE : "must name a regular file" };
  }
  if (error instanceof TooLarge) {
    return { field, message: `must be at most ${String(MAX_JSON_BYTES / 1024 / 1024)} MiB` };
  }
  return { field, message: withCode(unreadable, error) };
}

/**
 * Reads and parses one JSON file.
 *
 * @param path - The path, as the option gave it.
 * @param field - What issues name, such as `--input[2]`.
 * @param limit - The most bytes to read.
 * @returns The parsed value, or the issue.
 */
export async function readJsonFile(
  path: string,
  field: string,
  limit: number = MAX_JSON_BYTES,
): Promise<ReadJson> {
  let text: string;
  try {
    text = await readFileText(path, limit);
  } catch (error) {
    return { issue: readIssue(error, field, "names a file that cannot be read") };
  }
  return parsed(text, field);
}

/**
 * Reads and parses the JSON piped on stdin. The CLI never prompts (R-AX-6), so a terminal on
 * stdin is an issue at once, before any read.
 *
 * @param stdin - Opens stdin.
 * @param field - What issues name.
 * @param limit - The most bytes to read.
 * @returns The parsed value, or the issue.
 */
export async function readJsonStdin(
  stdin: () => InputStream,
  field: string,
  limit: number = MAX_JSON_BYTES,
): Promise<ReadJson> {
  const stream = stdin();
  if (stream.isTTY === true) {
    return { issue: { field, message: "needs the JSON piped on stdin, and stdin is a terminal" } };
  }
  let text: string;
  try {
    text = await readStreamText(stream, limit);
  } catch (error) {
    return { issue: readIssue(error, field, "could not be read from stdin") };
  }
  return parsed(text, field);
}

/** The fields of a JSON object, or `undefined` for any other value. */
function objectFields(value: unknown): Map<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Map<string, unknown>(Object.entries(value))
    : undefined;
}

/** The request `--input-json` gave, split into its parts. */
export interface JsonRequest {
  /** The request's fields other than `route`, for the command to check. */
  readonly fields: ReadonlyMap<string, unknown>;
  /** The option values to run with: the command line's, plus `backend` and `api-url` of `route`. */
  readonly values: ReadonlyMap<string, OptionValue>;
  /**
   * The request field behind each option that `route` filled, such as `--backend` to
   * `route.backend`, so an issue about it names the field the caller wrote.
   */
  readonly fieldNames: ReadonlyMap<string, string>;
}

/** What {@link readJsonRequest} needs to know of the command. */
export interface JsonRequestSpec {
  /** The command's name, for the issues. */
  readonly command: string;
  /** The request fields the command reads, besides `route`. */
  readonly fields: readonly string[];
  /** The fields of nested objects the schema closes, such as `compiler`, by field name. */
  readonly nested?: Readonly<Record<string, readonly string[]>>;
}

/** The route fields of a request, and the option each one fills. */
export const ROUTE_FIELDS: readonly (readonly [field: string, option: string])[] = [
  ["backend", "backend"],
  ["apiUrl", "api-url"],
];

/** Counts the keys of `fields` that are not in `known`. */
function unknownCount(fields: ReadonlyMap<string, unknown>, known: readonly string[]): number {
  let count = 0;
  for (const name of fields.keys()) {
    if (!known.includes(name)) {
      count += 1;
    }
  }
  return count;
}

/** Checks the options given with `--input-json`: only those of R-AX-16, and no positional. */
function companionIssues(
  values: ReadonlyMap<string, OptionValue>,
  positionals: readonly string[],
  command: string,
): InputIssue[] {
  const issues: InputIssue[] = [];
  for (const name of values.keys()) {
    if (!INPUT_JSON_COMPANIONS.includes(name) && name !== "help" && name !== "version") {
      issues.push({
        field: `--${name}`,
        message: "cannot be combined with --input-json: put it in the request instead",
      });
    }
  }
  if (positionals.length > 0) {
    issues.push({ field: command, message: "takes no arguments with --input-json" });
  }
  return issues;
}

/**
 * Reads the request of `--input-json <file|->` (R-AX-16) and checks its shape:
 *
 * - Only the options of {@link INPUT_JSON_COMPANIONS} may accompany it, and no positional.
 * - `-` reads stdin, refused with `--api-key-stdin` or `--rpc-url-stdin` and when stdin is a
 *   terminal.
 * - The request is a JSON object with the command's fields and an optional `route` of `backend`
 *   and `apiUrl`, both strings. Their values fill `--backend` and `--api-url`, which the keys then
 *   follow.
 * - Unknown properties, at the top, in `route` and in the nested objects the spec closes, are one
 *   issue with their count, never their names.
 *
 * The command checks the fields' values itself, as the library does.
 *
 * @param source - The value of `--input-json`, the option values, the positionals and stdin.
 * @param spec - The command's request fields.
 * @returns The request's fields and the option values to run with.
 * @throws ExplorerVerifyError `invalid-input` with every issue found.
 */
export async function readJsonRequest(
  source: {
    readonly path: string;
    readonly values: ReadonlyMap<string, OptionValue>;
    readonly positionals: readonly string[];
    readonly stdin: () => InputStream;
  },
  spec: JsonRequestSpec,
): Promise<JsonRequest> {
  const field = "--input-json";
  const early = companionIssues(source.values, source.positionals, spec.command);
  const conflict = stdinConflict(source.values);
  if (conflict !== undefined) {
    early.push(conflict);
  }
  if (early.length > 0) {
    throw usageError(early);
  }
  const read =
    source.path === "-"
      ? await readJsonStdin(source.stdin, field)
      : await readJsonFile(source.path, field);
  if ("issue" in read) {
    throw usageError([read.issue]);
  }
  const fields = objectFields(read.value);
  if (fields === undefined) {
    throw usageError([{ field, message: `must be a JSON object: the ${spec.command} request` }]);
  }
  const issues: InputIssue[] = [];
  let unknown = unknownCount(fields, [...spec.fields, "route"]);
  for (const [name, known] of Object.entries(spec.nested ?? {})) {
    const nested = objectFields(fields.get(name));
    if (nested !== undefined) {
      unknown += unknownCount(nested, known);
    }
  }
  const values = new Map(source.values);
  const fieldNames = new Map<string, string>();
  const routeValue = fields.get("route");
  if (routeValue !== undefined) {
    const route = objectFields(routeValue);
    if (route === undefined) {
      issues.push({ field: "route", message: "must be an object with backend and apiUrl" });
    } else {
      unknown += unknownCount(
        route,
        ROUTE_FIELDS.map(([name]) => name),
      );
      for (const [name, option] of ROUTE_FIELDS) {
        const value = route.get(name);
        if (typeof value === "string") {
          values.set(option, value);
          fieldNames.set(`--${option}`, `route.${name}`);
        } else if (value !== undefined) {
          issues.push({ field: `route.${name}`, message: "must be a string" });
        }
      }
    }
  }
  if (unknown > 0) {
    issues.push({
      field,
      message:
        unknown === 1
          ? "has 1 property that is not a request field"
          : `has ${String(unknown)} properties that are not request fields`,
    });
  }
  if (issues.length > 0) {
    throw usageError(issues);
  }
  const rest = new Map(fields);
  rest.delete("route");
  return { fields: rest, values, fieldNames };
}
