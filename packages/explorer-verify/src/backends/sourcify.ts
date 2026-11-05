/**
 * The Sourcify API v2 client (R-BE-4). Sourcify needs no key and answers browsers directly. The
 * v1 API was switched off on 2026-07-07, so only v2 is used. Every answer is mapped to a match, a
 * poll outcome or a typed error; an answer the client does not recognise is never read as "not
 * verified" or as success (R-FLOW-4). The evidence for each mapping is in
 * docs/contributor/research/2026-11-02-sourcify-v2.md.
 */
import type { BackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { AnyExplorerVerifyError, ExplorerVerifyError } from "../errors.ts";
import type { HttpRequest } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
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
  REASON_LENGTH,
  send,
  submitOnce,
  UNCONFIRMED_STATUSES,
  unexpected as unexpectedAnswer,
} from "./common.ts";
import type { Answer } from "./common.ts";

export { REASON_LENGTH };

const NAME: BackendName = "sourcify";
/** The client's name in messages and log lines. */
const LABEL = "Sourcify";

/**
 * Job error codes that mean Sourcify rejected the source for good: submitting the same input
 * again gives the same answer. A job that ends with one of them is `failed`.
 */
export const DEFINITIVE_CODES: readonly string[] = [
  "no_match",
  "bytecode_length_mismatch",
  "compiler_error",
  "missing_source",
  "missing_or_invalid_source",
  "invalid_compilation_target",
  "contract_not_found_in_compiler_output",
  "runtime_bytecode_not_found_in_compiler_output",
  "invalid_compiler_version",
  "unsupported_compiler_version",
  "invalid_language",
  "unsupported_language",
  "compiled_bytecode_is_zero",
  "onchain_bytecode_is_zero",
  "extra_file_input_bug",
];

/**
 * Job error codes that may clear up when the same input is submitted again later: a server
 * problem, a compiler that ran out of time or memory, or bytecode the server could not fetch yet,
 * as right after a deployment. A job that ends with one of them throws `verification-inconclusive`.
 */
export const TRANSIENT_CODES: readonly string[] = [
  "internal_error",
  "job_abandoned",
  "compiler_timeout",
  "compiler_out_of_memory",
  "no_compiler_output",
  "cannot_fetch_bytecode",
  "onchain_runtime_bytecode_not_available",
  "onchain_creation_bytecode_not_available",
  "contract_not_deployed",
];

const VERIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The longest explorer error code quoted in an error message.
const CODE_LENGTH = 100;

