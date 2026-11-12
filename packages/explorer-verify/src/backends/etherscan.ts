// References: R-BE-1, R-BE-5, R-BE-2, decision 0016, R-SEC-1, R-FLOW-4.
/**
 * The Etherscan API v2 client, and {@link etherscanStyle}, which builds it and the other
 * clients of APIs that answer as Etherscan does: Routescan's  and standalone explorers'. For
 * Etherscan, one
 * API base serves every chain, with `chainid` in the query of each request. Every request is a
 * form-encoded POST, so the key goes in the body and never in the URL.
 *
 * Etherscan answers almost everything with HTTP 200 and puts the meaning in the `result` text. The
 * client maps each known text to an outcome or a typed error; a text it does not know is never
 * read as success, "not verified" or `failed`. The evidence for each mapping is in
 * docs/contributor/research/2026-11-04-etherscan-client.md, and for Routescan's texts in
 * docs/contributor/research/2026-11-04-routescan-client.md.
 */
import type { BackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { AnyExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/check-handle.ts";
import { keyErrorOf, withKey } from "../http/api-keys.ts";
import type { HttpRequest, RetryMode } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
import { NOT_INDEXED_ANSWER } from "../not-indexed.ts";
import { redactExcerpt } from "../redact.ts";
import type { FailureReasonCode, Handle } from "../types.ts";
import type {
  Backend,
  Context,
  Found,
  PollOutcome,
  ResolvedInput,
  SubmitOutcome,
  Target,
} from "./backend.ts";
import {
  attemptSubmit,
  checkHandle,
  explorerUrl,
  foundOf,
  REASON_LENGTH,
  resultOf,
  send,
  standardJsonFields,
  submitOnce,
  UNCONFIRMED_STATUSES,
  unexpected as unexpectedAnswer,
  waitToResubmit,
} from "./common.ts";
import type { Answer, SubmitAttempt } from "./common.ts";

/**
 * The most submits sent while the explorer finds no contract code at the address, the first
 * included, when the call has no `indexWaitMs`.
 */
export const MAX_NOT_INDEXED_TRIES = 10;

// The `result` texts the client knows, matched at the start. Sources: the research notes above.
const RATE_LIMIT = "Max calls per sec rate limit reached";
const NOT_INDEXED = NOT_INDEXED_ANSWER;
const NO_CHAIN = "Missing or unsupported chainid parameter";
// Routescan's answer for a chain or network it does not serve, in `message`, with `result` null.
const CHAIN_NOT_SUPPORTED = "chain not supported";
// Etherscan's answer on its retired v1 hosts, such as api.etherscan.io/api or
// api-sepolia.basescan.org/api (live, 2026-11-03 and 2026-11-04).
const V1_ENDPOINT = "You are using a deprecated V1 endpoint";
const V1_HINT = "Use the etherscan-v2 backend without route.apiUrl.";
const PENDING = "Pending in queue";
const PASS = "Pass - Verified";
const FAIL = "Fail - Unable to verify";
// Routescan's answer to a poll without a `guid`: the request was malformed, not the job unknown.
const MISSING_GUID = "Missing guid";
const ALREADY_VERIFIED: readonly string[] = [
  "Contract source code already verified",
  "Already Verified",
];
// Etherscan's two texts, then Routescan's, which it also gives for a job it has forgotten.
const NO_JOB: readonly string[] = [
  "Unable to locate guid",
  "Invalid GUID length",
  "Verification not found",
];

// References: R-FLOW-4, decision 0073.
/**
 * The cause an Etherscan-style rejection names, read from its text in lower case. The phrases are
 * those of Etherscan's documented verification errors (docs.etherscan.io, "Common Verification
 * Errors", read 2026-11-12) and the recorded bytecode mismatches of Etherscan and Routescan
 * (docs/contributor/research/2026-11-04-live-matrix.md). A missing source comes first: solc words it
 * `Source "<path>" not found`, inside a compilation error.
 *
 * @param text - The `result` text of a rejected job.
 * @returns The reason code, `unknown` for a text that names none of them.
 * @example
 * ```ts
 * reasonCodeOf("Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.");
 * // "bytecode-mismatch"
 * ```
 */
export function reasonCodeOf(text: string): FailureReasonCode {
  const lower = text.toLowerCase();
  return /source "[^"]*" not found/.test(lower)
    ? "missing-source"
    : lower.includes("constructor argument")
      ? "constructor-args"
      : lower.includes("library was required")
        ? "libraries"
        : lower.includes("unable to locate contractname")
          ? "contract-name"
          : lower.includes("bytecode does not match") || lower.includes("bytecodehash")
            ? "bytecode-mismatch"
            : lower.includes("compilation error") || lower.includes("solc version")
              ? "compiler"
              : "unknown";
}

/**
 * What sets one Etherscan-style API apart: its backend, its name in messages, and how a lookup
 * or a status request is sent. A submit is always a form-encoded POST to `route.requestUrl("")`.
 *
 * @example
 * ```ts
 * const dialect: Dialect = { name: "routescan", label: "Routescan", read: unique };
 * ```
 */
export interface Dialect {
  /** The backend, as in `BACKEND_NAMES`. */
  readonly name: BackendName;
  /** The API's name in messages, such as `Etherscan`. */
  readonly label: string;
  /**
   * Builds a `getsourcecode` or `checkverifystatus` request. `fields` holds `action` and the
   * action's fields, without `module`. `backend` is the client's, or the handle's for a poll, and
   * is passed to `withKey`.
   */
  readonly read: (
    ctx: Context,
    backend: BackendName,
    fields: Record<string, string>,
  ) => HttpRequest;
  // References: R-IN-3.
  /**
   * Whether the client reads the creation code with `getcontractcreation`. Set for
   * Etherscan, whose answer was checked live on 2026-11-03 and 2026-11-04.
   */
  readonly creation?: boolean;
  /**
   * Status texts, besides `Fail - Unable to verify`, that reject the submitted source. Each is a
   * prefix of `result`. A match gives `failed` with the text as the reason, without a lookup.
   */
  readonly rejections?: readonly string[];
  /**
   * Whether a lookup answered with `status` `"1"` and an empty `result` list means "not verified".
   * Bitlayer's standalone API answers so for an unverified address (live, 2026-11-05). Etherscan
   * answers with one record whose `SourceCode` is empty, so for it an empty list throws.
   */
  readonly emptyLookup?: boolean;
  // References: R-FLOW-3, decision 0063.
  /**
   * Whether the API states no grade, so every match, from a lookup or from `Pass - Verified`, is
   * `partial`. Set for Routescan: its `getsourcecode` has no `SimilarMatch` field, and it reported
   * `Pass - Verified` for a build that Sourcify and Blockscout grade partial (live, 2026-11-10).
   */
  readonly ungraded?: boolean;
  /**
   * A response header that holds the wait after a rate-limit answer in whole seconds, read when
   * `Retry-After` is absent. Passed to the HTTP layer with the submit; `read` sets it on its own
   * requests.
   */
  readonly retryAfterHeader?: string;
}

/**
 * Builds a client for an API that answers as Etherscan's does. Every call is one of these, with
 * `module=contract`:
 *
 * | Call   | `action`            | Fields                                                    |
 * | ------ | ------------------- | --------------------------------------------------------- |
 * | lookup | `getsourcecode`     | `address`                                                 |
 * | submit | `verifysourcecode`  | the Standard JSON input, the contract, compiler, arguments |
 * | poll   | `checkverifystatus` | `guid`                                                    |
 *
 * `Max calls per sec rate limit reached` is retried by the HTTP layer as a 429 is. A daily limit
 * throws `quota-exceeded`, and a key answer `missing-api-key` or `api-key-rejected`, at once.
 * `Free API access is not supported for this chain`, a free-plan key on a chain that needs a paid
 * plan, is a key answer: `api-key-rejected`. For Etherscan v2, its hint names the paid plan and
 * Sourcify.
 * Etherscan's unsupported `chainid` answer and Routescan's `chain not supported` both throw
 * `unsupported-chain`. Etherscan's `You are using a deprecated V1 endpoint` throws
 * `unexpected-response`, never `failed`, with a hint to use the `etherscan-v2` backend without
 * `route.apiUrl`: the route points at a retired Etherscan host.
 *
 * @param dialect - The backend, its name in messages, and how it sends a lookup or a poll.
 * @returns The client.
 * @example
 * ```ts
 * export const etherscan: Backend = etherscanStyle({ name: "etherscan-v2", label: "Etherscan", read });
 * ```
 */
export function etherscanStyle(dialect: Dialect): Backend {
  const { name, label, read } = dialect;
  // Stryker disable next-line ArrayDeclaration: equivalent. No result starts with the text Stryker puts here.
  const rejections = dialect.rejections ?? [];

  /**
   * Asks whether the contract is verified, with `getsourcecode`. A first result with a non-empty
   * `SourceCode` is a match: `partial` when `SimilarMatch` names another contract or the dialect
   * sets `ungraded`, else `exact`. `ContractName` and `CompilerVersion` name the stored contract.
   * An empty `SourceCode` is "not verified", and so is an empty `result` list when the dialect
   * sets `emptyLookup`. Every other answer throws.
   */
  async function lookup(target: Target, ctx: Context): Promise<Found | undefined> {
    const answer = await send(
      ctx,
      read(ctx, name, { action: "getsourcecode", address: target.address }),
    );
    known(ctx, answer, target.chainId);
    const result = answer.fields?.get("result");
    if (answer.status === 200 && answer.fields?.get("status") === "1" && Array.isArray(result)) {
      if (result.length === 0 && dialect.emptyLookup === true) {
        return undefined;
      }
      const first = readFields(result[0]);
      const source = first?.get("SourceCode");
      if (typeof source === "string") {
        if (source === "") {
          return undefined;
        }
        // Stryker disable next-line OptionalChaining: equivalent. first holds the SourceCode just read, so it exists.
        const similar = first?.get("SimilarMatch");
        // A non-empty SimilarMatch: Etherscan matched the contract from another contract's
        // verified source.
        const own = similar === undefined || similar === "";
        if (own || typeof similar === "string") {
          return foundOf(
            ctx,
            own && dialect.ungraded !== true ? "exact" : "partial",
            // Stryker disable next-line OptionalChaining: equivalent. first holds the SourceCode just read, so it exists.
            first?.get("ContractName"),
            // Stryker disable next-line OptionalChaining: equivalent. first holds the SourceCode just read, so it exists.
            first?.get("CompilerVersion"),
          );
        }
      }
    }
    throw unexpected(ctx, answer, "the lookup");
  }

  /**
   * Submits the source with `verifysourcecode`. A submit that may have reached the explorer
   * without an answer (no response, a 500, 502 or 504, or a 200 whose body failed, stalled or is
   * not JSON) is never sent again blindly: the client looks the contract up first.
   */
  async function submit(input: ResolvedInput, ctx: Context): Promise<SubmitOutcome> {
    const fields = standardJsonFields(input);
    // validateInput gives 0x and an even number of hex digits: the digits follow the 0x.
    const args = input.constructorArgs?.slice(2) ?? "";
    if (args !== "") {
      // Etherscan's docs name `constructorArguments`; the misspelled field is the one its own
      // examples and older tools send. Both carry the same bare hex.
      fields["constructorArguments"] = args;
      fields["constructorArguements"] = args;
    }
    const req = form(ctx, name, fields, "submit", dialect.retryAfterHeader);
    const unconfirmed = (answer: Answer): AnyExplorerVerifyError | undefined =>
      UNCONFIRMED_STATUSES.includes(answer.status) ||
      (answer.status === 200 && answer.fields === undefined)
        ? unexpected(ctx, answer, "the submit")
        : undefined;
    // References: R-FLOW-7, decision 0066.
    // Sends the submit, and sends it again every `pollIntervalMs` while the explorer answers that
    // it finds no contract code at the address, as Etherscan does right after a deployment it has
    // not indexed yet. Each wait emits `verify.retry` with `reason` `not-indexed`. It goes on while
    // a whole `pollIntervalMs` fits in `indexWaitMs` from the first submit, or for
    // MAX_NOT_INDEXED_TRIES answers without it, and never past the budget's deadline. Then it
    // throws `not-indexed`. `since` and `submits` are shared by both tries of submitOnce, so a
    // submit sent again after one without a clear answer keeps the wait and the count. `submits`
    // counts those answers, not requests.
    const since = Date.now();
    let submits = 0;
    const untilIndexed = async (): Promise<SubmitAttempt> => {
      const sent = await attemptSubmit(ctx, req, unconfirmed);
      if (sent.kind === "unconfirmed" || resultOf(sent.answer)?.startsWith(NOT_INDEXED) !== true) {
        return sent;
      }
      const wait = ctx.indexWaitMs;
      const count = ++submits;
      await waitToResubmit(ctx, sent.answer, count, {
        backend: name,
        reason: "not-indexed",
        what: `${label} found no contract code at the address`,
        // Stryker disable next-line StringLiteral: equivalent. end builds the error, with its own hint.
        hint: "",
        maxTries: wait === undefined ? MAX_NOT_INDEXED_TRIES : Infinity,
        until: since + (wait ?? Infinity),
        end: (message) =>
          newError(
            { code: "not-indexed", backend: name, submits: count, elapsedMs: Date.now() - since },
            message,
            // Stryker disable next-line ObjectLiteral: equivalent. The message holds only the explorer's label and the number of submits.
            { secrets: ctx.http.secrets },
          ),
      });
      return await untilIndexed();
    };
    return await submitOnce(
      ctx,
      name,
      label,
      input,
      untilIndexed,
      async (answer) => await readSubmit(input, ctx, answer),
      lookup,
    );
  }

  /** Maps a submit answer to its outcome. */
  async function readSubmit(
    input: ResolvedInput,
    ctx: Context,
    answer: Answer,
  ): Promise<SubmitOutcome> {
    const result = known(ctx, answer, input.chainId);
    if (answer.status === 200 && result !== undefined) {
      // Stryker disable next-line OptionalChaining: equivalent. knownAnswer gives a result only for an answer with fields.
      if (answer.fields?.get("status") === "1" && JOB_ID.test(result)) {
        return {
          state: "submitted",
          handle: {
            version: 1,
            backend: name,
            chainId: input.chainId,
            address: input.address,
            jobId: result,
          },
        };
      }
      if (startsWithAny(result, ALREADY_VERIFIED)) {
        // The answer does not say the grade, and the outcome needs it: one lookup reads it.
        const found = await lookup(input, ctx);
        if (found !== undefined) {
          return { state: "already-verified", ...found };
        }
        throw unexpected(
          ctx,
          answer,
          `${label} answered that the contract is already verified, but a lookup found it not verified.`,
          true,
        );
      }
    }
    throw unexpected(ctx, answer, "the submit");
  }

  // References: R-FLOW-2.
  /**
   * Asks once for the state of a job with `checkverifystatus`. The handle is checked first: it
   * may come from storage. `Fail - Unable to verify` is checked with one lookup, because it was
   * once answered for a contract that the lookup showed verified moments later. A text in the
   * dialect's `rejections` gives `failed` at once. An unknown job
   * throws `job-not-found`, and the flow then looks the contract up once.
   */
  async function poll(handle: Handle, ctx: Context): Promise<PollOutcome> {
    checkHandle(handle, name, label, ctx);
    const answer = await send(
      ctx,
      read(ctx, handle.backend, { action: "checkverifystatus", guid: handle.jobId }),
    );
    const result = known(ctx, answer, handle.chainId);
    if (answer.status !== 200 || result === undefined || result.startsWith(MISSING_GUID)) {
      throw unexpected(ctx, answer, "the job status request");
    }
    if (result.startsWith(PENDING)) {
      return { state: "pending" };
    }
    if (result.startsWith(PASS)) {
      return { state: "verified", match: dialect.ungraded === true ? "partial" : "exact" };
    }
    if (startsWithAny(result, ALREADY_VERIFIED)) {
      return { state: "already-verified" };
    }
    if (result.startsWith(FAIL)) {
      // A lookup that fails throws: a verdict it could not check is not reported as `failed`. An
      // exact match means the job did verify the source. A partial one is Etherscan's own match
      // from another contract's source, while the submitted source was rejected:
      // `already-verified`. The flow compares the stored contract with the input.
      const found = await lookup(handle, ctx);
      const reason = redactExcerpt(result, ctx.http.secrets, REASON_LENGTH);
      if (found === undefined) {
        return { state: "failed", reason, reasonCode: reasonCodeOf(result), notVerified: true };
      }
      return found.match === "exact"
        ? { state: "verified", ...found }
        : { state: "already-verified", ...found, reason };
    }
    if (startsWithAny(result, rejections)) {
      return {
        state: "failed",
        reason: redactExcerpt(result, ctx.http.secrets, REASON_LENGTH),
        reasonCode: reasonCodeOf(result),
      };
    }
    if (startsWithAny(result, NO_JOB)) {
      throw newError(
        { code: "job-not-found", handle },
        `${label} does not know the verification job ${handle.jobId}.`,
        { secrets: ctx.http.secrets },
      );
    }
    throw newError(
      { code: "unknown-state", handle, excerpt: answer.text },
      `${label} reported a job state for ${handle.jobId} that this client does not recognise; the result is not known.`,
      { secrets: ctx.http.secrets },
    );
  }

  /** See {@link knownAnswer}. */
  function known(ctx: Context, answer: Answer, chainId: number): string | undefined {
    return knownAnswer(name, label, ctx, answer, chainId);
  }

  /** `unexpected-response` for this client; see `unexpectedAnswer` in common.ts. */
  function unexpected(
    ctx: Context,
    answer: Answer,
    what: string,
    whole = false,
  ): AnyExplorerVerifyError {
    return unexpectedAnswer(ctx, name, label, answer, what, whole);
  }

  /**
   * The creation code with `getcontractcreation`. `verify()` asks only when a key is bound to the
   * route: a keyless request may reach a server handler, which does not forward this action. The
   * record whose `contractAddress` is the contract gives its `creationBytecode`. `No data found`
   * and a record without it give `undefined`; any other answer throws.
   */
  async function creationCode(target: Target, ctx: Context): Promise<string | undefined> {
    const answer = await send(
      ctx,
      read(ctx, name, {
        action: "getcontractcreation",
        contractaddresses: target.address,
      }),
    );
    const message = answer.fields?.get("message");
    known(ctx, answer, target.chainId);
    const result = answer.fields?.get("result");
    if (answer.status === 200 && answer.fields?.get("status") === "1" && Array.isArray(result)) {
      for (const entry of result) {
        const fields = readFields(entry);
        const address = fields?.get("contractAddress");
        const code = fields?.get("creationBytecode");
        if (typeof address === "string" && address.toLowerCase() === target.address) {
          return typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code)
            ? code
            : undefined;
        }
      }
      return undefined;
    }
    if (answer.status === 200 && message === "No data found") {
      return undefined;
    }
    throw unexpected(ctx, answer, "the creation code request");
  }

  return {
    name,
    lookup,
    submit,
    poll,
    explorerUrl,
    takesConstructorArgs: true,
    refusesOtherBuilds: true,
    ...(dialect.creation === true ? { creationCode } : {}),
  };
}

