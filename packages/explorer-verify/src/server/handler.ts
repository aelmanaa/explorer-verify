/**
 * `createVerifyHandler`, the handler an operator runs on their own server with their own Etherscan
 * key (R-SRV-1 to R-SRV-5, decisions 0003, 0008, 0016 and 0021). It accepts the requests the
 * Etherscan v2 client sends, checks them against its guards, adds the key and forwards them to
 * Etherscan. It is the `explorer-verify/server` entry point.
 *
 * It uses no Node built-in, only web-platform globals (`Request`, `Response`, `URL`,
 * `URLSearchParams`, `TextDecoder`, `setTimeout` and `fetch`), so it runs in Node, edge runtimes
 * and serverless platforms (R-SRV-1, R-RUN-1).
 *
 * What it never does:
 *
 * - take a host, a route, an API URL or a key from the request. Every upstream request goes to
 *   Etherscan's v2 API at the routing module's `ETHERSCAN_API_URL`, so a client cannot point it
 *   elsewhere;
 * - forward an action other than `verifysourcecode`, `checkverifystatus`, the proxy-link actions
 *   `verifyproxycontract` and `checkproxyverification` (only with `allowProxyLink`), and the
 *   read-only lookup `getsourcecode`, whose answer it reduces so that no source is relayed
 *   (R-SRV-3);
 * - follow a redirect: every upstream request has `redirect: "manual"`, and a 3xx is refused;
 * - return a key: refusals are fixed sentences, and every string of an upstream answer is
 *   redacted (R-SEC-1).
 */
