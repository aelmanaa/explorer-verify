/**
 * The Sourcify API v2 client (R-BE-4). Sourcify needs no key and answers browsers directly. The
 * v1 API was switched off on 2026-07-07, so only v2 is used. Every answer is mapped to a match, a
 * poll outcome or a typed error; an answer the client does not recognise is never read as "not
 * verified" or as success (R-FLOW-4). The evidence for each mapping is in
 * docs/contributor/research/2026-11-02-sourcify-v2.md.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/handle.ts";
import { request } from "../http/fetch.ts";
import type { HttpRequest } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
import { redactExcerpt, redactingLogger } from "../redact.ts";
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

const NAME: BackendName = "sourcify";

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

// Submit answers that may come after Sourcify received the submit: it is not sent again blindly.
const UNCONFIRMED_STATUSES: readonly number[] = [500, 502, 504];
const VERIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest `failed` reason, or inconclusive reason, kept from the explorer's text. */
export const REASON_LENGTH = 300;
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

/** An answer with its body read, and the body's own fields when it is a JSON object. */
interface Answer {
  readonly status: number;
  readonly text: string;
  readonly fields: Map<string, unknown> | undefined;
}

type SubmitAttempt =
  | { readonly kind: "answer"; readonly answer: Answer }
  | { readonly kind: "unconfirmed"; readonly error: ExplorerVerifyError };

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
  throw unexpected(ctx, answer, unrecognised("the lookup", answer));
}

/**
 * The repository page of the contract, `https://repo.sourcify.dev/<chainId>/<address>`, or
 * `undefined` when the route points at another Sourcify server.
 */
function explorerUrl(target: Target, ctx: Context): string | undefined {
  return ctx.route.explorerUrl?.(target.chainId, target.address);
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
  const first = await attemptSubmit(ctx, req);
  if (first.kind === "answer") {
    return readSubmit(input, ctx, first.answer);
  }
  if (ctx.http.logger !== undefined) {
    redactingLogger(ctx.http.logger, ctx.http.secrets).warn(
      `Sourcify submit: ${first.error.message} Looking the contract up before submitting again.`,
    );
  }
  let match: Match | undefined;
  try {
    match = await lookup(target, ctx);
  } catch (error: unknown) {
    if (error instanceof ExplorerVerifyError) {
      throw new ExplorerVerifyError(
        error.details,
        `${error.message} The submit before this lookup got no clear answer and may already have been accepted.`,
        { hint: error.hint, cause: error, secrets: ctx.http.secrets },
      );
    }
    throw error;
  }
  if (match !== undefined) {
    return { state: "already-verified", match };
  }
  const second = await attemptSubmit(ctx, req);
  if (second.kind === "answer") {
    return readSubmit(input, ctx, second.answer);
  }
  throw second.error;
}

