/**
 * API keys and the route options of a command (R-AX-9, R-RT-2, R-SEC-1, R-SEC-2, decision 0016).
 * A key comes from an environment variable, from `--api-key-file` or from `--api-key-stdin`, and
 * never from a flag value. The library binds each key to its backend's host; this module only
 * reads the keys and the route flags and turns them into `VerifyOptions.apiKeys` and
 * `VerifyOptions.route`.
 *
 * No issue repeats a key, a file's contents or a file's path: a path typed by mistake can be a key.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { BACKEND_NAMES, ERROR_CODES, toBackendName } from "explorer-verify";
import type { BackendName, InputIssue, RouteOverride, VerifyOptions } from "explorer-verify";

import type { OptionSpecs, OptionValue } from "./arguments.ts";
import type { OutputStream } from "./stderr.ts";
import type { Environment } from "./terminal.ts";

/** The environment variables the CLI reads keys from, and the backend each one fills. */
export const KEY_VARIABLES: readonly { readonly name: string; readonly backend: BackendName }[] = [
  { name: "ETHERSCAN_API_KEY", backend: "etherscan-v2" },
  { name: "ROUTESCAN_API_KEY", backend: "routescan" },
];

/** The options of a command that talks to an explorer (R-AX-9, R-RT-2). */
export const ROUTE_OPTIONS: OptionSpecs = {
  backend: {
    type: "string",
    value: "<name>",
    once: true,
    description: `Use this backend instead of the routing table's: ${BACKEND_NAMES.join(", ")}.`,
  },
  "api-url": {
    type: "string",
    value: "<url>",
    description: "Use this explorer API URL instead of the routing table's.",
  },
  "api-key-file": {
    type: "string",
    value: "<path>",
    description:
      "Read one API key from this regular file. Needs --backend, or --api-url with --backend.",
  },
  "api-key-stdin": {
    type: "boolean",
    description: "Read one API key piped on stdin. Needs --backend, or --api-url with --backend.",
  },
};

/**
 * Options that look like they take a key. Each is refused wherever it appears, and the argument
 * after it is taken as its value, so the key never becomes a positional.
 */
export const REFUSED_KEY_OPTIONS: readonly string[] = [
  "api-key",
  "apikey",
  "api_key",
  "key",
  "etherscan-api-key",
  "etherscan-key",
  "routescan-api-key",
];

/** The issue message of a refused key option. It never repeats the value. */
export const REFUSED_KEY_MESSAGE: string = `is not accepted: a key on the command line shows in the process list and the shell history; set ${KEY_VARIABLES.map(({ name }) => name).join(" or ")}, or use --api-key-file <path> or --api-key-stdin`;

/** The backends whose key `--api-key-file` or `--api-key-stdin` can give with `--backend` alone. */
const FLAG_KEY_BACKENDS: readonly BackendName[] = KEY_VARIABLES.map(({ backend }) => backend);

/** The backends that take a key: those of {@link FLAG_KEY_BACKENDS}, and standalone explorers. */
const ROUTE_KEY_BACKENDS: readonly BackendName[] = [...FLAG_KEY_BACKENDS, "etherscan-compatible"];

// The key rules of decision 0016, which the library applies to `apiKeys` and `route.apiKey`. The
// CLI checks them first so that an issue names the variable or the flag the key came from.
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 1024;
const ALLOWED = /^[A-Za-z0-9._~-]+$/;

/** The most bytes read from a key file or stdin: the longest key, a CRLF and one more. */
const READ_LIMIT = MAX_KEY_LENGTH + 3;