import type { BackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { JOB_ID } from "../flow/check-handle.ts";
import { checkKey, keyErrorOf, withKey } from "../http/api-keys.ts";
import type { KeyContext } from "../http/api-keys.ts";
import { MAX_RESPONSE_BYTES, MAX_TIMER_MS, request } from "../http/fetch.ts";
import type { HttpContext, RetryMode } from "../http/fetch.ts";
import { unknownKeys } from "../internal/known-keys.ts";
import { addressDigits, readChainId, readFields, readOwn } from "../internal/read-fields.ts";
import { createObserver } from "../observe.ts";
import type { Observer } from "../observe.ts";
import { redact } from "../redact.ts";
import { ETHERSCAN_API_URL } from "../routing/resolve.ts";
import type { Route } from "../routing/resolve.ts";
import type { Logger } from "../types.ts";
import type { HandlerRefusal } from "./refusals.ts";

/**
 * The default limit for one request body, in bytes as received: 8 MiB.
 *
 * @experimental
 */
export const DEFAULT_MAX_BODY_BYTES: number = 8 * 1024 * 1024;

/**
 * The default time limit for one handled request, from its arrival to the answer, body read and
 * upstream requests included, in milliseconds: 20 seconds. It is below the client's 30-second
 * limit per request, so the client gets the handler's answer, not its own timeout.
 *
 * @experimental
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 20_000;

/**
 * What a lookup answer holds in place of a contract's source: the client needs to know that there
 * is one, not what it is.
 *
 * @experimental
 */
export const SOURCE_MARKER = "[source not relayed by explorer-verify/server]";

const BACKEND: BackendName = "etherscan-v2";
// Etherscan's v2 API base and its host, from the routing module: the same constant the routing
// table's check reads, so the key and every request go to the one host (decision 0016).
const ETHERSCAN_BASE = ETHERSCAN_API_URL;
const ETHERSCAN_HOST = new URL(ETHERSCAN_API_URL).host;
// The largest upstream answer read, in bytes. Etherscan's answers to submits, status polls and
// creation lookups are small; a creation answer holds the creation code, about 100 kB of hex at
// most. A `getsourcecode` answer holds the whole source, so it is read up to the HTTP layer's
// limit and then reduced.
const MAX_UPSTREAM_BYTES = 1024 * 1024;
// Requests per upstream call: one retry at most, so the handler's retries and the client's do not
// multiply. The client backs off.
const UPSTREAM_ATTEMPTS = 2;
// The most fields a request may hold, query and body together. The largest action takes 11.
const MAX_FIELDS = 16;
// The most chains and deployers an allowlist may hold.
const MAX_LIST_LENGTH = 10_000;
// The longest `contractname`, in characters.
const MAX_NAME_LENGTH = 1024;
// The `Retry-After` of `address-not-indexed`, in seconds.
const INDEX_RETRY_SECONDS = 5;

// The actions the handler forwards (R-SRV-3, decision 0021), the fields each takes besides
// `module`, `action` and `chainid`, what may be retried, and the field holding the contract
// address. The submit fields are the ones the Etherscan docs and the recorded requests in
// test/fixtures/etherscan name; both spellings of the constructor argument field are sent by the
// prior art. A proxy link request may be sent again: it starts a new check and undoes nothing.
// Stryker disable next-line ArrayDeclaration: untestable sentinel. The mutant takes a field named as Stryker's placeholder text, which no client sends.
const NO_FIELDS: readonly string[] = [];
const ACTIONS: Readonly<
  Record<
    Action,
    {
      readonly required: readonly string[];
      readonly optional: readonly string[];
      readonly retry: RetryMode;
      readonly address: string | undefined;
    }
  >
> = {
  verifysourcecode: {
    required: ["contractaddress", "sourceCode", "contractname", "compilerversion", "codeformat"],
    optional: ["constructorArguments", "constructorArguements", "licenseType"],
    retry: "submit",
    address: "contractaddress",
  },
  checkverifystatus: { required: ["guid"], optional: NO_FIELDS, retry: "safe", address: undefined },
  getsourcecode: { required: ["address"], optional: NO_FIELDS, retry: "safe", address: "address" },
  verifyproxycontract: {
    required: ["address"],
    optional: ["expectedimplementation"],
    retry: "safe",
    address: "address",
  },
  checkproxyverification: {
    required: ["guid"],
    optional: NO_FIELDS,
    retry: "safe",
    address: undefined,
  },
};

type Action =
  | "verifysourcecode"
  | "checkverifystatus"
  | "getsourcecode"
  | "verifyproxycontract"
  | "checkproxyverification";

/** The forwarded actions, for the check of a request's `action`. */
const ACTION_NAMES: readonly Action[] = [
  "verifysourcecode",
  "checkverifystatus",
  "getsourcecode",
  "verifyproxycontract",
  "checkproxyverification",
];

// Fields that would let a request choose where it goes or which key it uses, compared in lower
// case. Each is refused by name, so the refusal says why.
const FORBIDDEN_FIELDS: readonly string[] = [
  "apikey",
  "api_key",
  "api-key",
  "x-api-key",
  "route",
  "apiurl",
  "api_url",
  "api-url",
  "backend",
  "url",
  "host",
];

const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const HEX = /^(?:0x)?[0-9a-fA-F]*$/;
const LICENSE = /^[0-9]{1,2}$/;
const COMPILER_VERSION = /^v?[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]{0,96}$/;
const CODE_FORMAT = /^[a-z][a-z-]{0,63}$/;
const FORM_TYPE = "application/x-www-form-urlencoded";
const CHAINS_MESSAGE = "must hold only positive safe integers";
const DEPLOYERS_MESSAGE = "must hold only addresses: 0x and 40 hex digits";
// The lookup fields the client reads (R-FLOW-1): whether there is source, the similar-match
// address, and the name and compiler of the verified contract.
const LOOKUP_FIELDS: readonly string[] = ["SimilarMatch", "ContractName", "CompilerVersion"];

/**
 * Decides whether a client may send this request now: `true` to go on, `false` to refuse it with
 * 429. It runs before the body is read and must not read the body. It sees the method, the URL and
 * the headers, such as `Origin`, `Sec-Fetch-Site` or a client address header your platform sets.
 *
 * @example
 * ```ts
 * import type { RateLimit } from "explorer-verify/server";
 *
 * const counts = new Map<string, number>();
 * const rateLimit: RateLimit = (request) => {
 *   const client = request.headers.get("x-real-ip") ?? "unknown";
 *   const count = (counts.get(client) ?? 0) + 1;
 *   counts.set(client, count);
 *   return count <= 30;
 * };
 * ```
 * @experimental
 */
export type RateLimit = (request: Request) => boolean | Promise<boolean>;

/**
 * Options of {@link createVerifyHandler}. Only own properties are read, each once, when the
 * handler is created; later changes to the object have no effect. An optional field set to
 * `undefined` counts as absent. Any other key throws `invalid-input` naming it and, when one is
 * close, the option it may mean.
 *
 * @example
 * ```ts
 * import type { VerifyHandlerOptions } from "explorer-verify/server";
 *
 * const options: VerifyHandlerOptions = {
 *   apiKey: "dummy-key-0001",
 *   chains: [1, 11155111],
 * };
 * ```
 * @experimental
 */
export interface VerifyHandlerOptions {
  /**
   * The operator's Etherscan key: 8 to 1024 letters, digits, `.`, `_`, `~` or `-`, not all
   * digits, as `apiKeys` takes it (decision 0016). It goes only to `api.etherscan.io`, in the form
   * body of a POST, never in a URL.
   */
  readonly apiKey: string;
  /** The chain ids the handler serves: 1 to 10,000 positive safe integers. Others get 403. */
  readonly chains: readonly number[];
  /**
   * When set, a submit or a lookup is forwarded only when Etherscan's `getcontractcreation` names
   * one of these addresses as the contract's `contractCreator` or `contractFactory`. Up to 10,000
   * addresses; case does not matter. `contractCreator` is the sender of the creating transaction,
   * also for a contract a factory created, and listing a public factory admits anyone who uses it.
   */
  readonly deployers?: readonly string[] | undefined;
  /**
   * Whether the handler forwards the proxy-link actions, `verifyproxycontract` and
   * `checkproxyverification`, that `linkProxy()` sends (R-FLOW-8). Off by default: Etherscan links
   * a proxy whose source it has not verified, so a link request needs no source, and turning it on
   * lets whoever can reach the handler change a proxy's page under your key. With `deployers` set,
   * the deployer check runs on the proxy's `address`; `expectedimplementation` is not checked.
   */
  readonly allowProxyLink?: boolean | undefined;
  /** Called for every POST before its body is read. See {@link RateLimit}. */
  readonly rateLimit?: RateLimit | undefined;
  /**
   * The largest request body accepted, in bytes as received. A positive safe integer. Defaults to
   * {@link DEFAULT_MAX_BODY_BYTES}. A larger body gets 413 and is never parsed.
   */
  readonly maxBodyBytes?: number | undefined;
  /**
   * The time limit for one handled request, from its arrival to the answer, body read and
   * upstream requests included, in milliseconds. A positive safe integer. Defaults to
   * {@link DEFAULT_HANDLER_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * The `fetch` that sends the requests to Etherscan. Defaults to `globalThis.fetch`, read when
   * each request starts.
   */
  readonly fetch?: typeof fetch | undefined;
  /**
   * Receives a line for each refusal (`info`), each upstream failure (`warn`) and each internal
   * failure (`error`), in the shape of `VerifyOptions.logger` (R-DX-5). Every line is redacted of
   * the key; a logger that throws is ignored. Without it, nothing is logged.
   */
  readonly logger?: Logger | undefined;
}

export type { HandlerRefusal } from "./refusals.ts";

/**
 * The function {@link createVerifyHandler} returns: a standard `Request` to `Response` function.
 * It never rejects.
 *
 * @experimental
 */
export type VerifyHandler = (request: Request) => Promise<Response>;

/** The keys of {@link VerifyHandlerOptions}, in documentation order. */
function handlerOptionKeys(): readonly string[] {
  return Object.keys({
    apiKey: true,
    chains: true,
    deployers: true,
    allowProxyLink: true,
    rateLimit: true,
    maxBodyBytes: true,
    timeoutMs: true,
    fetch: true,
    logger: true,
  } satisfies Record<keyof VerifyHandlerOptions, true>);
}

/** The checked options. The key sits behind a function, so printing the settings shows none. */
interface Settings {
  readonly key: () => string;
  readonly chains: ReadonlySet<number>;
  readonly deployers: ReadonlySet<string> | undefined;
  readonly allowProxyLink: boolean;
  readonly rateLimit: RateLimit | undefined;
  readonly maxBodyBytes: number;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch | undefined;
  readonly observer: Observer;
}

/** A checked request, ready to forward. */
interface Forward {
  readonly action: Action;
  readonly chainId: number;
  /** The contract address of a submit or a lookup, in lower case with its `0x`. */
  readonly address: string | undefined;
  /** `module`, `action` and the action's fields, in that order, without `chainid`. */
  readonly body: URLSearchParams;
}

/** A refusal: the HTTP status, the code and a fixed sentence. It never leaves the handler. */
class Refusal extends Error {
  readonly status: number;
  readonly code: HandlerRefusal;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: HandlerRefusal,
    sentence: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(sentence);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** The headers of every response the handler writes. */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * The route the key module checks every upstream request against: Etherscan v2 at
 * `ETHERSCAN_API_URL`, not overridden, with that host as its `tableHost` and no `route.apiKey`.
 * `keyFor` attaches the key only to `https://` on the `tableHost` of a route that is not
 * overridden (decisions 0016 and 0023), so a wrong URL here would send no key. `requestUrl`
 * appends the path only: the handler adds `chainid` itself.
 */
const ETHERSCAN_ROUTE: Route = Object.freeze({
  backend: BACKEND,
  apiBase: ETHERSCAN_BASE,
  redactedApiUrl: ETHERSCAN_BASE,
  requestUrl: (path: string): string => `${ETHERSCAN_BASE}${path}`,
  explorerUrl: undefined,
  apiKey: (): undefined => undefined,
  overridden: false,
  tableHost: ETHERSCAN_HOST,
  // The handler's own route: no event carries these.
  routedBy: "api-url",
  skipped: [],
});

/**
 * Creates the handler that holds the operator's Etherscan key on their own server (R-SRV-1,
 * R-SRV-2). The browser reaches it through a `fetch` it passes to `verify()` (R-SRV-5); the
 * handler checks each request, adds the key and forwards it to Etherscan's v2 API.
 *
 * It accepts a `POST` with an `application/x-www-form-urlencoded` body. Each field may be in the
 * query or the body, once. In this order, it refuses:
 *
 * 1. any other method (405, with `Allow: POST`);
 * 2. a request the `rateLimit` hook refuses (429);
 * 3. another content type, or a `Content-Encoding` other than `identity` (415);
 * 4. a body above `maxBodyBytes`, by its `Content-Length` or as it streams in (413), before it is
 *    parsed; a body that does not arrive within `timeoutMs` (408);
 * 5. more than 16 fields, counted before parsing (400);
 * 6. a field that names an API key, a route, an API URL, a backend, a URL or a host, in any case
 *    (400): the handler routes from its own configuration only; a field given twice (400);
 * 7. a `module` other than `contract`, or an action other than `verifysourcecode`,
 *    `checkverifystatus`, `getsourcecode` and, with `allowProxyLink`, `verifyproxycontract` and
 *    `checkproxyverification` (403, R-SRV-3);
 * 8. a missing or malformed `chainid` (400), or a chain not in `chains` (403);
 * 9. a field the action does not take, a missing field, or a value of the wrong form (400);
 * 10. with `deployers` set, a submit or lookup for an address none of them created (403), or one
 *     Etherscan does not know yet (503, `address-not-indexed`).
 *
 * No header of the client's request goes upstream. Each upstream request is a form-encoded POST
 * with the key in its body and `redirect: "manual"`; a redirect answer is refused with 502 and
 * never followed. Each upstream call is retried at most once, and a submit only after a 429 or a
 * 503. The upstream JSON answer is returned with its status, every string in it redacted of the
 * key; an answer that is not a JSON object gets 502. A `getsourcecode` answer is reduced to
 * `status`, `message` and, of its first result, `SourceCode` replaced by {@link SOURCE_MARKER}
 * when it is not empty, `SimilarMatch`, `ContractName` and `CompilerVersion`. The handler adds no
 * CORS header.
 *
 * @param options - The key, the allowlists, the limits and the logger.
 * @returns The handler. It never rejects: every failure becomes a refusal.
 * @throws ExplorerVerifyError `invalid-input` when an option is missing or invalid. The issues name
 *   the field and never repeat a value.
 * @example
 * ```ts
 * import { createVerifyHandler } from "explorer-verify/server";
 *
 * const handler = createVerifyHandler({ apiKey: etherscanKey, chains: [1, 11155111] });
 * const response = await handler(request); // any runtime with Request and Response
 * ```
 * @experimental
 */
export function createVerifyHandler(options: VerifyHandlerOptions): VerifyHandler {
  const settings = readSettings(options);
  const { log } = settings.observer;
  return async (incoming: Request): Promise<Response> => {
    let refusal: Refusal;
    try {
      return await handle(settings, incoming);
    } catch (error: unknown) {
      if (error instanceof Refusal) {
        refusal = error;
      } else {
        // A hook that threw, a client that went away or a bug. Nothing of the error is
        // returned: it may repeat a value. The logger gets its message, redacted.
        log.error(`explorer-verify/server: internal error: ${messageOf(error)}`);
        refusal = new Refusal(500, "internal-error", "The handler failed.");
      }
    }
    log.info(`explorer-verify/server: refused with ${refusal.code}`, {
      status: refusal.status,
      code: refusal.code,
    });
    return refusalResponse(refusal);
  };
}

/** The message of a thrown value, as text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
}

async function handle(settings: Settings, incoming: Request): Promise<Response> {
  // One deadline for the whole request: the body read and every upstream request.
  const deadline = Date.now() + settings.timeoutMs;
  if (incoming.method !== "POST") {
    throw new Refusal(405, "method-not-allowed", "Only POST is accepted.", { allow: "POST" });
  }
  if (settings.rateLimit !== undefined && !(await settings.rateLimit(incoming))) {
    throw new Refusal(429, "rate-limited", "Too many requests. Try again later.");
  }
  // The media type: the text before the first `;`. A split with a limit of 1 gives one item, and
  // a missing header reads as "undefined", which is no media type.
  const type = String(incoming.headers.get("content-type")?.split(";", 1)).trim().toLowerCase();
  if (type !== FORM_TYPE) {
    throw new Refusal(415, "unsupported-media-type", `The body must be ${FORM_TYPE}.`);
  }
  const encoding = incoming.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    throw new Refusal(415, "unsupported-media-type", "The body must not be encoded.");
  }
  const text = await readBody(incoming, settings.maxBodyBytes, deadline);
  const query = new URL(incoming.url).search.slice(1);
  if (tooManyFields(query, text)) {
    throw new Refusal(
      400,
      "bad-request",
      `The request has more than ${String(MAX_FIELDS)} fields.`,
    );
  }
  const forward = parse(settings, new URLSearchParams(query), new URLSearchParams(text));

  const key = settings.key();
  const secrets = [key];
  const http: HttpContext = {
    backend: BACKEND,
    signal: incoming.signal,
    observer: settings.observer,
    secrets,
    requestTimeoutMs: settings.timeoutMs,
    maxResponseBytes: MAX_UPSTREAM_BYTES,
    budget: { deadline, timeoutMs: settings.timeoutMs },
    maxAttempts: UPSTREAM_ATTEMPTS,
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
  };
  const keyed: KeyContext = { route: ETHERSCAN_ROUTE, apiKeys: () => ({ [BACKEND]: key }) };

  if (forward.address !== undefined && settings.deployers !== undefined) {
    const creation = await creationCheck(
      http,
      keyed,
      forward.chainId,
      forward.address,
      settings.deployers,
    );
    if (creation !== undefined) {
      return answerResponse(creation.status, creation.value, secrets);
    }
  }
  const lookup = forward.action === "getsourcecode";
  const answer = await upstream(
    lookup ? { ...http, maxResponseBytes: MAX_RESPONSE_BYTES } : http,
    keyed,
    forward.chainId,
    forward.body,
    ACTIONS[forward.action].retry,
  );
  return answerResponse(answer.status, lookup ? reduceLookup(answer.json) : answer.value, secrets);
}

function refusalResponse(refusal: Refusal): Response {
  const body = { status: "0", message: "NOTOK", result: refusal.message, code: refusal.code };
  return new Response(JSON.stringify(body), {
    status: refusal.status,
    headers: { ...RESPONSE_HEADERS, ...refusal.headers },
  });
}

/** An upstream answer as the client gets it: every string redacted, then serialised again. */
function answerResponse(status: number, json: unknown, secrets: readonly string[]): Response {
  return new Response(JSON.stringify(redactDeep(json, secrets)), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

/**
 * `value` with every string, object key included, redacted. Redacting the parsed answer, not its
 * text, also catches a key the answer wrote with `\u` escapes.
 */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDeep(item, secrets));
  }
  const fields = readFields(value);
  if (fields === undefined) {
    return value;
  }
  return Object.fromEntries(
    [...fields].map(([name, item]) => [redact(name, secrets), redactDeep(item, secrets)]),
  );
}

/**
 * A `getsourcecode` answer reduced to what the client classifies (decision 0021): `status`,
 * `message`, and of the first result only whether it has source, `SimilarMatch`, `ContractName`
 * and `CompilerVersion`, and `Implementation` when it is an address, which `linkProxy()` reads
 * after a mismatch (R-FLOW-8). A `result` that is text, such as a key error, is kept.
 */
function reduceLookup(answer: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const reduced: Record<string, unknown> = {
    status: answer.get("status"),
    message: answer.get("message"),
  };
  const result = answer.get("result");
  if (typeof result === "string") {
    reduced["result"] = result;
  } else if (Array.isArray(result)) {
    const first = readFields(result[0]);
    const entry: Record<string, string> = {};
    if (first !== undefined) {
      const source = first.get("SourceCode");
      entry["SourceCode"] = typeof source === "string" && source !== "" ? SOURCE_MARKER : "";
      for (const name of LOOKUP_FIELDS) {
        const value = first.get(name);
        if (typeof value === "string") {
          entry[name] = value;
        }
      }
      // The proxy's implementation, only as an address: no other text is relayed.
      const digits = addressDigits(first.get("Implementation"));
      if (digits !== undefined) {
        entry["Implementation"] = `0x${digits}`;
      }
    }
    reduced["result"] = first === undefined ? [] : [entry];
  }
  return reduced;
}

/** An upstream answer: its status and its fields. */
interface Answer {
  readonly status: number;
  readonly json: Map<string, unknown>;
  /** The parsed answer, as sent. */
  readonly value: unknown;
}

/**
 * Sends one form-encoded POST to Etherscan with the key in its body, through the HTTP layer, which
 * sets `redirect: "manual"` and refuses a redirect (R-SEC-2). Maps a failure to a refusal.
 */
async function upstream(
  http: HttpContext,
  keyed: KeyContext,
  chainId: number,
  body: URLSearchParams,
  retry: RetryMode,
): Promise<Answer> {
  const req = withKey(keyed, BACKEND, {
    url: `${ETHERSCAN_ROUTE.requestUrl("")}?chainid=${String(chainId)}`,
    method: "POST",
    body,
    headers: { "content-type": FORM_TYPE },
    retry,
  });
  let response: Response;
  try {
    response = await request(http, req);
  } catch (error: unknown) {
    if (error instanceof ExplorerVerifyError) {
      // Stryker disable next-line OptionalChaining: equivalent. The handler always sets the observer.
      http.observer?.log.warn(`explorer-verify/server: upstream failed: ${error.message}`, {
        code: error.code,
      });
      throw upstreamRefusal(error);
    }
    // The client went away and its request's signal aborted: an internal error.
    throw error;
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const json = readFields(parsed);
  if (json === undefined) {
    throw new Refusal(502, "upstream-error", "Etherscan sent an answer that is not a JSON object.");
  }
  return { status: response.status, json, value: parsed };
}

/** The refusal for an error of the HTTP layer. Nothing of the error is returned. */
function upstreamRefusal(error: ExplorerVerifyError): Refusal {
  const { details } = error;
  if (details.code === "rate-limited") {
    const headers: Record<string, string> = {};
    if (details.retryAfterMs !== undefined) {
      headers["retry-after"] = String(Math.ceil(details.retryAfterMs / 1_000));
    }
    return upstreamRateLimited(headers);
  }
  if (details.code === "timeout") {
    return new Refusal(504, "upstream-timeout", "Etherscan did not answer in time.");
  }
  return upstreamError();
}

function upstreamRateLimited(headers: Readonly<Record<string, string>> = {}): Refusal {
  return new Refusal(
    429,
    "upstream-rate-limited",
    "Etherscan is rate limiting this server. Try again later.",
    headers,
  );
}

function upstreamError(): Refusal {
  return new Refusal(
    502,
    "upstream-error",
    "Etherscan could not be reached, redirected the request or sent an unusable answer.",
  );
}

/**
 * The deployer check (R-SRV-4): asks Etherscan's `getcontractcreation` who created `address`.
 *
 * - `status` `"1"` and a record naming an allowed `contractCreator` or `contractFactory`: go on
 *   (`undefined`). A record naming none: 403. No record: 503 `address-not-indexed`.
 * - A key answer (`Missing/Invalid API Key`, `Invalid API Key`): returned, so the client sees
 *   Etherscan's own answer, redacted.
 * - A daily limit or a rate limit: 429. `No data found`: 503. Anything else, an HTTP status
 *   other than 2xx included: 502. A transient answer is never a 403.
 */
async function creationCheck(
  http: HttpContext,
  keyed: KeyContext,
  chainId: number,
  address: string,
  deployers: ReadonlySet<string>,
): Promise<Answer | undefined> {
  const body = new URLSearchParams({
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: address,
  });
  const answer = await upstream(http, keyed, chainId, body, "safe");
  // The HTTP layer returns only 2xx, 4xx and 5xx answers; a redirect is already refused.
  // Etherscan answers a 4xx or 5xx with no creation record to trust.
  if (answer.status >= 400) {
    throw upstreamError();
  }
  const { json } = answer;
  const status = json.get("status");
  const result = json.get("result");
  if (status === "1" && Array.isArray(result)) {
    if (result.length === 0) {
      throw notIndexed();
    }
    if (createdBy(result, address, deployers)) {
      return undefined;
    }
    throw new Refusal(
      403,
      "address-not-allowed",
      "The contract was not created by an allowed deployer or factory.",
    );
  }
  if (status !== "0") {
    throw upstreamError();
  }
  const keyError = keyErrorOf(BACKEND, Object.fromEntries(json), http.secrets);
  if (keyError?.code === "quota-exceeded") {
    throw upstreamRateLimited();
  }
  if (keyError !== undefined) {
    return answer;
  }
  const text = `${String(json.get("message"))} ${typeof result === "string" ? result : ""}`;
  if (/rate limit/i.test(text)) {
    throw upstreamRateLimited();
  }
  if (/no data found/i.test(text) || (Array.isArray(result) && result.length === 0)) {
    throw notIndexed();
  }
  throw upstreamError();
}

function notIndexed(): Refusal {
  return new Refusal(
    503,
    "address-not-indexed",
    "Etherscan has no creation record for this address yet. Try again later.",
    { "retry-after": String(INDEX_RETRY_SECONDS) },
  );
}

/** Whether a creation record names an allowed creator or factory of `address`. */
function createdBy(
  result: readonly unknown[],
  address: string,
  deployers: ReadonlySet<string>,
): boolean {
  return result.some((entry: unknown) => {
    // An entry that is not an object has no fields, so it names no contract.
    const fields = readFields(entry) ?? new Map<string, unknown>();
    const contract = fields.get("contractAddress");
    if (typeof contract !== "string" || contract.toLowerCase() !== address) {
      return false;
    }
    return ["contractCreator", "contractFactory"].some((name) => {
      const value = fields.get(name);
      return typeof value === "string" && deployers.has(value.toLowerCase());
    });
  });
}

/**
 * The body as text, read chunk by chunk within the request's deadline. A body that passes `limit`
 * bytes is refused with 413 at once, so it is never held whole or parsed; a body still arriving at
 * the deadline is refused with 408. In both cases the stream is cancelled. A `Content-Length`
 * above the limit is refused before any byte is read.
 */
async function readBody(incoming: Request, limit: number, deadline: number): Promise<string> {
  const declared = incoming.headers.get("content-length")?.trim();
  if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > limit) {
    throw tooLarge(limit);
  }
  const stream = incoming.body;
  if (stream === null) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const chunk = await readWithin(reader, deadline);
    if (chunk.done) {
      return text + decoder.decode();
    }
    received += chunk.value.byteLength;
    if (received > limit) {
      reader.cancel().catch(() => {});
      throw tooLarge(limit);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/**
 * The next chunk, raced against the deadline.
 *
 * @throws Refusal 408 at the deadline, after cancelling the stream; 400 when the read fails.
 */
async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(
      () => {
        resolve("expired");
      },
      Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_MS),
    );
  });
  let chunk: ReadableStreamReadResult<Uint8Array> | "expired";
  try {
    chunk = await Promise.race([reader.read(), expired]);
  } catch {
    throw new Refusal(400, "bad-request", "The body could not be read.");
  } finally {
    clearTimeout(timer);
  }
  if (chunk === "expired") {
    reader.cancel().catch(() => {});
    throw new Refusal(408, "request-timeout", "The body did not arrive in time.");
  }
  return chunk;
}