/** The JSON body of a submit. `stdJsonInput` is an object, not a JSON string. */
interface SubmitBody {
  stdJsonInput: {
    language: string;
    sources: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  compilerVersion: string;
  contractIdentifier: string;
  creationTransactionHash?: string;
}

/**
 * The Sourcify API v2 client.
 *
 * | Call   | Request                                                        |
 * | ------ | -------------------------------------------------------------- |
 * | lookup | `GET /v2/contract/{chainId}/{address}`, without `fields=all`   |
 * | submit | `POST /v2/verify/{chainId}/{address}` with a JSON body         |
 * | poll   | `GET /v2/verify/{verificationId}`                              |
 *
 * A 200 lookup can be up to an hour old (`cache-control: public,max-age=3600`); a job result is
 * newer and wins over it.
 *
 * @example
 * ```ts
 * const ctx: Context = { route: resolveRoute(11155111), http: { backend: "sourcify", secrets: [] } };
 * const match = await sourcify.lookup({ chainId: 11155111, address }, ctx);
 * if (match === undefined) {
 *   const outcome = await sourcify.submit(input, ctx);
 *   if (outcome.state === "submitted") {
 *     const state = await sourcify.poll(outcome.handle, ctx);
 *   }
 * }
 * ```
 */
export const sourcify: Backend = {
  name: NAME,
  lookup,
  submit,
  poll,
  explorerUrl,
};

/**
 * Asks Sourcify whether the contract is verified. A 200 gives the match, a 404 whose body has a
 * `null` match means not verified, and a 400 `unsupported_chain` throws `unsupported-chain`. Every
 * other answer throws `unexpected-response`.
 */
async function lookup(target: Target, ctx: Context): Promise<Match | undefined> {
  const answer = await send(ctx, {
    url: ctx.route.requestUrl(contractPath("contract", target)),
    method: "GET",
    retry: "safe",
  });
  const { status, fields } = answer;
  if ((status === 200 || status === 404) && fields?.has("match") === true) {
    if (sameContract(fields, target, true)) {
      const match = fields.get("match");
      if (status === 200) {
        const grade = toMatch(match);
        if (grade !== undefined) {
          return grade;
        }
      } else if (match === null) {
        return undefined;
      }
    }
  } else if (status === 400 && codeOf(fields) === "unsupported_chain") {
    throw unsupportedChain(ctx, target.chainId);
  }
  throw unrecognised(ctx, answer, "the lookup");
}

/**
 * Submits the source. A submit may have reached Sourcify without the client learning its job id:
 * no response, a 500, 502 or 504, a 2xx whose body failed or stalled, or a 202 that is not JSON. The client
 * then looks the contract up, and submits once more only when the lookup finds it not verified.
 */
async function submit(input: ResolvedInput, ctx: Context): Promise<SubmitOutcome> {
  const target: Target = { chainId: input.chainId, address: input.address };
  const req: HttpRequest = {
    url: ctx.route.requestUrl(contractPath("verify", target)),
    method: "POST",
    body: JSON.stringify(submitBody(input)),
    headers: { "content-type": "application/json" },
    retry: "submit",
  };
  // A 500, 502 or 504, or a 202 that is not JSON, may come after Sourcify received the submit.
  const unconfirmed = (answer: Answer): AnyExplorerVerifyError | undefined =>
    UNCONFIRMED_STATUSES.includes(answer.status) ||
    (answer.status === 202 && answer.fields === undefined)
      ? unrecognised(ctx, answer, "the submit")
      : undefined;
  return await submitOnce(
    ctx,
    NAME,
    LABEL,
    target,
    async () => await attemptSubmit(ctx, req, unconfirmed),
    (answer) => readSubmit(input, ctx, answer),
    lookup,
  );
}

/** Asks once for the state of a job. The handle is checked first: it may come from storage. */
async function poll(handle: Handle, ctx: Context): Promise<PollOutcome> {
  checkHandle(handle, NAME, LABEL, ctx);
  const answer = await send(ctx, {
    url: ctx.route.requestUrl(`/v2/verify/${encodeURIComponent(handle.jobId)}`),
    method: "GET",
    retry: "safe",
  });
  const { status, fields } = answer;
  if (status === 404 && codeOf(fields) === "job_not_found") {
    throw newError(
      { code: "job-not-found", handle },
      `Sourcify does not know the verification job ${handle.jobId}.`,
      { secrets: ctx.http.secrets },
    );
  }
  const completed = fields?.get("isJobCompleted");
  if (status !== 200 || fields === undefined || typeof completed !== "boolean") {
    throw unrecognised(ctx, answer, "the job status request");
  }
  const contract = readFields(fields.get("contract"));
  if (fields.has("verificationId") && fields.get("verificationId") !== handle.jobId) {
    throw unexpected(
      ctx,
      answer,
      `Sourcify answered the status request for job ${handle.jobId} about another job.`,
    );
  }
  if (contract !== undefined && !sameContract(contract, handle, false)) {
    throw unexpected(
      ctx,
      answer,
      `Sourcify answered the status request for job ${handle.jobId} about another contract.`,
    );
  }
  if (!completed) {
    return { state: "pending" };
  }
  const match = toMatch(contract?.get("match"));
  const error = readFields(fields.get("error"));
  if (error === undefined) {
    if (match !== undefined) {
      return { state: "verified", match };
    }
    throw unknownState(ctx, handle, answer, "a completed job with neither a match nor an error");
  }
  const code = error.get("customCode");
  if (code === "already_verified") {
    return { state: "already-verified" };
  }
  if (typeof code !== "string" || match !== undefined) {
    throw unknownState(ctx, handle, answer, "a completed job with an error it cannot classify");
  }
  const message = error.get("message");
  // The explorer's text: redacted with the call's keys and cut, so a planted key or a huge
  // message never reaches the result (R-SEC-1).
  const reason = redactExcerpt(
    typeof message === "string" ? `${code}: ${message}` : code,
    ctx.http.secrets,
    REASON_LENGTH,
  );
  if (DEFINITIVE_CODES.includes(code)) {
    return { state: "failed", reason };
  }
  if (TRANSIENT_CODES.includes(code)) {
    throw newError(
      { code: "verification-inconclusive", backend: NAME, reason },
      `Sourcify ended job ${handle.jobId} without a verdict (${reason}).`,
      { secrets: ctx.http.secrets },
    );
  }
  throw unknownState(
    ctx,
    handle,
    answer,
    `a completed job with the error code ${code.slice(0, CODE_LENGTH)}`,
  );
}

/** The submit body: only `language`, `sources` and `settings` of the input, as an object. */
function submitBody(input: ResolvedInput): SubmitBody {
  const { language, sources, settings } = input.compiler.input;
  const body: SubmitBody = {
    stdJsonInput: { language, sources, settings },
    compilerVersion: input.compiler.version,
    contractIdentifier: input.contractName,
  };
  // Sourcify reads constructor arguments from the creation code, so they are never sent.
  // Stryker disable next-line ConditionalExpression: equivalent when always true. JSON.stringify drops a field whose value is undefined.
  if (input.creationTxHash !== undefined) {
    body.creationTransactionHash = input.creationTxHash;
  }
  return body;
}

/** Maps a submit answer to its outcome. */
function readSubmit(input: ResolvedInput, ctx: Context, answer: Answer): SubmitOutcome {
  const { status, fields } = answer;
  const code = codeOf(fields);
  if (status === 202) {
    // Stryker disable next-line OptionalChaining: equivalent. A 202 without a JSON body is unconfirmed, so readSubmit never gets one.
    const id = fields?.get("verificationId");
    if (typeof id === "string" && VERIFICATION_ID.test(id)) {
      return {
        state: "submitted",
        handle: {
          version: 1,
          backend: NAME,
          chainId: input.chainId,
          address: input.address,
          jobId: id,
        },
      };
    }
  } else if (status === 409 && code === "already_verified") {
    // Sourcify answers 409 only when creation and runtime both match exactly.
    return { state: "already-verified", match: "exact" };
  } else if (status === 400 && code === "unsupported_chain") {
    throw unsupportedChain(ctx, input.chainId);
  } else if (status === 429 && code === "duplicate_verification_request") {
    throw newError(
      { code: "in-progress", backend: NAME },
      `Sourcify is already verifying ${input.address} on chain ${String(input.chainId)}.`,
      { secrets: ctx.http.secrets },
    );
  }
  throw unrecognised(ctx, answer, "the submit");
}

/** The error body's `customCode`. Every caller compares it with a string, so any other value fails. */
function codeOf(fields: Map<string, unknown> | undefined): unknown {
  return fields?.get("customCode");
}

/** `exact_match` and `match` as a {@link Match}; anything else is `undefined`. */
function toMatch(value: unknown): Match | undefined {
  if (value === "exact_match") {
    return "exact";
  }
  return value === "match" ? "partial" : undefined;
}

/**
 * Whether a body's `chainId` and `address` name the target. With `required`, both must be
 * present; otherwise an absent field passes. A field that names another contract always fails, so
 * an answer about another contract is never taken as an answer about this one.
 */
function sameContract(fields: Map<string, unknown>, target: Target, required: boolean): boolean {
  const chainId = fields.get("chainId");
  const address = fields.get("address");
  const chainOk =
    (!required && chainId === undefined) ||
    ((typeof chainId === "string" || typeof chainId === "number") &&
      String(chainId) === String(target.chainId));
  const addressOk =
    (!required && address === undefined) ||
    (typeof address === "string" && address.toLowerCase() === target.address.toLowerCase());
  return chainOk && addressOk;
}

/** `/v2/<kind>/<chainId>/<address>`, with the address encoded as one path segment. */
function contractPath(kind: "contract" | "verify", target: Target): string {
  return `/v2/${kind}/${String(target.chainId)}/${encodeURIComponent(target.address)}`;
}

/** `unexpected-response` for an answer to `what`, such as `the lookup`, that the client does not know. */
function unrecognised(
  ctx: Context,
  answer: Answer,
  what: string,
): ExplorerVerifyError<"unexpected-response"> {
  return unexpectedAnswer(ctx, NAME, LABEL, answer, what);
}

/** `unexpected-response` whose whole message is `message`. */
function unexpected(
  ctx: Context,
  answer: Answer,
  message: string,
): ExplorerVerifyError<"unexpected-response"> {
  return unexpectedAnswer(ctx, NAME, LABEL, answer, message, true);
}

function unsupportedChain(ctx: Context, chainId: number): ExplorerVerifyError {
  return newError(
    { code: "unsupported-chain", backend: NAME, chainId },
    `Sourcify does not support chain ${String(chainId)}.`,
    { secrets: ctx.http.secrets },
  );
}

function unknownState(
  ctx: Context,
  handle: Handle,
  answer: Answer,
  what: string,
): ExplorerVerifyError {
  return newError(
    { code: "unknown-state", handle, excerpt: answer.text },
    `Sourcify reported ${what}; the result is not known.`,
    { secrets: ctx.http.secrets },
  );
}