/** A stream the CLI may read, such as `process.stdin`. */
export interface InputStream {
  /** Whether the stream is a terminal. */
  readonly isTTY?: boolean | undefined;
  /** Yields the stream's chunks: strings or bytes. */
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

/**
 * The part of `VerifyOptions` that the route options and the keys fill, and the backends of a
 * repeated `--backend`, for `verifyEach()`.
 */
export type RouteOptions = Pick<VerifyOptions, "apiKeys" | "route"> & {
  readonly backends?: readonly BackendName[];
};

/** What {@link readRouteOptions} found. */
export interface ReadRouteOptions {
  /** The options to pass to the library, or `undefined` when there are issues. */
  readonly options: RouteOptions | undefined;
  /** Every key read, valid or not, for redaction (R-SEC-1). */
  readonly secrets: readonly string[];
  /** One issue per problem. Each names a variable or a flag, never a value. */
  readonly issues: readonly InputIssue[];
}

/** Where {@link readRouteOptions} reads from. */
export interface RouteSources {
  /** The checked option values, by long name. */
  readonly values: ReadonlyMap<string, OptionValue>;
  /** The environment variables. */
  readonly env: Environment;
  /** Opens stdin. Called only for `--api-key-stdin`. */
  readonly stdin: () => InputStream;
}

/**
 * What is wrong with a key, as decision 0016 sets the rules, or `undefined` when it is valid.
 *
 * @param key - The key.
 * @returns The issue message, which never repeats the key.
 */
export function keyProblem(key: string): string | undefined {
  if (key.length < MIN_KEY_LENGTH) {
    return `must be at least ${String(MIN_KEY_LENGTH)} characters`;
  }
  if (key.length > MAX_KEY_LENGTH) {
    return `must be at most ${String(MAX_KEY_LENGTH)} characters`;
  }
  if (!ALLOWED.test(key)) {
    return "must hold only letters, digits, '.', '_', '~' and '-'";
  }
  if (/^\d+$/.test(key)) {
    return "must not be all digits";
  }
  return undefined;
}

/**
 * The text with one trailing `\n` or `\r\n` removed.
 *
 * @param text - The text read from a file or stdin.
 * @returns The text without that newline.
 */
export function trimNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * `message` with the `code` of a Node system error, such as `ENOENT`, when it has one. The error's
 * message is dropped: it can hold the path or the data.
 *
 * @param message - The issue message.
 * @param error - What the read threw.
 * @returns The message, with the code when there is one.
 */
export function withCode(message: string, error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) {
      return `${message} (${code})`;
    }
  }
  return message;
}

/**
 * Decodes chunks of a stream into text, stopping once more than `limit` bytes arrived.
 *
 * @param chunks - The stream.
 * @param limit - The most bytes wanted; one chunk more may be read, so a longer text is seen.
 * @returns The text.
 */
export async function readLimited(chunks: AsyncIterable<unknown>, limit: number): Promise<string> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = "";
  let size = 0;
  for await (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("stdin gave a chunk that is neither text nor bytes");
    }
    size += bytes.byteLength;
    text += decoder.decode(bytes, { stream: true });
    if (size > limit) {
      break;
    }
  }
  return text + decoder.decode();
}

/** Thrown by {@link readFileStart} for a path that is not a regular file. */
export class NotRegularFile extends Error {}

/**
 * The first `limit` bytes of a regular file and one more, so a longer file is seen as too long.
 * The file is opened without blocking, so a FIFO with no writer or a terminal device cannot hang
 * the run, and anything but a regular file is refused before a byte is read.
 *
 * @param path - The path, as the option gave it.
 * @param limit - The most bytes wanted.
 * @returns The text read.
 * @throws NotRegularFile for a path that is not a regular file.
 */
export async function readFileStart(path: string, limit: number): Promise<string> {
  // `O_NONBLOCK` is undefined on Windows, where `| undefined` adds no flag.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) {
      throw new NotRegularFile();
    }
    const buffer = new Uint8Array(limit + 1);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, filled, buffer.byteLength - filled, null);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return new TextDecoder().decode(buffer.subarray(0, filled));
  } finally {
    await file.close();
  }
}

