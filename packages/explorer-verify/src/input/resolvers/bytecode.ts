/**
 * The bytecode-metadata resolver (R-IN-5, decision 0026): reads the metadata hash solc appends to
 * the runtime bytecode, finds the metadata and the sources that hash names, and rebuilds the
 * Standard JSON input with `buildVerifyInput` (R-IN-7).
 *
 * Every request goes through the HTTP layer, so it never follows a redirect, reads a bounded body,
 * retries transient failures and stops on abort or when the time budget runs out (R-FLOW-6,
 * R-SEC-2). Hosts come only from the caller (`rpcUrl`, `ipfsGateway`) and from the routing
 * table's Sourcify API; there is no built-in IPFS gateway.
 */
import { ExplorerVerifyError } from "../../errors.ts";
import type { InputIssue, MetadataAttempt } from "../../errors.ts";
import { MAX_TIMER_MS, request } from "../../http/fetch.ts";
import type { Budget, HttpContext } from "../../http/fetch.ts";
import { keccak256 } from "../../internal/keccak.ts";
import { addressDigits, readChainId, readFields, readOwn } from "../../internal/read-fields.ts";
import { createObserver } from "../../observe.ts";
import type { Observer } from "../../observe.ts";
import { MIN_SECRET_LENGTH } from "../../redact.ts";
import { checkApiUrl, SOURCIFY_API_URL } from "../../routing/resolve.ts";
import type { Hex, Logger } from "../../types.ts";
import { buildVerifyInput } from "../build.ts";
import type { BuiltVerifyInput } from "../build.ts";
import { parseMetadata, readMetadata } from "../metadata.ts";
import type { SolidityMetadata } from "../metadata.ts";
import { hexBytes, readAuxdata } from "./auxdata.ts";
import type { Auxdata } from "./auxdata.ts";
import { ipfsCid } from "./ipfs.ts";

/**
 * The contract whose bytecode {@link resolveInputFromBytecode} reads.
 *
 * @example
 * ```ts
 * import type { BytecodeTarget } from "explorer-verify/resolve";
 *
 * const target: BytecodeTarget = {
 *   chainId: 11155111,
 *   address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
 * };
 * ```
 * @experimental
 */
export interface BytecodeTarget {
  /** EVM chain id the contract is deployed on. */
  chainId: number;
  /** The contract address: `0x` and 40 hex digits, in any case. */
  address: Hex;
}

/**
 * Options for {@link resolveInputFromBytecode}. Pass `bytecode` or `rpcUrl`, not both.
 *
 * @example
 * ```ts
 * import type { ResolveInputOptions } from "explorer-verify/resolve";
 *
 * const options: ResolveInputOptions = {
 *   rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
 *   ipfsGateway: "http://127.0.0.1:8080",
 *   timeoutMs: 60_000,
 * };
 * ```
 * @experimental
 */
export interface ResolveInputOptions {
  /**
   * The deployed runtime bytecode, `0x` and hex digits, when you already have it. At most
   * 65536 bytes.
   */
  bytecode?: string;
  /**
   * A JSON-RPC endpoint of the contract's chain. The resolver checks `eth_chainId`, then reads the
   * bytecode with `eth_getCode` at `latest`. An absolute `https` URL, or `http` on `localhost`,
   * `127.0.0.1` or `[::1]`. Its path segments and query values of 8 or more characters are
   * redacted from logs and errors; the host name is not, so never put a key in it.
   */
  rpcUrl?: string;
  /**
   * An IPFS path gateway, such as your own node's `http://127.0.0.1:8080`. The resolver requests
   * `<gateway>/ipfs/<CID>` for the metadata and for each source it lists, and keeps the gateway's
   * query string. Same URL and redaction rules as `rpcUrl`. There is no default gateway.
   */
  ipfsGateway?: string;
  /**
   * Whether to look for a verified copy on Sourcify at the same address, on any chain. Defaults to
   * `true`. A copy is used only when its metadata hashes to the bytecode's IPFS hash; for a Swarm
   * hash, only an exact match on the same chain is used. `false` needs `ipfsGateway`.
   */
  sourcify?: boolean;
  /**
   * Source contents by path, as the metadata lists the paths, for sources no other source has.
   * Each must hash to the metadata's `keccak256` for its path.
   */
  sources?: Readonly<Record<string, string>>;
  /** The `fetch` every request goes through. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Cancels the call. The call rejects with `signal.reason` unchanged. */
  signal?: AbortSignal;
  /** Time budget for the whole call, in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
  /**
   * Receives log lines with secrets removed. Nothing is logged when it is absent. Requests to
   * Sourcify are logged with their retries; requests to `rpcUrl` and `ipfsGateway` are not, only
   * the outcome of each attempt.
   */
  logger?: Logger;
}