function tooLarge(limit: number): Refusal {
  return new Refusal(413, "body-too-large", `The body is larger than ${String(limit)} bytes.`);
}

/**
 * Whether the query and the body hold more than {@link MAX_FIELDS} fields together, counted by
 * their `&` separators before any parsing. It stops at the first field over the cap.
 */
function tooManyFields(...texts: readonly string[]): boolean {
  let count = 0;
  for (const text of texts) {
    if (text === "") {
      continue;
    }
    count += 1;
    for (let at = text.indexOf("&"); at !== -1; at = text.indexOf("&", at + 1)) {
      count += 1;
      if (count > MAX_FIELDS) {
        return true;
      }
    }
  }
  return count > MAX_FIELDS;
}

/**
 * Checks the fields of the query and the body, and builds the upstream body. It stops at the
 * first forbidden or repeated name. A sentence names known fields only and never repeats a value
 * or an unknown name.
 */
function parse(settings: Settings, query: URLSearchParams, form: URLSearchParams): Forward {
  const fields = new Map<string, string>();
  for (const [name, value] of [...query, ...form]) {
    if (FORBIDDEN_FIELDS.includes(name.toLowerCase())) {
      throw new Refusal(
        400,
        "forbidden-field",
        "The request must not name an API key, a route, an API URL, a backend, a URL or a host: the handler routes from its own configuration.",
      );
    }
    if (fields.has(name)) {
      throw new Refusal(400, "bad-request", "A field appears more than once.");
    }
    fields.set(name, value);
  }

  const actionName = fields.get("action");
  // The proxy-link actions only when the operator turned them on.
  const allowed = settings.allowProxyLink ? ACTION_NAMES : ACTION_NAMES.slice(0, 3);
  const action = allowed.find((name) => name === actionName);
  if (fields.get("module") !== "contract" || action === undefined) {
    throw new Refusal(
      403,
      "action-not-allowed",
      settings.allowProxyLink
        ? "Only module contract with the verifysourcecode, checkverifystatus, getsourcecode, verifyproxycontract or checkproxyverification action is forwarded."
        : "Only module contract with the verifysourcecode, checkverifystatus or getsourcecode action is forwarded.",
    );
  }

  // A missing chainid reads as "undefined", which is no chain id.
  const chainText = String(fields.get("chainid"));
  const chainId = CHAIN_ID.test(chainText) ? readChainId(Number(chainText)) : undefined;
  if (chainId === undefined) {
    throw new Refusal(400, "bad-request", "chainid must be a positive integer.");
  }
  if (!settings.chains.has(chainId)) {
    throw new Refusal(403, "chain-not-allowed", "This chain is not served here.");
  }

  const { required, optional, address } = ACTIONS[action];
  const taken: readonly string[] = [...required, ...optional];
  const unknown = [...fields.keys()].filter(
    (name) => name !== "module" && name !== "action" && name !== "chainid" && !taken.includes(name),
  ).length;
  if (unknown > 0) {
    throw new Refusal(
      400,
      "bad-request",
      `The request has ${String(unknown)} ${unknown === 1 ? "field" : "fields"} that ${action} does not take.`,
    );
  }
  const missing = required.filter((name) => (fields.get(name) ?? "") === "");
  if (missing.length > 0) {
    throw new Refusal(400, "bad-request", `Missing fields: ${missing.join(", ")}.`);
  }
  const invalid = invalidFields(fields);
  if (invalid.length > 0) {
    throw new Refusal(400, "bad-request", `Invalid fields: ${invalid.join(", ")}.`);
  }

  const body = new URLSearchParams({ module: "contract", action });
  for (const name of taken) {
    const value = fields.get(name);
    if (value !== undefined) {
      body.set(name, value);
    }
  }
  const contract = address === undefined ? undefined : fields.get(address)?.toLowerCase();
  return { action, chainId, address: contract, body };
}