/** One key read from a flag: the key, or the issue that the reading or the check found. */
type FlagKey = { key: string } | { issue: InputIssue } | undefined;

/**
 * Where a key from `--api-key-file` or `--api-key-stdin` goes: `route.apiKey`, one `apiKeys`
 * entry, nowhere because `--backend` is already an issue, or nowhere with a problem to report.
 */
type Destination =
  | { readonly kind: "route" }
  | { readonly kind: "backend"; readonly backend: BackendName }
  | { readonly kind: "none" }
  | { readonly kind: "problem"; readonly message: string };

/**
 * Where a key from a flag goes. The routing table picks a backend partly by the keys it has, so
 * the CLI cannot tell which backend an unnamed key is for. The caller names it: `--api-url` binds
 * the key to that host, and `--backend` names a backend that takes a key from `apiKeys`.
 * `--backend etherscan-compatible` alone binds it to the standalone host of the chain's row. A key
 * is never given to a backend it was not meant for, such as a Routescan key to Etherscan (R-SEC-2).
 */
function destinationOf(route: RouteOverride, backendGiven: boolean): Destination {
  const { backend, apiUrl } = route;
  if (backend === undefined) {
    if (backendGiven) {
      return { kind: "none" };
    }
    return {
      kind: "problem",
      message:
        apiUrl === undefined
          ? "needs --backend or --api-url, to name where the key goes"
          : "needs --backend etherscan-v2, routescan or etherscan-compatible with --api-url",
    };
  }
  if (!ROUTE_KEY_BACKENDS.includes(backend)) {
    return {
      kind: "problem",
      message: `cannot be used with --backend ${backend}: it takes no API key`,
    };
  }
  // Without --api-url, a standalone explorer's key goes to the host the routing table lists for
  // the chain; a chain whose row lists none fails with unsupported-chain (decision 0039).
  return apiUrl === undefined && FLAG_KEY_BACKENDS.includes(backend)
    ? { kind: "backend", backend }
    : { kind: "route" };
}

/** The options that read stdin, in the order a conflict between two of them is reported. */
const STDIN_READERS: readonly (readonly [option: string, label: string])[] = [
  ["input-json", "--input-json -"],
  ["api-key-stdin", "--api-key-stdin"],
  ["rpc-url-stdin", "--rpc-url-stdin"],
];

/**
 * The issue of two options that would both read stdin, such as `--api-key-stdin` with
 * `--input-json -` (R-AX-9), or `undefined`. The request, the keys and the RPC URL check it before
 * any of them reads a byte. The issue names the later option of {@link STDIN_READERS}.
 *
 * @param values - The checked option values.
 * @returns The issue.
 */
export function stdinConflict(values: ReadonlyMap<string, OptionValue>): InputIssue | undefined {
  const readers = STDIN_READERS.filter(([option]) =>
    option === "input-json" ? values.get(option) === "-" : values.get(option) === true,
  );
  const [first, second] = readers;
  return first !== undefined && second !== undefined
    ? {
        field: second[1],
        message: `cannot be combined with ${first[1]}: both would read stdin`,
      }
    : undefined;
}