/** The default time budget, as for `verify()`. */
const DEFAULT_RESOLVE_TIMEOUT_MS = 120_000;
/** The most Sourcify copies fetched in one call: the same chain's first, then exact matches. */
const MAX_SOURCIFY_COPIES = 3;
/** The most source files requested from the gateway at once. */
const SOURCE_CONCURRENCY = 6;
/** The largest bytecode read, in bytes: well above the 24 KiB of EIP-170. */
const MAX_BYTECODE_BYTES = 65_536;
/** The largest JSON-RPC answer read: 1 MiB. */
const RPC_BODY_BYTES = 1_048_576;
/** The largest gateway answer read, metadata or one source: 4 MiB. */
const GATEWAY_BODY_BYTES = 4_194_304;

// The forms the resolver builds a request path from: a chain id Sourcify lists, and a CIDv0.
const CHAIN_ID = /^[1-9][0-9]{0,19}$/;
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const DWEB_PREFIX = "dweb:/ipfs/";

const OPTIONS_HINT =
  "Fix the fields in details.issues. Pass bytecode or rpcUrl, and https URLs for rpcUrl and ipfsGateway.";

/** A checked URL the caller configured: origin and path, and the query string kept apart. */
interface Endpoint {
  readonly apiBase: string;
  readonly search: string;
}

/** The checked options. */
interface Settings {
  readonly chainId: number;
  readonly address: Hex;
  /** The bytecode the caller passed, or the JSON-RPC endpoint to read it from. */
  readonly code: { readonly bytes: Uint8Array } | { readonly rpcUrl: Endpoint };
  readonly gateway: Endpoint | undefined;
  readonly sourcify: boolean;
  readonly sources: Record<string, string>;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly logger: Logger | undefined;
  readonly secrets: string[];
}

/** What one call shares. */
interface Call {
  readonly settings: Settings;
  readonly observer: Observer;
  readonly budget: Budget;
  readonly attempts: MetadataAttempt[];
  /** The hash as `metadata-unavailable` reports it; empty until the bytecode is read. */
  hash: string;
}

/** Metadata that matches the bytecode, and the sources found next to it. */
interface Found {
  readonly metadata: unknown;
  readonly sources: Map<string, string>;
}

/** `globalThis.fetch`, read when each request starts and called as a plain function. */
const defaultFetch: typeof fetch = async (input, init) => await globalThis.fetch(input, init);