/**
 * The Etherscan API v2 client. Every request is
 * `POST https://api.etherscan.io/v2/api?chainid=<id>` with a form body that holds
 * `module=contract`,
 * the action and its fields, and the key as `apikey`.
 *
 * @example
 * ```ts
 * const ctx: Context = {
 *   route: resolveRoute(11155111, { backend: "etherscan-v2" }, { apiKeys }),
 *   apiKeys: () => apiKeys,
 *   http: { backend: "etherscan-v2", secrets: [apiKeys["etherscan-v2"]] },
 * };
 * const match = await etherscan.lookup({ chainId: 11155111, address }, ctx);
 * ```
 */
export const etherscan: Backend = /* @__PURE__ */ etherscanStyle({
  name: "etherscan-v2",
  label: "Etherscan",
  read: post,
  creation: true,
});

/**
 * Throws for an answer any Etherscan-style call can get: a key or daily-limit answer, an
 * unsupported chain, or a v1 endpoint. Returns the `result` text, or `undefined` when `result` is
 * not text. The clients and the proxy-link code read every answer through it.
 *
 * @param name - The backend.
 * @param label - The API's name in messages, such as `Etherscan`.
 * @param ctx - The call's context, for its secrets.
 * @param answer - The answer.
 * @param chainId - The chain of the call, for `unsupported-chain`.
 * @returns The `result` text, or `undefined`.
 * @throws ExplorerVerifyError `missing-api-key`, `api-key-rejected`, `quota-exceeded`,
 *   `unsupported-chain` or `unexpected-response`.
 * @example
 * ```ts
 * const result = knownAnswer("etherscan-v2", "Etherscan", ctx, answer, 11155111);
 * ```
 */