/** The checks of field values, by field name. */
const VALUE_CHECKS: readonly (readonly [string, (value: string) => boolean])[] = [
  ["contractaddress", (value) => addressDigits(value) !== undefined],
  ["address", (value) => addressDigits(value) !== undefined],
  ["expectedimplementation", (value) => addressDigits(value) !== undefined],
  ["guid", (value) => JOB_ID.test(value)],
  ["contractname", (value) => value.length <= MAX_NAME_LENGTH],
  ["compilerversion", (value) => COMPILER_VERSION.test(value)],
  ["codeformat", (value) => CODE_FORMAT.test(value)],
  ["constructorArguments", (value) => HEX.test(value)],
  ["constructorArguements", (value) => HEX.test(value)],
  ["licenseType", (value) => LICENSE.test(value)],
];

/** The names of the fields whose value has the wrong form. */
function invalidFields(fields: ReadonlyMap<string, string>): string[] {
  return VALUE_CHECKS.filter(([name, check]) => {
    const value = fields.get(name);
    return value !== undefined && !check(value);
  }).map(([name]) => name);
}

/**
 * Reads and checks the options.
 *
 * @throws ExplorerVerifyError `invalid-input` naming each bad field, never its value.
 */
function readSettings(options: VerifyHandlerOptions): Settings {
  const read = readOptions(options);
  const issues: InputIssue[] = [];
  const rawKey: unknown = read.apiKey;
  const secrets = typeof rawKey === "string" ? [rawKey] : [];
  const checked = checkKey(rawKey);
  if (typeof checked === "string") {
    issues.push({ field: "apiKey", message: checked });
  }
  const chains = readList(read.chains, "chains", CHAINS_MESSAGE, issues, readChainId);
  if (chains?.size === 0) {
    issues.push({ field: "chains", message: "must hold at least one chain id" });
  }
  const rawDeployers: unknown = read.deployers;
  const deployers =
    rawDeployers === undefined
      ? undefined
      : readList(rawDeployers, "deployers", DEPLOYERS_MESSAGE, issues, (item) => {
          const digits = addressDigits(item);
          return digits === undefined ? undefined : `0x${digits.toLowerCase()}`;
        });
  for (const field of ["rateLimit", "fetch"] as const) {
    const value: unknown = read[field];
    if (value !== undefined && typeof value !== "function") {
      issues.push({ field, message: "must be a function" });
    }
  }
  const allowProxyLink: unknown = read.allowProxyLink;
  if (allowProxyLink !== undefined && typeof allowProxyLink !== "boolean") {
    issues.push({ field: "allowProxyLink", message: "must be a boolean" });
  }
  const rawLogger: unknown = read.logger;
  if (
    rawLogger !== undefined &&
    (rawLogger === null || (typeof rawLogger !== "object" && typeof rawLogger !== "function"))
  ) {
    issues.push({ field: "logger", message: "must be an object" });
  }
  const maxBodyBytes = readLimit(read.maxBodyBytes, "maxBodyBytes", DEFAULT_MAX_BODY_BYTES, issues);
  const timeoutMs = readLimit(read.timeoutMs, "timeoutMs", DEFAULT_HANDLER_TIMEOUT_MS, issues);

  if (typeof checked === "string" || chains === undefined || issues.length > 0) {
    throw invalidOptions(issues, secrets);
  }
  const { key } = checked;
  return {
    key: () => key,
    chains,
    deployers,
    allowProxyLink: allowProxyLink === true,
    rateLimit: read.rateLimit,
    maxBodyBytes,
    timeoutMs,
    fetch: read.fetch,
    observer: createObserver({ logger: read.logger, secrets: [key] }),
  };
}

