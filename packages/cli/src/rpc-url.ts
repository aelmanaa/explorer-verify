/**
 * The JSON-RPC endpoint of `verify` (R-IN-3, R-AX-9, R-SEC-1): `VerifyOptions.rpcUrl`, which the
 * library reads the creation transaction from to derive missing constructor arguments. Providers
 * put keys in the URL's path or query, so the URL follows the key rules of decision 0016 as far as
 * a URL can:
 *
 * - `--rpc-url <url>` takes only a URL with no part that can hold a key: no path segment or query
 *   value of 8 or more characters, and no user name or password. A flag value shows in the process
 *   list and the shell history.
 * - `--rpc-url-file <path>` and `--rpc-url-stdin` take any URL, with one trailing newline removed.
 * - No environment variable and no field of `--input-json` holds it.
 *
 * Every part that can hold a key joins the run's secrets before the URL is checked, so the CLI
 * removes it from stdout and stderr. No issue repeats the URL, a part of it or a file's path.
 */
import type { InputIssue } from "explorer-verify";

import type { OptionSpecs, OptionValue } from "./arguments.ts";
import { stringOption } from "./command.ts";
import {
  NotRegularFile,
  readFileStart,
  readLimited,
  stdinConflict,
  trimNewline,
  withCode,
} from "./keys.ts";
import type { InputStream } from "./keys.ts";

/** The longest URL accepted, the library's limit for `rpcUrl`. */
const MAX_URL_LENGTH = 8192;

/** The most bytes read from a file or stdin: the longest URL, a CRLF and one more. */
const READ_LIMIT = MAX_URL_LENGTH + 3;

/** The shortest part of a URL that counts as a key, the library's redaction floor. */
const MIN_SECRET_LENGTH = 8;

/**
 * The characters RFC 3986 allows in a URL. Each is written as it is by JSON and by the text
 * lines, so the scrubber finds every copy of a part.
 */
const URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** The options of `verify` that give the RPC URL. */
export const RPC_URL_OPTIONS: OptionSpecs = {
  "rpc-url": {
    type: "string",
    value: "<url>",
    description:
      "A JSON-RPC endpoint of the chain, to derive the constructor arguments with --creation-tx. Refused when a part can hold a key; use --rpc-url-file or --rpc-url-stdin then.",
  },
  "rpc-url-file": {
    type: "string",
    value: "<path>",
    description:
      "Read the JSON-RPC endpoint URL from this regular file. Use it for a URL with a key.",
  },
  "rpc-url-stdin": {
    type: "boolean",
    description: "Read the JSON-RPC endpoint URL piped on stdin. Use it for a URL with a key.",
  },
};

/** The issue message of `--rpc-url` with a part that can hold a key. It never repeats the URL. */
const KEY_IN_FLAG_MESSAGE =
  "has a part that can hold a key, and a flag value shows in the process list and the shell history; use --rpc-url-file or --rpc-url-stdin";

/** What {@link readRpcUrl} found: the URL to pass as `rpcUrl`, or the issues. */
export type ReadRpcUrl =
  | { readonly rpcUrl: string | undefined; readonly issues?: undefined }
  | { readonly issues: readonly InputIssue[] };

/** Where {@link readRpcUrl} reads from, and where it puts the secrets. */
export interface RpcUrlSources {
  /** The checked option values, by long name. */
  readonly values: ReadonlyMap<string, OptionValue>;
  /** Opens stdin. Called only for `--rpc-url-stdin`. */
  readonly stdin: () => InputStream;
  /** Receives the parts of the URL that can hold a key, before any check. */
  readonly addSecrets: (secrets: readonly string[]) => void;
}

/** `text` decoded, or as it is when it is not valid percent-encoding. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The pieces of a query: each name and each value, split at `&` and `=`. */
function queryPieces(query: string): string[] {
  return query === "" ? [] : query.split(/[&=]/);
}

/**
 * The parts of `text` as typed, without parsing it as a URL: the user name and password, the
 * path segments, the query names and values, and the fragment. The URL parser percent-encodes
 * some characters, so the typed form can differ from the parsed one.
 */
function typedParts(text: string): string[] {
  const hashAt = text.indexOf("#");
  const beforeHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : text.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  const schemeEnd = pathPart.indexOf("://");
  const afterScheme = schemeEnd === -1 ? pathPart : pathPart.slice(schemeEnd + 3);
  const slash = afterScheme.indexOf("/");
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const path = slash === -1 ? "" : afterScheme.slice(slash);
  const at = authority.lastIndexOf("@");
  const userInfo = at === -1 ? [] : authority.slice(0, at).split(":");
  return [...userInfo, ...path.split("/"), ...queryPieces(query), fragment];
}

/**
 * The parts of a URL that can hold a key: the user name, the password, each path segment, each
 * query name and value and the fragment, as typed, as parsed and decoded, of 8 or more
 * characters. The host name does not count.
 *
 * @param text - The URL.
 * @returns The parts, each once.
 * @example
 * ```ts
 * rpcUrlSecrets("https://rpc.example.org/v2/abcdef0123456789"); // ["abcdef0123456789"]
 * ```
 */