export function knownAnswer(
  name: BackendName,
  label: string,
  ctx: Context,
  answer: Answer,
  chainId: number,
): string | undefined {
  const { fields } = answer;
  if (fields === undefined) {
    return undefined;
  }
  const keyError = keyErrorOf(name, Object.fromEntries(fields), ctx.http.secrets);
  if (keyError !== undefined) {
    throw keyError;
  }
  const result = resultOf(answer);
  if (result?.startsWith(NO_CHAIN) === true || fields.get("message") === CHAIN_NOT_SUPPORTED) {
    throw newError(
      { code: "unsupported-chain", backend: name, chainId },
      `${label} does not support chain ${String(chainId)}.`,
      // Stryker disable next-line ObjectLiteral: equivalent. The message holds only the API's name and the chain id.
      { secrets: ctx.http.secrets },
    );
  }
  if (result?.startsWith(V1_ENDPOINT) === true) {
    throw newError(
      { code: "unexpected-response", backend: name, status: answer.status, excerpt: answer.text },
      `${label} answered that the request went to Etherscan's deprecated v1 API.`,
      { hint: V1_HINT, secrets: ctx.http.secrets },
    );
  }
  return result;
}

/**
 * A lookup or a status request as Etherscan takes it: a form-encoded POST to
 * `route.requestUrl("")`, safe to retry, with the key in the body when `withKey` allows one.
 *
 * @param ctx - The call's context.
 * @param backend - The backend the request is for, passed to `withKey`.
 * @param fields - `action` and its fields, without `module`.
 * @returns The request.
 * @example
 * ```ts
 * const req = post(ctx, "etherscan-compatible", { action: "getsourcecode", address });
 * ```
 */