/**
 * The options' own properties, each read once.
 *
 * @throws ExplorerVerifyError `invalid-input` when `options` is not a plain object or a getter
 *   throws. The thrown error is dropped: its message may repeat a value.
 */
function readOptions(options: VerifyHandlerOptions): {
  readonly [K in keyof VerifyHandlerOptions]-?: VerifyHandlerOptions[K] | undefined;
} {
  const value: unknown = options;
  const notPlain = invalidOptions(
    [{ field: "options", message: "must be a plain object" }],
    // Stryker disable next-line ArrayDeclaration: untestable sentinel. No value is known here, and the message names only the field, never Stryker's placeholder text.
    [],
  );
  if (typeof value !== "object" || value === null) {
    throw notPlain;
  }
  let unknown: InputIssue[];
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw notPlain;
    }
    unknown = unknownKeys(Object.keys(value), handlerOptionKeys(), "", "options");
  } catch {
    throw notPlain;
  }
  if (unknown.length > 0) {
    throw invalidOptions(unknown, []);
  }
  try {
    return {
      apiKey: readOwn(options, "apiKey"),
      chains: readOwn(options, "chains"),
      deployers: readOwn(options, "deployers"),
      allowProxyLink: readOwn(options, "allowProxyLink"),
      rateLimit: readOwn(options, "rateLimit"),
      maxBodyBytes: readOwn(options, "maxBodyBytes"),
      timeoutMs: readOwn(options, "timeoutMs"),
      fetch: readOwn(options, "fetch"),
      logger: readOwn(options, "logger"),
    };
  } catch {
    throw notPlain;
  }
}