/** Reads the key that `--api-key-file` or `--api-key-stdin` names, if either is set. */
async function flagKey(
  sources: RouteSources,
  destination: Destination,
  secrets: string[],
  issues: InputIssue[],
): Promise<FlagKey> {
  const { values } = sources;
  const file = values.get("api-key-file");
  const fromStdin = values.get("api-key-stdin") === true;
  if (typeof file === "string" && fromStdin) {
    issues.push({ field: "--api-key-stdin", message: "cannot be combined with --api-key-file" });
    return undefined;
  }
  if (!fromStdin && typeof file !== "string") {
    return undefined;
  }
  const field = fromStdin ? "--api-key-stdin" : "--api-key-file";
  const conflict = stdinConflict(values);
  if (conflict !== undefined) {
    issues.push(conflict);
    return undefined;
  }
  if (destination.kind === "problem") {
    issues.push({ field, message: destination.message });
  }
  const blocked = destination.kind === "problem" || destination.kind === "none";
  if (fromStdin) {
    const stdin = sources.stdin();
    if (stdin.isTTY === true) {
      // The CLI never prompts (R-AX-6), so a terminal on stdin is an error, not a wait.
      issues.push({
        field: "--api-key-stdin",
        message: "needs the key piped on stdin, and stdin is a terminal",
      });
      return undefined;
    }
    if (blocked) {
      return undefined;
    }
    let text: string;
    try {
      text = await readLimited(stdin, READ_LIMIT);
    } catch (error) {
      return {
        issue: { field: "--api-key-stdin", message: withCode("could not read stdin", error) },
      };
    }
    return checked("--api-key-stdin", trimNewline(text), secrets);
  }
  if (blocked) {
    return undefined;
  }
  let text: string;
  try {
    text = await readFileStart(String(file), READ_LIMIT);
  } catch (error) {
    const message =
      error instanceof NotRegularFile
        ? "must name a regular file; pipe the key with --api-key-stdin"
        : withCode("names a file that cannot be read", error);
    return { issue: { field: "--api-key-file", message } };
  }
  return checked("--api-key-file", trimNewline(text), secrets);
}

/** The key, or the issue naming `field`; a non-empty key joins `secrets` either way. */
function checked(field: string, key: string, secrets: string[]): FlagKey {
  if (key === "") {
    return { issue: { field, message: "gave an empty key" } };
  }
  secrets.push(key);
  const problem = keyProblem(key);
  return problem === undefined ? { key } : { issue: { field, message: problem } };
}

/**
 * Reads the route options and the keys of a command (R-AX-9, R-RT-2):
 *
 * - `ETHERSCAN_API_KEY` fills `apiKeys["etherscan-v2"]` and `ROUTESCAN_API_KEY` fills
 *   `apiKeys.routescan`. An empty value counts as unset.
 * - `--api-key-file <path>` and `--api-key-stdin` give one key, with one trailing newline removed.
 *   With `--api-url`, it goes in `route.apiKey`, bound to that host. Otherwise `--backend` must
 *   name `etherscan-v2` or `routescan`, and the key fills that `apiKeys` entry, winning over its
 *   variable. Without either flag, the key has no named destination, which is an issue.
 * - `--api-key-stdin` with `--input-json -`, or with stdin a terminal, is an issue at once.
 * - `--backend <name>` and `--api-url <url>` fill `route`; the library checks the URL.
 *
 * Each key is checked with the rules of decision 0016, so an issue names the variable or the flag.
 * Every key read, valid or not, is returned in `secrets`.
 *
 * @param sources - The option values, the environment and stdin.
 * @returns The options, the secrets and the issues.
 */
export async function readRouteOptions(sources: RouteSources): Promise<ReadRouteOptions> {
  const { values, env } = sources;
  const issues: InputIssue[] = [];
  const secrets: string[] = [];
  const apiKeys: Partial<Record<BackendName, string>> = {};
  for (const { name, backend } of KEY_VARIABLES) {
    const value = env[name];
    if (value === undefined || value === "") {
      continue;
    }
    secrets.push(value);
    const problem = keyProblem(value);
    if (problem === undefined) {
      apiKeys[backend] = value;
    } else {
      issues.push({ field: name, message: problem });
    }
  }

  const route: RouteOverride = {};
  const given = backendsGiven(values.get("backend"));
  if (given.length > 1) {
    return eachBackend(given, values, { apiKeys, secrets, issues });
  }
  const [backendValue] = given;
  if (typeof backendValue === "string") {
    const backend = toBackendName(backendValue);
    if (backend === undefined) {
      issues.push({ field: "--backend", message: `must be one of ${BACKEND_NAMES.join(", ")}` });
    } else {
      route.backend = backend;
    }
  }
  const apiUrl = values.get("api-url");
  if (typeof apiUrl === "string") {
    route.apiUrl = apiUrl;
  }

  const destination = destinationOf(route, typeof backendValue === "string");
  const flag = await flagKey(sources, destination, secrets, issues);
  if (flag !== undefined && "issue" in flag) {
    issues.push(flag.issue);
  } else if (flag !== undefined && destination.kind === "route") {
    route.apiKey = flag.key;
  } else if (flag !== undefined && destination.kind === "backend") {
    apiKeys[destination.backend] = flag.key;
  }

  if (issues.length > 0) {
    return { options: undefined, secrets, issues };
  }
  const options: RouteOptions = {
    ...(Object.keys(apiKeys).length > 0 ? { apiKeys } : {}),
    ...(Object.keys(route).length > 0 ? { route } : {}),
  };
  return { options, secrets, issues };
}