export function post(
  ctx: Context,
  backend: BackendName,
  fields: Record<string, string>,
): HttpRequest {
  return form(ctx, backend, fields, "safe");
}

/**
 * A form-encoded POST to `route.requestUrl("")`, which for Etherscan holds `chainid` in the
 * query, with the key the key rule allows: in the body for Etherscan, in a header for Routescan.
 * The body is built with `URLSearchParams` only, so a value cannot add a field.
 *
 * @param ctx - The call's context.
 * @param backend - The backend the request is for, passed to `withKey`.
 * @param fields - `action` and its fields, without `module`.
 * @param retry - The HTTP layer's retry mode.
 * @param retryAfterHeader - The header that holds the wait after a rate-limit answer, when the API
 *   sends it in place of `Retry-After`.
 * @returns The request.
 * @example
 * ```ts
 * const req = form(ctx, "etherscan-v2", { action: "getsourcecode", address }, "safe");
 * ```
 */
function form(
  ctx: Context,
  backend: BackendName,
  fields: Record<string, string>,
  retry: RetryMode,
  retryAfterHeader?: string,
): HttpRequest {
  return withKey(ctx, backend, {
    url: ctx.route.requestUrl(""),
    method: "POST",
    body: new URLSearchParams({ module: "contract", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    retry,
    rateLimited,
    ...(retryAfterHeader === undefined ? {} : { retryAfterHeader }),
  });
}

/**
 * Whether a body is Etherscan's per-second rate-limit answer, which comes with HTTP 200.
 *
 * @param body - The response text.
 * @returns `true` when `result` starts with `Max calls per sec rate limit reached`.
 * @example
 * ```ts
 * rateLimited('{"status":"0","result":"Max calls per sec rate limit reached (5/sec)"}'); // true
 * ```
 */
export function rateLimited(body: string): boolean {
  // A lookup body can hold a whole source: only a body that holds the text is parsed.
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent when always false, for bodies that write the text unescaped, as Etherscan's do. The parse below gives false for such a body without the text; the check only saves the parse.
  if (!body.includes(RATE_LIMIT)) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: parsed stays undefined, so the body is not the rate-limit answer.
  }
  const result = readFields(parsed)?.get("result");
  return typeof result === "string" && result.startsWith(RATE_LIMIT);
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}