function invalid(issues: InputIssue[], secrets: readonly string[]): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The resolver input is invalid: ${issues.map(({ field }) => field).join(", ")}.`,
    { hint: OPTIONS_HINT, secrets },
  );
}

/** Bytecode as bytes, or `undefined` when it is not hex or longer than {@link MAX_BYTECODE_BYTES}. */
function bytecodeBytes(value: unknown): Uint8Array | undefined {
  return typeof value === "string" && value.length <= 2 + 2 * MAX_BYTECODE_BYTES
    ? hexBytes(value)
    : undefined;
}

/**
 * The parts of a configured URL that may hold a key: each path segment and each query value of
 * at least {@link MIN_SECRET_LENGTH} characters, as written and decoded. Providers put keys in
 * either place, so both are redacted from logs and errors.
 */
function urlSecrets(base: Endpoint): string[] {
  const url = new URL(`${base.apiBase}${base.search}`);
  const parts = [...url.pathname.split("/"), ...[...url.searchParams].map(([, value]) => value)];
  const found = new Set<string>();
  for (const part of parts) {
    for (const each of [part, safeDecode(part)]) {
      if (each.length >= MIN_SECRET_LENGTH) {
        found.add(each);
      }
    }
  }
  return [...found];
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A URL option, checked, or `undefined` when absent. Adds an issue when it is invalid. */
function readUrl(value: unknown, field: string, issues: InputIssue[]): Endpoint | undefined {
  if (value === undefined) {
    return undefined;
  }
  const checked = checkApiUrl(value);
  if (typeof checked === "string") {
    issues.push({ field, message: checked });
    return undefined;
  }
  return checked;
}

/** `options.sources` as a plain record of strings, or an issue. */
function readSources(value: unknown, issues: InputIssue[]): Record<string, string> {
  const sources: Record<string, string> = {};
  if (value === undefined) {
    return sources;
  }
  const fields = readFields(value);
  if (fields === undefined || [...fields.values()].some((each) => typeof each !== "string")) {
    issues.push({ field: "sources", message: "must be an object of source contents by path" });
    return sources;
  }
  for (const [path, content] of fields) {
    // Object.defineProperty keeps a path named __proto__ an own key.
    Object.defineProperty(sources, path, { value: content, enumerable: true });
  }
  return sources;
}

/** Each option, read once as an own property; `undefined` when absent. */
type ReadOptions = {
  readonly [K in keyof ResolveInputOptions]-?: ResolveInputOptions[K] | undefined;
};

/**
 * The options, each read once as an own property, or `undefined` when `options` is not an object
 * or a getter or Proxy trap throws. The thrown error is dropped: it may repeat a caller value.
 */
function readOptions(options: ResolveInputOptions | undefined): ReadOptions | undefined {
  const raw: unknown = options;
  if (options === undefined || typeof raw !== "object" || raw === null) {
    return options === undefined ? readOptions({}) : undefined;
  }
  try {
    return {
      bytecode: readOwn(options, "bytecode"),
      rpcUrl: readOwn(options, "rpcUrl"),
      ipfsGateway: readOwn(options, "ipfsGateway"),
      sourcify: readOwn(options, "sourcify"),
      sources: readOwn(options, "sources"),
      fetch: readOwn(options, "fetch"),
      signal: readOwn(options, "signal"),
      timeoutMs: readOwn(options, "timeoutMs"),
      logger: readOwn(options, "logger"),
    };
  } catch {
    return undefined;
  }
}

/** Adds an issue for each of `sourcify`, `fetch`, `signal`, `timeoutMs` and `logger` of the wrong kind. */
function checkKinds(read: ReadOptions, issues: InputIssue[]): void {
  const sourcify: unknown = read.sourcify;
  if (sourcify !== undefined && typeof sourcify !== "boolean") {
    issues.push({ field: "sourcify", message: "must be a boolean" });
  }
  if (sourcify === false && read.ipfsGateway === undefined) {
    issues.push({ field: "ipfsGateway", message: "is required when sourcify is false" });
  }
  const fetchOption: unknown = read.fetch;
  if (fetchOption !== undefined && typeof fetchOption !== "function") {
    issues.push({ field: "fetch", message: "must be a function" });
  }
  const signal: unknown = read.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    issues.push({ field: "signal", message: "must be an AbortSignal" });
  }
  const timeoutMs: unknown = read.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    issues.push({
      field: "timeoutMs",
      message: "must be a positive finite number of milliseconds",
    });
  }
  const logger: unknown = read.logger;
  if (logger !== undefined && (logger === null || typeof logger !== "object")) {
    issues.push({ field: "logger", message: "must be an object" });
  }
}

/** Reads and checks the target and the options, each field once, as an own property. */
function readSettings(target: BytecodeTarget, options: ResolveInputOptions | undefined): Settings {
  const issues: InputIssue[] = [];
  const targetFields = readFields(target);
  const chainId = readChainId(targetFields?.get("chainId"));
  if (chainId === undefined) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }
  const digits = addressDigits(targetFields?.get("address"));
  if (digits === undefined) {
    issues.push({ field: "address", message: "must be 0x followed by 40 hex digits" });
  }
  const read = readOptions(options);
  if (read === undefined) {
    throw invalid([...issues, { field: "options", message: "must be a readable object" }], []);
  }
  const rawBytecode: unknown = read.bytecode;
  const bytecode = bytecodeBytes(rawBytecode);
  if (rawBytecode !== undefined && bytecode === undefined) {
    issues.push({
      field: "bytecode",
      message: "must be 0x followed by an even number of hex digits, at most 65536 bytes",
    });
  }
  const rpcUrl = readUrl(read.rpcUrl, "rpcUrl", issues);
  const gateway = readUrl(read.ipfsGateway, "ipfsGateway", issues);
  if ((rawBytecode === undefined) === (read.rpcUrl === undefined)) {
    issues.push({ field: "rpcUrl", message: "must be passed exactly when bytecode is absent" });
  }
  const sources = readSources(read.sources, issues);
  checkKinds(read, issues);
  const secrets = [rpcUrl, gateway].flatMap((each) => (each === undefined ? [] : urlSecrets(each)));
  const code =
    bytecode !== undefined ? { bytes: bytecode } : rpcUrl === undefined ? undefined : { rpcUrl };
  if (issues.length > 0 || chainId === undefined || digits === undefined || code === undefined) {
    throw invalid(issues, secrets);
  }
  const { fetch: fetchOption, timeoutMs } = read;
  return {
    chainId,
    address: `0x${digits.toLowerCase()}`,
    code,
    gateway,
    sourcify: read.sourcify !== false,
    sources,
    // Called as a plain function, never as a method of the options.
    fetch: fetchOption === undefined ? defaultFetch : (input, init) => fetchOption(input, init),
    signal: read.signal,
    timeoutMs:
      timeoutMs === undefined ? DEFAULT_RESOLVE_TIMEOUT_MS : Math.min(timeoutMs, MAX_TIMER_MS),
    logger: read.logger,
    secrets,
  };
}

/**
 * The HTTP context of one request. Sourcify requests carry the observer, so their retries are
 * logged. Requests to the caller's endpoints do not: the HTTP layer would name a backend in each
 * line, and these endpoints are not backends. Their failures become an attempt instead.
 */
function context(call: Call, source: MetadataAttempt["source"]): HttpContext {
  const { settings } = call;
  return {
    // The HTTP layer names a backend in its errors and log lines. Errors from the caller's
    // endpoints are caught and become an attempt, and those requests are not logged, so this
    // name never reaches the caller for them.
    backend: "sourcify",
    secrets: settings.secrets,
    budget: call.budget,
    fetch: settings.fetch,
    ...(source === "sourcify" ? { observer: call.observer } : {}),
    ...(source === "rpc" ? { maxResponseBytes: RPC_BODY_BYTES } : {}),
    ...(source === "ipfs" ? { maxResponseBytes: GATEWAY_BODY_BYTES } : {}),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  };
}

function unavailable(call: Call, message: string): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "metadata-unavailable", hash: call.hash, attempts: call.attempts },
    message,
    { secrets: call.settings.secrets },
  );
}

/**
 * One GET or POST through the HTTP layer. Returns the status and body, or records an
 * `unavailable` attempt and returns `undefined` when the HTTP layer gave up. When the time budget
 * ran out, it records a `timeout` attempt and throws `metadata-unavailable` at once: every later
 * request would time out too.
 */
async function send(
  call: Call,
  source: MetadataAttempt["source"],
  url: string,
  body?: string,
): Promise<{ status: number; text: string } | undefined> {
  try {
    const response = await request(context(call, source), {
      url,
      method: body === undefined ? "GET" : "POST",
      retry: "safe",
      ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
    });
    return { status: response.status, text: await response.text() };
  } catch (error: unknown) {
    // An abort, or anything that is not a library error, is thrown as it is.
    if (call.settings.signal?.aborted === true || !(error instanceof ExplorerVerifyError)) {
      throw error;
    }
    const { details } = error;
    if (details.code === "timeout") {
      call.attempts.push({ source, outcome: "timeout" });
      throw unavailable(call, "The time budget ran out before the metadata was found.");
    }
    const attempt: MetadataAttempt = { source, outcome: "unavailable" };
    if (details.code === "unexpected-response") {
      attempt.status = details.status;
    } else if (details.code === "rate-limited") {
      attempt.status = 429;
    }
    call.attempts.push(attempt);
    call.observer.log.warn(`${source}: no usable answer`, { source, code: error.code });
    return undefined;
  }
}

/** A JSON body as fields, or `undefined` when it is not a JSON object. */
function jsonFields(text: string): Map<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return readFields(parsed);
  } catch {
    return undefined;
  }
}

/** One JSON-RPC call to `rpcUrl`, or `metadata-unavailable` when it gives no result. */
async function rpc(
  call: Call,
  rpcUrl: Endpoint,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const answer = await send(
    call,
    "rpc",
    `${rpcUrl.apiBase}${rpcUrl.search}`,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  );
  const result = answer?.status === 200 ? jsonFields(answer.text)?.get("result") : undefined;
  if (answer !== undefined && result === undefined) {
    call.attempts.push({ source: "rpc", outcome: "unavailable", status: answer.status });
  }
  if (result === undefined) {
    throw unavailable(call, `The JSON-RPC endpoint gave no result for ${method}.`);
  }
  return result;
}

/** The runtime bytecode at the address, from the caller's JSON-RPC endpoint on the right chain. */
async function readBytecode(call: Call, rpcUrl: Endpoint): Promise<Uint8Array> {
  const { chainId, address, secrets } = call.settings;
  const served = await rpc(call, rpcUrl, "eth_chainId", []);
  if (
    typeof served !== "string" ||
    !/^0x[0-9a-fA-F]{1,16}$/.test(served) ||
    Number(served) !== chainId
  ) {
    throw invalid([{ field: "rpcUrl", message: "serves another chain than chainId" }], secrets);
  }
  const bytes = bytecodeBytes(await rpc(call, rpcUrl, "eth_getCode", [address, "latest"]));
  if (bytes === undefined) {
    call.attempts.push({ source: "rpc", outcome: "unavailable", status: 200 });
    throw unavailable(call, "The JSON-RPC endpoint answered eth_getCode with no usable bytecode.");
  }
  return bytes;
}

/** The text form of the hash, as `metadata-unavailable` reports it. */
function hashText(auxdata: Extract<Auxdata, { kind: "ipfs" | "swarm" }>): string {
  return auxdata.kind === "ipfs" ? `ipfs:${auxdata.cid}` : `${auxdata.key}:${auxdata.hex}`;
}

/** The CID of the metadata as solc serialised it: compact JSON, keys in solc's order. */
function cidOf(text: string): string {
  return ipfsCid(new TextEncoder().encode(text));
}

/**
 * The `content` of each source in a Sourcify `sources` field whose keccak-256 is the one the
 * metadata records. A source that differs is dropped and logged, so the gateway or the caller's
 * `sources` can supply it; with neither, the builder lists it in `incomplete-input`.
 */
function sourcifySources(
  value: unknown,
  metadata: SolidityMetadata,
  log: Logger,
): Map<string, string> {
  const expected = new Map(metadata.sources.map((source) => [source.path, source.keccak256]));
  const encoder = new TextEncoder();
  const sources = new Map<string, string>();
  for (const [path, entry] of readFields(value) ?? []) {
    const content = readFields(entry)?.get("content");
    if (typeof content !== "string") {
      continue;
    }
    if (keccak256(encoder.encode(content)) === expected.get(path)) {
      sources.set(path, content);
    } else {
      log.warn("sourcify: a source does not match the metadata's hash and is not used", {});
    }
  }
  return sources;
}

/** One verified copy that Sourcify lists for the address. */
interface Copy {
  readonly chainId: string;
  readonly exact: boolean;
}

/** The copies to fetch: the same chain first, then exact matches, at most {@link MAX_SOURCIFY_COPIES}. */
function pickCopies(results: unknown, chainId: number): Copy[] {
  const copies: Copy[] = [];
  for (const entry of Array.isArray(results) ? results : []) {
    const fields = readFields(entry);
    const chain = fields?.get("chainId");
    const match = fields?.get("match");
    if (
      typeof chain === "string" &&
      CHAIN_ID.test(chain) &&
      (match === "exact_match" || match === "match")
    ) {
      copies.push({ chainId: chain, exact: match === "exact_match" });
    }
  }
  const rank = (copy: Copy): number =>
    (copy.chainId === String(chainId) ? 0 : 2) + (copy.exact ? 0 : 1);
  return copies.toSorted((a, b) => rank(a) - rank(b)).slice(0, MAX_SOURCIFY_COPIES);
}

/**
 * A verified copy on Sourcify whose metadata matches the bytecode: same address, any chain. For an
 * IPFS hash, the copy's metadata, serialised as solc does, must have the same CID. For a Swarm
 * hash, which this library does not compute, only an exact match on the same chain is used: the
 * library relies on Sourcify having found the same hash in the same bytecode.
 */
async function fromSourcify(
  call: Call,
  auxdata: Extract<Auxdata, { kind: "ipfs" | "swarm" }>,
): Promise<Found | undefined> {
  const { chainId, address } = call.settings;
  const listed = await send(
    call,
    "sourcify",
    `${SOURCIFY_API_URL}/v2/contract/all-chains/${address}`,
  );
  if (listed === undefined) {
    return undefined;
  }
  if (listed.status !== 200 && listed.status !== 404) {
    call.attempts.push({ source: "sourcify", outcome: "unavailable", status: listed.status });
    return undefined;
  }
  const copies = pickCopies(jsonFields(listed.text)?.get("results"), chainId);
  if (copies.length === 0) {
    call.attempts.push({ source: "sourcify", outcome: "not-found", status: listed.status });
    return undefined;
  }
  for (const copy of copies) {
    const answer = await send(
      call,
      "sourcify",
      `${SOURCIFY_API_URL}/v2/contract/${copy.chainId}/${address}?fields=metadata,sources`,
    );
    if (answer === undefined) {
      continue;
    }
    const fields = answer.status === 200 ? jsonFields(answer.text) : undefined;
    const metadata = fields?.get("metadata");
    if (fields === undefined || readFields(metadata) === undefined) {
      call.attempts.push({
        source: "sourcify",
        outcome: answer.status === 404 ? "not-found" : "unavailable",
        status: answer.status,
      });
      continue;
    }
    // Metadata larger than a gateway answer may be is not hashed, so one copy cannot block the
    // event loop for long.
    const text = JSON.stringify(metadata);
    if (text.length > GATEWAY_BODY_BYTES) {
      call.attempts.push({ source: "sourcify", outcome: "unavailable", status: answer.status });
      continue;
    }
    const matches =
      auxdata.kind === "ipfs"
        ? cidOf(text) === auxdata.cid
        : copy.exact && copy.chainId === String(chainId);
    const parsed = matches ? parseMetadata(metadata) : undefined;
    if (parsed === undefined) {
      call.attempts.push({
        source: "sourcify",
        outcome: matches ? "not-metadata" : "hash-mismatch",
        status: answer.status,
      });
      call.observer.log.warn("sourcify: a verified copy has other metadata", {
        chainId: copy.chainId,
      });
      continue;
    }
    call.observer.log.info("sourcify: found a verified copy with the same metadata", {
      chainId: copy.chainId,
    });
    return {
      metadata,
      sources: sourcifySources(fields.get("sources"), parsed, call.observer.log),
    };
  }
  return undefined;
}

/** `<gateway>/ipfs/<cid>` with the gateway's query string. `cid` is a checked CIDv0. */
function gatewayUrl(gateway: Endpoint, cid: string): string {
  return `${gateway.apiBase}/ipfs/${cid}${gateway.search}`;
}

/** The metadata from the caller's IPFS gateway, when it hashes to the bytecode's CID. */
async function fromGateway(call: Call, gateway: Endpoint, cid: string): Promise<Found | undefined> {
  const answer = await send(call, "ipfs", gatewayUrl(gateway, cid));
  if (answer === undefined) {
    return undefined;
  }
  if (answer.status !== 200) {
    call.attempts.push({
      source: "ipfs",
      outcome: answer.status === 404 ? "not-found" : "unavailable",
      status: answer.status,
    });
    return undefined;
  }
  if (cidOf(answer.text) !== cid) {
    call.attempts.push({ source: "ipfs", outcome: "hash-mismatch", status: 200 });
    call.observer.log.warn("ipfs: the gateway answered with other content than the hash names", {});
    return undefined;
  }
  if (parseMetadata(answer.text) === undefined) {
    // The file is the one the hash names, but it is not Solidity metadata a rebuild can use.
    call.attempts.push({ source: "ipfs", outcome: "not-metadata", status: 200 });
    return undefined;
  }
  call.observer.log.info("ipfs: found the metadata", {});
  return { metadata: answer.text, sources: new Map() };
}

/**
 * The CIDv0 of each source the metadata lists without content and the caller did not pass, from
 * its `dweb:/ipfs/` URL. A source with no such URL is left for the builder to report as missing.
 */
function sourcesToFetch(
  metadata: unknown,
  have: ReadonlyMap<string, string>,
): { path: string; cid: string }[] {
  const wanted: { path: string; cid: string }[] = [];
  for (const [path, entry] of readFields(readMetadata(metadata)?.get("sources")) ?? []) {
    const fields = readFields(entry);
    const urls = fields?.get("urls");
    if (typeof fields?.get("content") === "string" || have.has(path) || !Array.isArray(urls)) {
      continue;
    }
    const cid = urls
      .map((url: unknown) =>
        typeof url === "string" && url.startsWith(DWEB_PREFIX) ? url.slice(DWEB_PREFIX.length) : "",
      )
      .find((each) => CID_V0.test(each));
    if (cid !== undefined) {
      wanted.push({ path, cid });
    }
  }
  return wanted;
}

/**
 * Fetches the listed sources from the gateway, {@link SOURCE_CONCURRENCY} at a time. A 404 leaves
 * the source missing, so the builder lists it in `incomplete-input`; a source the gateway cannot
 * serve ends the call with `metadata-unavailable`. Each content is checked against its keccak-256
 * hash by the builder.
 */
async function fetchSources(
  call: Call,
  gateway: Endpoint,
  wanted: readonly { path: string; cid: string }[],
  into: Map<string, string>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const take = (): { path: string; cid: string } | undefined => {
    const item = failed ? undefined : wanted[next];
    next += 1;
    return item;
  };
  const worker = async (): Promise<void> => {
    for (let item = take(); item !== undefined; item = take()) {
      const answer = await send(call, "ipfs", gatewayUrl(gateway, item.cid));
      if (answer?.status === 200) {
        into.set(item.path, answer.text);
      } else if (answer?.status !== 404) {
        if (answer !== undefined) {
          call.attempts.push({ source: "ipfs", outcome: "unavailable", status: answer.status });
        }
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOURCE_CONCURRENCY, wanted.length) }, worker));
  if (failed) {
    throw unavailable(call, "The IPFS gateway could not serve a source file the metadata lists.");
  }
}

/**
 * Builds the `compiler` part of `VerifyInput` and the fully qualified contract name from the
 * deployed bytecode alone (R-IN-5). solc appends a CBOR block to the runtime bytecode that holds
 * the hash of the contract's metadata; the metadata names the compiler version, the settings and
 * the keccak-256 hash of each source.
 *
 * 1. Reads the bytecode: `options.bytecode`, or `eth_getCode` at `options.rpcUrl` after checking
 *    that `eth_chainId` is `target.chainId`. Bytecode above 65536 bytes is refused.
 * 2. Reads the metadata hash from the CBOR block: IPFS (`ipfs`) or Swarm (`bzzr0`, `bzzr1`).
 * 3. Looks for a verified copy on Sourcify at the same address, on any chain (unless
 *    `options.sourcify` is `false`). A copy is used only when its metadata, serialised as solc
 *    does, has the bytecode's IPFS hash; for a Swarm hash, only an exact match on the same chain.
 *    A source of the copy whose keccak-256 differs from the metadata is not used.
 * 4. Otherwise, when `options.ipfsGateway` is set and the hash is IPFS, fetches
 *    `<gateway>/ipfs/<CID>` and uses it only when its CID is the bytecode's and it is Solidity
 *    metadata. Then, with a gateway set, fetches each source still missing by its `dweb:/ipfs/`
 *    URL.
 * 5. Passes the metadata and the sources to `buildVerifyInput`, which checks each source's
 *    keccak-256 against the metadata before it returns.
 *
 * There is no built-in IPFS gateway: only the hosts you configure and the routing table's
 * Sourcify API get requests (R-SEC-2). Every request goes through the HTTP layer of `verify()`:
 * no redirect is followed, a JSON-RPC answer above 1 MiB, a gateway answer above 4 MiB and a
 * Sourcify answer above 16 MiB are refused, transient failures are retried, and the call stops on
 * abort or when `timeoutMs` runs out (R-FLOW-6).
 *
 * @param target - The chain id and the contract address.
 * @param options - Where to read the bytecode and find the metadata.
 * @returns The compiler part of `VerifyInput` and the contract name, as `buildVerifyInput` returns them.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts.
 * @throws ExplorerVerifyError `invalid-input` for a bad target or option, or an `rpcUrl` of
 *   another chain; `no-metadata-hash` when the bytecode holds no hash; `metadata-unavailable` when
 *   the JSON-RPC endpoint gives no bytecode, no source returns the metadata, the gateway fails on
 *   a source, or the time budget runs out, with each attempt and its outcome (`not-found`,
 *   `hash-mismatch`, `not-metadata`, `unavailable`, `timeout`) in `details.attempts`;
 *   `incomplete-input` naming the sources found nowhere; `source-mismatch` for a source the
 *   caller or the gateway passed whose keccak-256 differs from the metadata.
 * @example
 * ```ts
 * import { verify } from "explorer-verify";
 * import { resolveInputFromBytecode } from "explorer-verify/resolve";
 *
 * const target = { chainId: 84532, address: "0x06dc80b924f113d9b6758c95aa9854b46936f2c0" } as const;
 * const built = await resolveInputFromBytecode(target, { rpcUrl: "https://sepolia.base.org" });
 * const result = await verify({ ...target, ...built });
 * ```
 * @experimental
 */
export async function resolveInputFromBytecode(
  target: BytecodeTarget,
  options?: ResolveInputOptions,
): Promise<BuiltVerifyInput> {
  const settings = readSettings(target, options);
  settings.signal?.throwIfAborted();
  const call: Call = {
    settings,
    observer: createObserver({ logger: settings.logger, secrets: settings.secrets }),
    budget: { deadline: Date.now() + settings.timeoutMs, timeoutMs: settings.timeoutMs },
    attempts: [],
    hash: "",
  };
  const { code } = settings;
  const bytecode = "bytes" in code ? code.bytes : await readBytecode(call, code.rpcUrl);
  const auxdata = readAuxdata(bytecode);
  if (auxdata.kind !== "ipfs" && auxdata.kind !== "swarm") {
    throw new ExplorerVerifyError(
      { code: "no-metadata-hash", found: auxdata.kind },
      auxdata.kind === "no-code"
        ? "No bytecode is deployed at the address."
        : "The bytecode holds no metadata hash.",
      { secrets: settings.secrets },
    );
  }
  call.hash = hashText(auxdata);
  call.observer.log.debug("read the metadata hash from the bytecode", { hash: call.hash });
  let found = settings.sourcify ? await fromSourcify(call, auxdata) : undefined;
  if (found === undefined && settings.gateway !== undefined && auxdata.kind === "ipfs") {
    found = await fromGateway(call, settings.gateway, auxdata.cid);
  }
  if (found === undefined) {
    throw unavailable(call, "No source returned the metadata the bytecode's hash names.");
  }
  const sources = new Map([...found.sources, ...Object.entries(settings.sources)]);
  if (settings.gateway !== undefined) {
    await fetchSources(call, settings.gateway, sourcesToFetch(found.metadata, sources), sources);
  }
  return buildVerifyInput([found.metadata], { sources: Object.fromEntries(sources) });
}