/** Asks once for the state of a job. The handle is checked first: it may come from storage. */
async function poll(handle: Handle, ctx: Context): Promise<PollOutcome> {
  checkHandle(handle, ctx);
  const answer = await send(ctx, {
    url: ctx.route.requestUrl(`/v2/verify/${encodeURIComponent(handle.jobId)}`),
    method: "GET",
    retry: "safe",
  });
  const { status, fields } = answer;
  if (status === 404 && codeOf(fields) === "job_not_found") {
    throw new ExplorerVerifyError(
      { code: "job-not-found", handle },
      `Sourcify does not know the verification job ${handle.jobId}.`,
      { secrets: ctx.http.secrets },
    );
  }
  const completed = fields?.get("isJobCompleted");
  if (status !== 200 || fields === undefined || typeof completed !== "boolean") {
    throw unexpected(ctx, answer, unrecognised("the job status request", answer));
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
    throw new ExplorerVerifyError(
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
  if (input.creationTxHash !== undefined) {
    body.creationTransactionHash = input.creationTxHash;
  }
  return body;
}

/**
 * Sends a submit once. An answer that may hide an accepted submit is `unconfirmed`: no response,
 * a 500, 502 or 504, a 2xx whose body failed or stalled, or a 202 that is not JSON. A redirect, an
 * oversized body, or a 503 still refused after the retries is thrown.
 */
async function attemptSubmit(ctx: Context, req: HttpRequest): Promise<SubmitAttempt> {
  let answer: Answer;
  try {
    answer = await send(ctx, req);
  } catch (error: unknown) {
    if (error instanceof ExplorerVerifyError && unclear(error)) {
      return { kind: "unconfirmed", error };
    }
    throw error;
  }
  if (
    UNCONFIRMED_STATUSES.includes(answer.status) ||
    (answer.status === 202 && answer.fields === undefined)
  ) {
    return {
      kind: "unconfirmed",
      error: unexpected(ctx, answer, unrecognised("the submit", answer)),
    };
  }
  return { kind: "answer", answer };
}

/** Whether a thrown submit error may hide a submit Sourcify accepted. */
function unclear(error: ExplorerVerifyError): boolean {
  const { details } = error;
  return (
    details.code === "network" ||
    // A 2xx whose body failed or stalled after the headers arrived: the HTTP layer keeps the read
    // error as the cause. A redirect or an oversized body has no cause and is thrown.
    (details.code === "unexpected-response" &&
      details.status >= 200 &&
      details.status < 300 &&
      error.cause !== undefined)
  );
}

/**
 * Throws `invalid-input` unless the handle names this backend and holds a job id of the shape
 * `parseHandle` accepts, so a handle built by hand never puts an odd value in a request path.
 */
function checkHandle(handle: Handle, ctx: Context): void {
  const issues = [];
  if (handle.backend !== NAME) {
    issues.push({ field: "backend", message: "must be sourcify for the Sourcify client" });
  }
  const jobId: unknown = handle.jobId;
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
    issues.push({
      field: "jobId",
      message:
        "must be 1 to 128 characters from A-Z, a-z, 0-9, '_' and '-', starting with a letter or digit",
    });
  }
  if (issues.length > 0) {
    throw new ExplorerVerifyError(
      { code: "invalid-input", issues },
      `The handle is invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
      {
        hint: "Pass the handle exactly as verify() or parseHandle() returned it.",
        secrets: ctx.http.secrets,
      },
    );
  }
}

/** Maps a submit answer to its outcome. */
function readSubmit(input: ResolvedInput, ctx: Context, answer: Answer): SubmitOutcome {
  const { status, fields } = answer;
  const code = codeOf(fields);
  if (status === 202) {
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
    throw new ExplorerVerifyError(
      { code: "in-progress", backend: NAME },
      `Sourcify is already verifying ${input.address} on chain ${String(input.chainId)}.`,
      { secrets: ctx.http.secrets },
    );
  }
  throw unexpected(ctx, answer, unrecognised("the submit", answer));
}

/** Sends one request through the HTTP layer and reads the body. */
async function send(ctx: Context, req: HttpRequest): Promise<Answer> {
  const response = await request(ctx.http, req);
  const text = await response.text();
  return { status: response.status, text, fields: parseObject(text) };
}

/** The own fields of a JSON object body, or `undefined` for anything else. */
function parseObject(text: string): Map<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return readFields(parsed);
  } catch {
    return undefined;
  }
}

/** The error body's `customCode`, when it is a string. */
function codeOf(fields: Map<string, unknown> | undefined): string | undefined {
  const code = fields?.get("customCode");
  return typeof code === "string" ? code : undefined;
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

function unrecognised(what: string, answer: Answer): string {
  return `Sourcify gave an answer to ${what} that this client does not recognise (status ${String(answer.status)}).`;
}

function unexpected(ctx: Context, answer: Answer, message: string): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "unexpected-response", backend: NAME, status: answer.status, excerpt: answer.text },
    message,
    { secrets: ctx.http.secrets },
  );
}

function unsupportedChain(ctx: Context, chainId: number): ExplorerVerifyError {
  return new ExplorerVerifyError(
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
  return new ExplorerVerifyError(
    { code: "unknown-state", handle, excerpt: answer.text },
    `Sourcify reported ${what}; the result is not known.`,
    { secrets: ctx.http.secrets },
  );
}