/** A list option as a set, or `undefined` with one issue when it or an item is invalid. */
function readList<T>(
  value: unknown,
  field: string,
  message: string,
  issues: InputIssue[],
  item: (value: unknown) => T | undefined,
): Set<T> | undefined {
  if (!Array.isArray(value)) {
    issues.push({ field, message: "must be an array" });
    return undefined;
  }
  if (value.length > MAX_LIST_LENGTH) {
    issues.push({ field, message: `must hold at most ${String(MAX_LIST_LENGTH)} items` });
    return undefined;
  }
  const set = new Set<T>();
  for (const entry of value) {
    const checked = item(entry);
    if (checked === undefined) {
      issues.push({ field, message });
      return undefined;
    }
    set.add(checked);
  }
  return set;
}

/** An optional positive safe integer option, or its default. */
function readLimit(
  value: number | undefined,
  field: string,
  fallback: number,
  issues: InputIssue[],
): number {
  const raw: unknown = value;
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  issues.push({ field, message: "must be a positive safe integer" });
  return fallback;
}

function invalidOptions(issues: InputIssue[], secrets: readonly string[]): ExplorerVerifyError {
  return newError(
    { code: "invalid-input", issues },
    `The handler options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    {
      hint: "Pass apiKey as your Etherscan key and chains as the chain ids to serve, as the server handler docs show.",
      secrets,
    },
  );
}