/** The values of `--backend`: one from `status` or a request's `route`, a list from `verify`. */
function backendsGiven(value: OptionValue | undefined): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  return typeof value === "object" ? value : [];
}

/**
 * The route options of `--backend` given more than once: `verify` then runs `verifyEach()` on each
 * backend (R-RT-4). Each backend uses its routing-table URL and gets its key only from its
 * environment variable, so `--api-url`, `--api-key-file` and `--api-key-stdin` are issues: none of
 * them can say which backend it is for.
 */
function eachBackend(
  given: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
  read: {
    readonly apiKeys: Partial<Record<BackendName, string>>;
    readonly secrets: readonly string[];
    readonly issues: InputIssue[];
  },
): ReadRouteOptions {
  const { apiKeys, secrets, issues } = read;
  const backends: BackendName[] = [];
  given.forEach((value, index) => {
    const field = `--backend[${String(index + 1)}]`;
    const backend = toBackendName(value);
    if (backend === undefined) {
      issues.push({ field, message: `must be one of ${BACKEND_NAMES.join(", ")}` });
    } else if (backends.includes(backend)) {
      issues.push({ field, message: "names a backend that an earlier --backend names" });
    } else {
      backends.push(backend);
    }
  });
  for (const name of ["api-url", "api-key-file", "api-key-stdin"]) {
    if (values.has(name)) {
      issues.push({
        field: `--${name}`,
        message: `cannot be combined with a repeated --backend: each backend uses its routing-table URL and the key of its environment variable, ${KEY_VARIABLES.map((each) => each.name).join(" or ")}`,
      });
    }
  }
  if (issues.length > 0) {
    return { options: undefined, secrets, issues };
  }
  return {
    options: { ...(Object.keys(apiKeys).length > 0 ? { apiKeys } : {}), backends },
    secrets,
    issues,
  };
}

/**
 * The environment without the key variables, for a command's context: a command gets its keys
 * from the route options only, so printing its environment shows none.
 *
 * @param env - The environment variables.
 * @returns A copy without {@link KEY_VARIABLES}.
 */
export function withoutKeyVariables(env: Environment): Environment {
  const names = new Set(KEY_VARIABLES.map(({ name }) => name));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)));
}

/** What a removed key is replaced with, the same marker as the library's. */
const REDACTED = "[redacted]";

/**
 * The words of the output contract: backend names, error codes and result values. A string value
 * that is exactly one of them is public, so the JSON scrubber keeps it, and the envelope stays
 * valid even when an RPC URL has such a word as a path segment.
 */
const FIXED_WORDS: ReadonlySet<string> = new Set<string>([
  ...BACKEND_NAMES,
  ...ERROR_CODES,
  "verified",
  "already-verified",
  "failed",
  "dry-run",
  "exact",
  "partial",
  "none",
  "skipped",
  "pending",
]);

