/**
 * The Blockscout clients (R-BE-3): `blockscout` for a single-chain instance and
 * `blockscout-hosted` for Blockscout's hosted multichain API (decision 0041). Each instance serves
 * its own API at `<origin>/api`, needs no key and answers browsers directly. The hosted API serves
 * each chain it indexes at `https://api.blockscout.com/<chainId>/api`, with the same requests and
 * answers, and needs a key, which `withKey` puts in the `authorization` header. The submit and the
 * job status go to the Etherscan-compatible `/api`; the lookup goes to the REST API,
 * `/api/v2/smart-contracts/{address}`, which says whether a match is full or partial. Only the
 * hosted client reads the key answers, HTTP 401 and 402; see {@link refusal}.
 *
 * Blockscout answers a submit and a status request with HTTP 200 and puts the meaning in the
 * `result` text. `status` `"1"` alone never means success: an unknown job also comes with it. The
 * client maps each known text to an outcome or a typed error; a text it does not know is never
 * read as success, "not verified" or `failed` (R-FLOW-4). The evidence for each mapping is in
 * docs/contributor/research/2026-11-04-blockscout-client.md.
 */
import type { BackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { AnyExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/handle.ts";
import { keyFor, withKey } from "../http/api-keys.ts";
import type { HttpRequest, RetryMode } from "../http/fetch.ts";
import { redactExcerpt } from "../redact.ts";
import type { Handle } from "../types.ts";
import type {
  Backend,
  Context,
  Match,
  PollOutcome,
  ResolvedInput,
  SubmitOutcome,
  Target,
} from "./backend.ts";
import {
  attemptSubmit,
  checkHandle,
  explorerUrl,
  lookupAfterUnclear,
  REASON_LENGTH,
  resultOf,
  send,
  standardJsonFields,
  submitOnce,
  UNCONFIRMED_STATUSES,
  unexpected as unexpectedAnswer,
  waitToResubmit,
} from "./common.ts";
import type { Answer } from "./common.ts";

/** The two Blockscout backends. */
type Name = Extract<BackendName, "blockscout" | "blockscout-hosted">;
const HOSTED: Name = "blockscout-hosted";
const LABEL = "Blockscout";
/**
 * How long after the first submit the client may still submit again while Blockscout gives an
 * empty answer, as it can right after a deployment (R-FLOW-7).
 */
export const EMPTY_SUBMIT_WINDOW_MS = 30_000;
/**
 * The most submits while Blockscout gives an empty answer, the first included: 3 more. An
 * instance's `/api` allowed only 10 requests per window of about 22 minutes on 2026-11-04.
 */
export const MAX_EMPTY_SUBMITS = 4;

// The texts the client knows. Sources: the research note above.
const ALREADY_VERIFIED = "Smart-contract already verified.";
const NOT_A_CONTRACT = "Address is not a smart-contract";
const PENDING = "Pending in queue";
const PASS = "Pass - Verified";
const FAIL = "Fail - Unable to verify";
const UNKNOWN_UID = "Unknown UID";

/**
 * The Blockscout client for one instance. `route.apiBase` is the instance's `/api`, such as
 * `https://eth-sepolia.blockscout.com/api`; the resolver refuses a Blockscout route whose API URL
 * does not end in `/api`.
 *
 * | Call   | Request                                                                      |
 * | ------ | ---------------------------------------------------------------------------- |
 * | lookup | `GET <apiBase>/v2/smart-contracts/{address}`                                 |
 * | submit | `POST <apiBase>`, form body `module=contract&action=verifysourcecode` and fields |
 * | poll   | `POST <apiBase>`, form body `module=contract&action=checkverifystatus&guid=…` |
 *
 * A 429 is retried by the HTTP layer. An empty answer to a submit is followed by a lookup and a
 * new submit, at most {@link MAX_EMPTY_SUBMITS} submits within {@link EMPTY_SUBMIT_WINDOW_MS}.
 *
 * @example
 * ```ts
 * const ctx: Context = {
 *   route: resolveRoute(84532, { backend: "blockscout", apiUrl: "https://base-sepolia.blockscout.com/api" }),
 *   http: { backend: "blockscout", secrets: [] },
 * };
 * const match = await blockscout.lookup({ chainId: 84532, address }, ctx);
 * ```
 */
export const blockscout: Backend = client("blockscout");

/**
 * The client for Blockscout's hosted API, `https://api.blockscout.com/<chainId>/api`: the
 * instance client's requests with `apiKeys["blockscout-hosted"]` in the `authorization` header,
 * and the hosted API's key answers mapped by {@link refusal} (decision 0041).
 *
 * @example
 * ```ts
 * const ctx: Context = {
 *   route: resolveRoute(11155111, { backend: "blockscout-hosted" }),
 *   apiKeys: () => ({ "blockscout-hosted": key }),
 *   http: { backend: "blockscout-hosted", secrets: [key] },
 * };
 * const match = await blockscoutHosted.lookup({ chainId: 11155111, address }, ctx);
 * ```
 */
export const blockscoutHosted: Backend = client(HOSTED);

/** The client of one Blockscout backend. Only the hosted one reads key answers. */
function client(name: Name): Backend {
  /**
   * Asks the instance's REST API whether the contract is verified. A 200 with `is_verified` `true`
   * gives `exact` (`is_fully_verified`) or `partial` (`is_partially_verified`). A 200 with
   * `is_verified` `false`, or with no verification fields and the contract's bytecode, and a 404
   * `Not found` mean not verified. Every other answer throws.
   */
  async function lookup(target: Target, ctx: Context): Promise<Match | undefined> {
    const answer = await ask(ctx, name, lookupRequest(ctx, name, target.address), target.chainId);
    const { status, fields } = answer;
    if (status === 404 && fields?.get("message") === "Not found") {
      return undefined;
    }
    if (status === 200 && fields !== undefined) {
      const verified = fields.get("is_verified");
      if (verified === true) {
        if (fields.get("is_fully_verified") === true) {
          return "exact";
        }
        if (fields.get("is_partially_verified") === true) {
          return "partial";
        }
      } else if (
        verified === false ||
        // An unverified contract: only its code, no verification fields.
        (verified === undefined &&
          !fields.has("is_fully_verified") &&
          !fields.has("is_partially_verified") &&
          typeof fields.get("deployed_bytecode") === "string")
      ) {
        return undefined;
      }
    }
    throw unexpected(ctx, name, answer, "the lookup");
  }

  /**
   * Submits the source with `verifysourcecode`. A submit that may have reached Blockscout without an
   * answer (no response, a 500, 502 or 504, or a 200 whose body failed, stalled or is not JSON) is
   * never sent again blindly: the client looks the contract up first. So is a submit that got an
   * empty answer.
   */
  async function submit(input: ResolvedInput, ctx: Context): Promise<SubmitOutcome> {
    const fields = standardJsonFields(input);
    // validateInput gives 0x and an even number of hex digits: the digits follow the 0x.
    const args = input.constructorArgs?.slice(2) ?? "";
    if (args !== "") {
      // Blockscout 12 refuses arguments that are not 0x-prefixed hex.
      fields["constructorArguments"] = `0x${args}`;
    }
    const req = form(ctx, name, fields, "submit");
    const target: Target = { chainId: input.chainId, address: input.address };
    const unconfirmed = (answer: Answer): AnyExplorerVerifyError | undefined =>
      UNCONFIRMED_STATUSES.includes(answer.status) ||
      (answer.status === 200 && answer.fields === undefined)
        ? unexpected(ctx, name, answer, "the submit")
        : undefined;
    const until = Date.now() + EMPTY_SUBMIT_WINDOW_MS;
    const once = async (attempt: number): Promise<SubmitOutcome> =>
      await submitOnce(
        ctx,
        name,
        LABEL,
        target,
        async () => await attemptSubmit(ctx, req, unconfirmed),
        async (answer) => {
          if (!emptyAnswer(answer)) {
            return await readSubmit(input, ctx, answer);
          }
          await waitToResubmit(ctx, answer, attempt, {
            backend: name,
            reason: "empty-submit",
            what: "Blockscout gave no job id",
            hint: "If the contract was deployed moments ago, call verify() again later.",
            maxTries: MAX_EMPTY_SUBMITS,
            until,
          });
          // The empty answer may hide a submit Blockscout accepted: look first.
          const match = await lookupAfterUnclear(ctx, target, lookup);
          return match === undefined
            ? await once(attempt + 1)
            : { state: "already-verified", match };
        },
        lookup,
      );
    return await once(1);
  }

  /** Maps a submit answer that is not empty to its outcome. */
  async function readSubmit(
    input: ResolvedInput,
    ctx: Context,
    answer: Answer,
  ): Promise<SubmitOutcome> {
    const refused = name === HOSTED ? refusal(ctx, answer, input.chainId) : undefined;
    if (refused !== undefined) {
      throw refused;
    }
    const result = answer.status === 200 ? resultOf(answer) : undefined;
    if (answer.fields?.get("status") === "1" && result !== undefined && JOB_ID.test(result)) {
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
    if (result === ALREADY_VERIFIED) {
      // Blockscout says this only for a full match, and the outcome needs the grade: one lookup.
      const match = await lookup({ chainId: input.chainId, address: input.address }, ctx);
      if (match !== undefined) {
        return { state: "already-verified", match };
      }
      throw unexpected(
        ctx,
        name,
        answer,
        "Blockscout answered that the contract is already verified, but a lookup found it not verified.",
        true,
      );
    }
    if (result === NOT_A_CONTRACT) {
      throw newError(
        {
          code: "invalid-input",
          issues: [{ field: "address", message: "is not a contract, Blockscout answered" }],
        },
        "The input is invalid: address.",
        {
          hint: "Check chainId, address and route.apiUrl.",
          secrets: ctx.http.secrets,
        },
      );
    }
    throw unexpected(ctx, name, answer, "the submit");
  }

  /**
   * Asks once for the state of a job with `checkverifystatus`. The handle is checked first: it may
   * come from storage. `Pass - Verified` does not say the grade, so one lookup reads it.
   */
  async function poll(handle: Handle, ctx: Context): Promise<PollOutcome> {
    checkHandle(handle, name, LABEL, ctx);
    const answer = await ask(
      ctx,
      name,
      form(ctx, name, { action: "checkverifystatus", guid: handle.jobId }, "safe"),
      handle.chainId,
    );
    const result = answer.status === 200 ? resultOf(answer) : undefined;
    if (result === undefined) {
      throw unexpected(ctx, name, answer, "the job status request");
    }
    if (result === PENDING) {
      return { state: "pending" };
    }
    if (result === PASS) {
      const match = await lookup(handle, ctx);
      if (match !== undefined) {
        return { state: "verified", match };
      }
    } else if (result === FAIL) {
      return { state: "failed", reason: redactExcerpt(result, ctx.http.secrets, REASON_LENGTH) };
    } else if (result === UNKNOWN_UID) {
      throw newError(
        { code: "job-not-found", handle },
        `Blockscout does not know the verification job ${handle.jobId}.`,
        { secrets: ctx.http.secrets },
      );
    }
    throw newError(
      { code: "unknown-state", handle, excerpt: answer.text },
      result === PASS
        ? `Blockscout reported job ${handle.jobId} verified, but a lookup found the contract not verified; the result is not known.`
        : `Blockscout reported a job state for ${handle.jobId} that this client does not recognise; the result is not known.`,
      { secrets: ctx.http.secrets },
    );
  }

  return { name, lookup, submit, poll, explorerUrl, takesConstructorArgs: true };
}

/** Whether a submit answer is a 200 with `status` `"1"` and an empty, `null` or absent `result`. */
function emptyAnswer({ status, fields }: Answer): boolean {
  const result = fields?.get("result");
  return (
    status === 200 &&
    // Stryker disable next-line OptionalChaining: equivalent. A 200 without a JSON body is unconfirmed, so no empty-answer check gets one.
    fields?.get("status") === "1" &&
    (result === undefined || result === null || result === "")
  );
}

/**
 * A form-encoded POST to the route's `/api`, through `withKey`. The body is built with
 * `URLSearchParams` only, so a value cannot add a field. It never holds a key: on the hosted API
 * the key goes in the `authorization` header.
 *
 * @param ctx - The call's context.
 * @param name - The backend, which `withKey` checks against the route.
 * @param fields - The fields besides `module=contract`.
 * @param retry - The retry mode.
 * @returns The request.
 * @example
 * ```ts
 * const req = form(ctx, "blockscout", { action: "checkverifystatus", guid }, "safe");
 * ```
 */
export function form(
  ctx: Context,
  name: Name,
  fields: Record<string, string>,
  retry: RetryMode,
): HttpRequest {
  return withKey(ctx, name, {
    url: ctx.route.requestUrl(""),
    method: "POST",
    body: new URLSearchParams({ module: "contract", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    retry,
  });
}

/**
 * The REST lookup of a contract, `GET <apiBase>/v2/smart-contracts/{address}`, through `withKey`.
 *
 * @param ctx - The call's context.
 * @param name - The backend, which `withKey` checks against the route.
 * @param address - The contract address.
 * @returns The request.
 * @example
 * ```ts
 * const answer = await ask(ctx, "blockscout", lookupRequest(ctx, "blockscout", address), chainId);
 * ```
 */
export function lookupRequest(ctx: Context, name: Name, address: string): HttpRequest {
  return withKey(ctx, name, {
    url: ctx.route.requestUrl(`/v2/smart-contracts/${encodeURIComponent(address)}`),
    method: "GET",
    retry: "safe",
  });
}

/**
 * Sends one request. For `blockscout-hosted`, throws the error {@link refusal} finds in the
 * answer; an instance's answers are left to the client, so an instance's 401 or 402 is never read
 * as a key error.
 *
 * @param ctx - The call's context.
 * @param name - The backend.
 * @param req - The request, from {@link form} or {@link lookupRequest}.
 * @param chainId - The chain of the call, for `unsupported-chain`.
 * @returns The answer.
 * @throws ExplorerVerifyError `missing-api-key`, `api-key-rejected` or `unsupported-chain` from
 *   the hosted API, and every error of the HTTP layer.
 * @example
 * ```ts
 * const answer = await ask(ctx, "blockscout-hosted", lookupRequest(ctx, "blockscout-hosted", address), 1);
 * ```
 */
export async function ask(
  ctx: Context,
  name: Name,
  req: HttpRequest,
  chainId: number,
): Promise<Answer> {
  const answer = await send(ctx, req);
  const refused = name === HOSTED ? refusal(ctx, answer, chainId) : undefined;
  if (refused !== undefined) {
    throw refused;
  }
  return answer;
}

// The hosted API's answer for a free-plan key on a chain that needs a paid plan, in `error`:
// `Featured chain 84532 requires one of the following plans: Builder, Business, Pro` with HTTP 402
// (live, 2026-11-05). Lower-cased.
const PLAN_NEEDED = "requires one of the following plans";
const PLAN_HINT =
  "Use a key whose plan covers this chain, or the backend blockscout, an instance that needs no key.";

/**
 * The error an answer of Blockscout's hosted API reports about the key or the chain, or
 * `undefined` (decision 0041). Answers recorded on 2026-11-05:
 *
 * - HTTP 401, `{"error":"Unauthorized"}`, for a key the API does not know: `api-key-rejected`.
 * - HTTP 402 when the request carried a key, or with `requires one of the following plans`: the
 *   key's plan or credits do not cover the request, `api-key-rejected`. Blockscout's docs say a
 *   free plan is refused once its daily credits are spent, without the answer's text.
 * - Any other HTTP 402, as `Proceed with API key or make a X402 payment to continue` for a request
 *   without a key: `missing-api-key`.
 * - HTTP 404 with `error` `Network not supported`: `unsupported-chain`.
 *
 * The error names the backend only, never the key or the explorer's text.
 *
 * @param ctx - The call's context.
 * @param answer - The answer.
 * @param chainId - The chain of the call.
 * @returns The error to throw, or `undefined`.
 * @example
 * ```ts
 * const error = refusal(ctx, { status: 402, text, fields }, 11155111); // missing-api-key
 * ```
 */
export function refusal(
  ctx: Context,
  answer: Answer,
  chainId: number,
): AnyExplorerVerifyError | undefined {
  const { status, fields } = answer;
  const raw = fields?.get("error");
  const text = typeof raw === "string" ? raw.toLowerCase() : "";
  const { secrets } = ctx.http;
  const backend = HOSTED;
  if (status === 404 && text === "network not supported") {
    return newError(
      { code: "unsupported-chain", backend, chainId },
      `Blockscout's hosted API does not serve chain ${String(chainId)}.`,
      { secrets },
    );
  }
  const keyed = keyFor(ctx, backend, ctx.route.apiBase) !== undefined;
  if (status === 401 || (status === 402 && (keyed || text.includes(PLAN_NEEDED)))) {
    return newError(
      { code: "api-key-rejected", backend },
      `${backend} refused the API key, or its plan or credits for this request.`,
      { hint: PLAN_HINT, secrets },
    );
  }
  return status === 402
    ? newError(
        { code: "missing-api-key", backend },
        `${backend} answered that the API key is missing.`,
        { secrets },
      )
    : undefined;
}

/** `unexpected-response` for this client; see `unexpectedAnswer` in common.ts. */
function unexpected(
  ctx: Context,
  name: Name,
  answer: Answer,
  what: string,
  whole = false,
): AnyExplorerVerifyError {
  return unexpectedAnswer(ctx, name, LABEL, answer, what, whole);
}
