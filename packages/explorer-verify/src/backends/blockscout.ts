/**
 * The Blockscout client for single-chain instances (R-BE-3). Each instance serves its own API at
 * `<origin>/api`, needs no key and answers browsers directly. The submit and the job status go to
 * the Etherscan-compatible `/api`; the lookup goes to the instance's REST API,
 * `/api/v2/smart-contracts/{address}`, which says whether a match is full or partial. No request
 * carries a key (decision 0016).
 *
 * Blockscout answers a submit and a status request with HTTP 200 and puts the meaning in the
 * `result` text. `status` `"1"` alone never means success: an unknown job also comes with it. The
 * client maps each known text to an outcome or a typed error; a text it does not know is never
 * read as success, "not verified" or `failed` (R-FLOW-4). The evidence for each mapping is in
 * docs/contributor/research/2026-11-04-blockscout-client.md.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/handle.ts";
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

const NAME: BackendName = "blockscout";
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
export const blockscout: Backend = {
  name: NAME,
  lookup,
  submit,
  poll,
  explorerUrl,
  takesConstructorArgs: true,
};

/**
 * Asks the instance's REST API whether the contract is verified. A 200 with `is_verified` `true`
 * gives `exact` (`is_fully_verified`) or `partial` (`is_partially_verified`). A 200 with
 * `is_verified` `false`, or with no verification fields and the contract's bytecode, and a 404
 * `Not found` mean not verified. Every other answer throws.
 */
async function lookup(target: Target, ctx: Context): Promise<Match | undefined> {
  const answer = await send(ctx, {
    url: ctx.route.requestUrl(`/v2/smart-contracts/${encodeURIComponent(target.address)}`),
    method: "GET",
    retry: "safe",
  });
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
  throw unexpected(ctx, answer, "the lookup");
}

/**
 * Submits the source with `verifysourcecode`. A submit that may have reached Blockscout without an
 * answer (no response, a 500, 502 or 504, or a 200 whose body failed, stalled or is not JSON) is
 * never sent again blindly: the client looks the contract up first. So is a submit that got an
 * empty answer.
 */
async function submit(input: ResolvedInput, ctx: Context): Promise<SubmitOutcome> {
  const fields = standardJsonFields(input);
  const args = (input.constructorArgs ?? "").replace(/^0x/i, "");
  if (args !== "") {
    // Blockscout 12 refuses arguments that are not 0x-prefixed hex.
    fields["constructorArguments"] = `0x${args}`;
  }
  const req = form(ctx, fields, "submit");
  const target: Target = { chainId: input.chainId, address: input.address };
  const unconfirmed = (answer: Answer): ExplorerVerifyError | undefined =>
    UNCONFIRMED_STATUSES.includes(answer.status) ||
    (answer.status === 200 && answer.fields === undefined)
      ? unexpected(ctx, answer, "the submit")
      : undefined;
  const until = Date.now() + EMPTY_SUBMIT_WINDOW_MS;
  const once = async (attempt: number): Promise<SubmitOutcome> =>
    await submitOnce(
      ctx,
      NAME,
      LABEL,
      target,
      async () => await attemptSubmit(ctx, req, unconfirmed),
      async (answer) => {
        if (!emptyAnswer(answer)) {
          return await readSubmit(input, ctx, answer);
        }
        await waitToResubmit(ctx, answer, attempt, {
          backend: NAME,
          reason: "empty-submit",
          what: "Blockscout gave no job id",
          hint: "If the contract was deployed moments ago, call verify() again later.",
          maxTries: MAX_EMPTY_SUBMITS,
          until,
        });
        // The empty answer may hide a submit Blockscout accepted: look first.
        const match = await lookupAfterUnclear(ctx, target, lookup);
        return match === undefined ? await once(attempt + 1) : { state: "already-verified", match };
      },
      lookup,
    );
  return await once(1);
}

/** Whether a submit answer is a 200 with `status` `"1"` and an empty, `null` or absent `result`. */
function emptyAnswer({ status, fields }: Answer): boolean {
  const result = fields?.get("result");
  return (
    status === 200 &&
    fields?.get("status") === "1" &&
    (result === undefined || result === null || result === "")
  );
}

/** Maps a submit answer that is not empty to its outcome. */
async function readSubmit(
  input: ResolvedInput,
  ctx: Context,
  answer: Answer,
): Promise<SubmitOutcome> {
  const result = answer.status === 200 ? resultOf(answer) : undefined;
  if (answer.fields?.get("status") === "1" && result !== undefined && JOB_ID.test(result)) {
    return {
      state: "submitted",
      handle: {
        version: 1,
        backend: NAME,
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
      answer,
      "Blockscout answered that the contract is already verified, but a lookup found it not verified.",
      true,
    );
  }
  if (result === NOT_A_CONTRACT) {
    throw new ExplorerVerifyError(
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
  throw unexpected(ctx, answer, "the submit");
}

/**
 * Asks once for the state of a job with `checkverifystatus`. The handle is checked first: it may
 * come from storage. `Pass - Verified` does not say the grade, so one lookup reads it.
 */
async function poll(handle: Handle, ctx: Context): Promise<PollOutcome> {
  checkHandle(handle, NAME, LABEL, ctx);
  const answer = await send(
    ctx,
    form(ctx, { action: "checkverifystatus", guid: handle.jobId }, "safe"),
  );
  const result = answer.status === 200 ? resultOf(answer) : undefined;
  if (result === undefined) {
    throw unexpected(ctx, answer, "the job status request");
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
    throw new ExplorerVerifyError(
      { code: "job-not-found", handle },
      `Blockscout does not know the verification job ${handle.jobId}.`,
      { secrets: ctx.http.secrets },
    );
  }
  throw new ExplorerVerifyError(
    { code: "unknown-state", handle, excerpt: answer.text },
    result === PASS
      ? `Blockscout reported job ${handle.jobId} verified, but a lookup found the contract not verified; the result is not known.`
      : `Blockscout reported a job state for ${handle.jobId} that this client does not recognise; the result is not known.`,
    { secrets: ctx.http.secrets },
  );
}

/**
 * A form-encoded POST to the instance's `/api`. The body is built with `URLSearchParams` only, so a
 * value cannot add a field. It never holds a key.
 */
function form(ctx: Context, fields: Record<string, string>, retry: RetryMode): HttpRequest {
  return {
    url: ctx.route.requestUrl(""),
    method: "POST",
    body: new URLSearchParams({ module: "contract", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    retry,
  };
}

/** `unexpected-response` for this client; see `unexpectedAnswer` in common.ts. */
function unexpected(
  ctx: Context,
  answer: Answer,
  what: string,
  whole = false,
): ExplorerVerifyError {
  return unexpectedAnswer(ctx, NAME, LABEL, answer, what, whole);
}