/**
 * The property names of the JSON envelope (`envelope.schema.json`). A name that is exactly one of
 * them is public, so the JSON scrubber keeps it and the envelope keeps its shape.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set<string>([
  "schemaVersion",
  "ok",
  "result",
  "error",
  "code",
  "message",
  "hint",
  "retryable",
  "docsUrl",
  "handle",
  "status",
  "backend",
  "match",
  "lookup",
  "apiHost",
  "explorerUrl",
  "reason",
]);

/** `text` scrubbed, unless it is exactly one of the public words in `kept`. */
function scrubWord(text: string, pattern: RegExp, kept: ReadonlySet<string>): string {
  return kept.has(text) ? text : text.replace(pattern, REDACTED);
}

/**
 * A parsed JSON value with `pattern` replaced in its string values and property names. The words
 * of {@link FIXED_WORDS} as values and of {@link ENVELOPE_KEYS} as names stay, so the structure of
 * the envelope stays too. A secret in any other name is removed: secrecy wins over structure.
 */
function scrubValue(value: unknown, pattern: RegExp): unknown {
  if (typeof value === "string") {
    return scrubWord(value, pattern, FIXED_WORDS);
  }
  if (Array.isArray(value)) {
    return value.map((each: unknown) => scrubValue(each, pattern));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, each]) => [
        scrubWord(name, pattern, ENVELOPE_KEYS),
        scrubValue(each, pattern),
      ]),
    );
  }
  return value;
}

/**
 * `text` with every match of `pattern` replaced by `[redacted]`. A write that is one JSON object
 * on one line, such as the envelope or a JSON log line, is scrubbed in its string values and
 * property names, keeping the envelope's own names and the words of {@link FIXED_WORDS}, so its
 * structure stays.
 */
function scrubbed(text: string, pattern: RegExp): string {
  const line = text.endsWith("\n") ? text.slice(0, -1) : "";
  if (line.startsWith("{") && line.endsWith("}") && !line.includes("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      return `${JSON.stringify(scrubValue(parsed, pattern))}\n`;
    } catch {
      // Not JSON after all: scrubbed as text below.
    }
  }
  return text.replace(pattern, REDACTED);
}

/**
 * A stream that writes through to `stream` with every key in `secrets` replaced by `[redacted]`
 * (R-SEC-1). It reads `secrets` at each write, so keys read after it was made are removed too.
 * Keys shorter than 8 characters are left alone: the library refuses them, and replacing them
 * could corrupt other text. A key holds only characters that JSON and the text lines write as
 * they are, so a plain replacement finds every copy. A write of one JSON object on one line keeps
 * its structure: the envelope's own property names and the output contract's words stay.
 *
 * @param stream - The stream to write to.
 * @param secrets - The keys to remove; the caller may add to it later.
 * @returns The scrubbing stream.
 */
export function scrubbing(stream: OutputStream, secrets: readonly string[]): OutputStream {
  return {
    write: (text) => {
      const pattern = secretPattern(secrets);
      stream.write(pattern === undefined ? text : scrubbed(text, pattern));
    },
    isTTY: stream.isTTY,
  };
}

/** One case-insensitive pattern that matches any of `secrets`, the longest first. */
function secretPattern(secrets: readonly string[]): RegExp | undefined {
  const parts = secrets
    .filter((secret) => secret.length >= MIN_KEY_LENGTH)
    .toSorted((a, b) => b.length - a.length)
    .map((secret) => secret.replaceAll(/[\\^$.*+?()[\]{}|/-]/g, String.raw`\$&`));
  return parts.length === 0 ? undefined : new RegExp(parts.join("|"), "gi");
}

/**
 * The non-empty values of the key variables, so the main loop can remove them from every output
 * before it reads the command line (R-SEC-1).
 *
 * @param env - The environment variables.
 * @returns The values that are set.
 */
export function keyVariableValues(env: Environment): string[] {
  return KEY_VARIABLES.flatMap(({ name }) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [value];
  });
}