export function rpcUrlSecrets(text: string): string[] {
  const parts = typedParts(text);
  try {
    const url = new URL(text);
    parts.push(
      url.username,
      url.password,
      ...url.pathname.split("/"),
      ...queryPieces(url.search.slice(1)),
      ...url.searchParams.keys(),
      ...url.searchParams.values(),
      url.hash.slice(1),
    );
  } catch {
    // Not a URL: the typed parts are all there is.
  }
  const found = new Set<string>();
  for (const part of parts) {
    for (const each of [part, decoded(part)]) {
      if (each.length >= MIN_SECRET_LENGTH) {
        found.add(each);
      }
    }
  }
  return [...found];
}

/** What is wrong with the text of a URL before the library checks it, or `undefined`. */
function textProblem(text: string): string | undefined {
  if (text.length > MAX_URL_LENGTH) {
    return `must be at most ${String(MAX_URL_LENGTH)} characters`;
  }
  if (!URL_CHARACTERS.test(text)) {
    return "must hold only the characters a URL allows, with no space or quote";
  }
  return undefined;
}

/** The URL of a file or stdin, checked; its parts that can hold a key join the secrets first. */
function checked(field: string, text: string, sources: RpcUrlSources): ReadRpcUrl {
  const url = trimNewline(text);
  if (url === "") {
    return { issues: [{ field, message: "gave an empty URL" }] };
  }
  sources.addSecrets(rpcUrlSecrets(url));
  const problem = textProblem(url);
  return problem === undefined ? { rpcUrl: url } : { issues: [{ field, message: problem }] };
}

/** Reads the URL piped on stdin. */
async function fromStdin(sources: RpcUrlSources): Promise<ReadRpcUrl> {
  const field = "--rpc-url-stdin";
  const conflict = stdinConflict(sources.values);
  if (conflict !== undefined) {
    return { issues: [conflict] };
  }
  const stdin = sources.stdin();
  if (stdin.isTTY === true) {
    // The CLI never prompts (R-AX-6), so a terminal on stdin is an error, not a wait.
    return {
      issues: [{ field, message: "needs the URL piped on stdin, and stdin is a terminal" }],
    };
  }
  let text: string;
  try {
    text = await readLimited(stdin, READ_LIMIT);
  } catch (error) {
    return { issues: [{ field, message: withCode("could not read stdin", error) }] };
  }
  return checked(field, text, sources);
}

/** Reads the URL in a regular file. */
async function fromFile(path: string, sources: RpcUrlSources): Promise<ReadRpcUrl> {
  const field = "--rpc-url-file";
  let text: string;
  try {
    text = await readFileStart(path, READ_LIMIT);
  } catch (error) {
    const message =
      error instanceof NotRegularFile
        ? "must name a regular file; pipe the URL with --rpc-url-stdin"
        : withCode("names a file that cannot be read", error);
    return { issues: [{ field, message }] };
  }
  return checked(field, text, sources);
}

/**
 * Reads the RPC URL of `verify` from `--rpc-url`, `--rpc-url-file` or `--rpc-url-stdin`:
 *
 * - None of them: no `rpcUrl`.
 * - More than one: an issue.
 * - `--rpc-url` with a part that can hold a key: an issue that points to the other two.
 * - A file or stdin: one trailing newline removed; an empty URL is an issue. `--rpc-url-stdin`
 *   with `--api-key-stdin` or `--input-json -`, or with stdin a terminal, is an issue at once.
 * - Any source: a URL longer than 8192 characters, or with a character a URL does not allow, is an
 *   issue. The library checks the rest: the scheme, the host, and no user name, password or
 *   fragment.
 *
 * @param sources - The option values, stdin and the secret sink.
 * @returns The URL, or the issues, each naming the option.
 */
export async function readRpcUrl(sources: RpcUrlSources): Promise<ReadRpcUrl> {
  const { values } = sources;
  const flag = stringOption(values, "rpc-url");
  const file = stringOption(values, "rpc-url-file");
  const stdin = values.get("rpc-url-stdin") === true;
  if (flag !== undefined) {
    sources.addSecrets(rpcUrlSecrets(flag));
  }
  const given = [
    ...(flag === undefined ? [] : ["--rpc-url"]),
    ...(file === undefined ? [] : ["--rpc-url-file"]),
    ...(stdin ? ["--rpc-url-stdin"] : []),
  ];
  const [first, second] = given;
  if (first === undefined) {
    return { rpcUrl: undefined };
  }
  if (second !== undefined) {
    return { issues: [{ field: second, message: `cannot be combined with ${first}` }] };
  }
  if (flag !== undefined) {
    const problem =
      textProblem(flag) ?? (rpcUrlSecrets(flag).length > 0 ? KEY_IN_FLAG_MESSAGE : undefined);
    return problem === undefined
      ? { rpcUrl: flag }
      : { issues: [{ field: "--rpc-url", message: problem }] };
  }
  return file === undefined ? await fromStdin(sources) : await fromFile(file, sources);
}
