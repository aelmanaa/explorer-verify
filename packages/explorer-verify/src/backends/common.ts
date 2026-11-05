/**
 * Helpers the backend clients share: sending a request and reading its body, a submit that is
 * never sent again blindly, the wait before a whole submit is sent again, the Etherscan-style
 * submit fields, the handle check before a poll, and the error for an answer a client does not
 * know. Internal: the package entry point does not export it.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/handle.ts";
import { request, sleep } from "../http/fetch.ts";
import type { HttpRequest } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
import type { Handle } from "../types.ts";
import type { Backend, Context, Match, ResolvedInput, SubmitOutcome, Target } from "./backend.ts";

/** The longest `failed` reason, or inconclusive reason, kept from the explorer's text. */
export const REASON_LENGTH = 300;
/** Submit statuses that may come after the explorer received the submit, so it is not sent again blindly. */
export const UNCONFIRMED_STATUSES: readonly number[] = [500, 502, 504];

/** An answer with its body read, and the body's own fields when it is a JSON object. */
export interface Answer {
  readonly status: number;
  readonly text: string;
  readonly fields: Map<string, unknown> | undefined;
}

/**
 * Sends one request through the HTTP layer and reads the body.
 *
 * @param ctx - The call's context.
 * @param req - The request.
 * @returns The status, the text and, for a JSON object body, its own fields.
 * @example
 * ```ts
 * const answer = await send(ctx, { url, method: "GET", retry: "safe" });
 * ```
 */
export async function send(ctx: Context, req: HttpRequest): Promise<Answer> {
  const response = await request(ctx.http, req);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, fields: readFields(parsed) };
}

/** One submit sent: an answer to map, or an error that may hide a submit the explorer accepted. */
export type SubmitAttempt =
  | { readonly kind: "answer"; readonly answer: Answer }
  | { readonly kind: "unconfirmed"; readonly error: ExplorerVerifyError };

/**
 * Sends a submit once. It is `unconfirmed` when no response came, when a 2xx body failed or
 * stalled after the headers arrived (the HTTP layer keeps the read error as the cause), or when
 * `unconfirmed` returns an error for the answer. A redirect, an oversized body, or an answer still
 * refused after the retries is thrown.
 *
 * @param ctx - The call's context.
 * @param req - The submit request.
 * @param unconfirmed - The error for an answer that may hide an accepted submit, or `undefined`.
 * @returns The answer, or the error of a submit that may have been received.
 * @example
 * ```ts
 * const sent = await attemptSubmit(ctx, req, (answer) => (answer.status === 500 ? error : undefined));
 * ```
 */
export async function attemptSubmit(
  ctx: Context,
  req: HttpRequest,
  unconfirmed: (answer: Answer) => ExplorerVerifyError | undefined,
): Promise<SubmitAttempt> {
  let answer: Answer;
  try {
    answer = await send(ctx, req);
  } catch (error: unknown) {
    if (
      error instanceof ExplorerVerifyError &&
      (error.details.code === "network" ||
        (error.details.code === "unexpected-response" &&
          error.details.status >= 200 &&
          // Stryker disable next-line EqualityOperator: equivalent. A 3xx is a redirect, which never reads the body, so no 300 error has a cause.
          error.details.status < 300 &&
          error.cause !== undefined))
    ) {
      return { kind: "unconfirmed", error };
    }
    throw error;
  }
  const error = unconfirmed(answer);
  return error === undefined ? { kind: "answer", answer } : { kind: "unconfirmed", error };
}

/**
 * Runs a submit that is never sent again blindly. When the first try is `unconfirmed`, it looks
 * the contract up: a match ends the submit as `already-verified`; no match sends it once more. A
 * second `unconfirmed` throws its error. A failed lookup throws its error, whose message then says
 * the submit may already have been accepted.
 *
 * @param ctx - The call's context.
 * @param name - The backend, for the log line.
 * @param label - The backend's name in messages, such as `Sourcify`.
 * @param target - The contract.
 * @param attempt - Sends the submit once.
 * @param read - Maps an answer to the outcome.
 * @param lookup - The client's lookup.
 * @returns The outcome.
 * @example
 * ```ts
 * return await submitOnce(ctx, "sourcify", "Sourcify", target, attempt, read, lookup);
 * ```
 */
export async function submitOnce(
  ctx: Context,
  name: BackendName,
  label: string,
  target: Target,
  attempt: () => Promise<SubmitAttempt>,
  read: (answer: Answer) => Promise<SubmitOutcome> | SubmitOutcome,
  lookup: Backend["lookup"],
): Promise<SubmitOutcome> {
  const first = await attempt();
  if (first.kind === "answer") {
    return await read(first.answer);
  }
  ctx.http.observer?.log.warn(
    `${label} submit: ${first.error.message} Looking the contract up before submitting again.`,
    { backend: name, code: first.error.code },
  );
  const match = await lookupAfterUnclear(ctx, target, lookup);
  if (match !== undefined) {
    return { state: "already-verified", match };
  }
  const second = await attempt();
  if (second.kind === "answer") {
    return await read(second.answer);
  }
  throw second.error;
}

/**
 * Looks the contract up after a submit without a clear answer. A failed lookup throws its error,
 * whose message then says the submit may already have been accepted.
 *
 * @param ctx - The call's context.
 * @param target - The contract.
 * @param lookup - The client's lookup.
 * @returns The match, or `undefined` when the contract is not verified.
 * @example
 * ```ts
 * const match = await lookupAfterUnclear(ctx, target, lookup);
 * ```
 */
export async function lookupAfterUnclear(
  ctx: Context,
  target: Target,
  lookup: Backend["lookup"],
): Promise<Match | undefined> {
  try {
    return await lookup(target, ctx);
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
}

/** The wait between two whole submits, when the context has no `pollIntervalMs`. */
const RESUBMIT_WAIT_MS = 3_000;

/** How a client sends a whole submit again while the explorer gives an answer that may clear up. */
export interface Resubmit {
  /** The backend, for the error, the log line and the event. */
  readonly backend: BackendName;
  /** The `verify.retry` reason. */
  readonly reason: "not-indexed" | "empty-submit";
  /** What the explorer said, as a sentence start: `Etherscan found no contract code at the address`. */
  readonly what: string;
  /** The hint of the error that ends the loop. */
  readonly hint: string;
  /** The most submits, the first included. */
  readonly maxTries: number;
  /** The last time, as a `Date.now()` value, a submit may be sent. Absent means no limit. */
  readonly until?: number;
}

/**
 * Before submit `attempt + 1`: throws `timeout` when it would pass the budget's deadline, and
 * `unexpected-response` after `maxTries` submits or once `until` has passed. Otherwise logs at
 * `warn`, emits `verify.retry` and waits `pollIntervalMs`, cut to what is left before `until`.
 *
 * @param ctx - The call's context.
 * @param answer - The answer that asks for a new submit.
 * @param attempt - The number of submits sent so far.
 * @param loop - The backend's rules.
 * @example
 * ```ts
 * await waitToResubmit(ctx, answer, attempt, { backend, reason: "not-indexed", what, hint, maxTries: 10 });
 * ```
 */
export async function waitToResubmit(
  ctx: Context,
  answer: Answer,
  attempt: number,
  loop: Resubmit,
): Promise<void> {
  const { backend, reason, what, hint, maxTries, until = Infinity } = loop;
  const { budget, secrets, observer, signal } = ctx.http;
  const now = Date.now();
  const delayMs = Math.min(ctx.pollIntervalMs ?? RESUBMIT_WAIT_MS, until - now);
  const tries = `${String(attempt)} ${attempt === 1 ? "submit" : "submits"}`;
  if (budget !== undefined && now + delayMs >= budget.deadline) {
    throw new ExplorerVerifyError(
      { code: "timeout", backend, timeoutMs: budget.timeoutMs },
      `${what} after ${tries}, within the ${String(budget.timeoutMs)} ms budget.`,
      { hint, secrets },
    );
  }
  if (attempt >= maxTries || delayMs <= 0) {
    throw new ExplorerVerifyError(
      { code: "unexpected-response", backend, status: answer.status, excerpt: answer.text },
      `${what} after ${tries}.`,
      { hint, secrets },
    );
  }
  observer?.log.warn(
    `${what} yet; submitting again in ${String(delayMs)} ms (submit ${String(attempt + 1)} of at most ${String(maxTries)})`,
    { backend, attempt: attempt + 1, reason, delayMs },
  );
  observer?.emit({ type: "verify.retry", backend, attempt: attempt + 1, reason, delayMs });
  await sleep(delayMs, signal);
}

/**
 * The `verifysourcecode` fields of an Etherscan-style API for a Standard JSON input, without the
 * constructor arguments: `sourceCode` holds only `language`, `sources` and `settings`, and
 * `compilerversion` has one leading `v`.
 *
 * @param input - The checked input.
 * @returns The form fields, `module` excluded.
 * @example
 * ```ts
 * const fields = standardJsonFields(input);
 * ```
 */
export function standardJsonFields(input: ResolvedInput): Record<string, string> {
  const { language, sources, settings } = input.compiler.input;
  return {
    action: "verifysourcecode",
    codeformat: "solidity-standard-json-input",
    sourceCode: JSON.stringify({ language, sources, settings }),
    contractaddress: input.address,
    contractname: input.contractName,
    // Stryker disable next-line Regex: equivalent. A solc version has a `v` only as its first character, so removing the first `v` removes the same one; validateInput drops it already.
    compilerversion: `v${input.compiler.version.replace(/^v/, "")}`,
  };
}

/**
 * The `result` field of an answer when it is text.
 *
 * @param answer - The answer.
 * @returns The text, or `undefined`.
 * @example
 * ```ts
 * resultOf(answer)?.startsWith("Pending in queue");
 * ```
 */
export function resultOf(answer: Answer): string | undefined {
  const result = answer.fields?.get("result");
  return typeof result === "string" ? result : undefined;
}

/**
 * `unexpected-response` with the answer's status and text. `what` names the request, as
 * `the lookup`, or is the whole message when `whole` is set.
 *
 * @param ctx - The call's context, for its secrets.
 * @param backend - The backend.
 * @param label - The backend's name in the message, such as `Etherscan`.
 * @param answer - The answer.
 * @param what - The request, or the whole message.
 * @param whole - Whether `what` is the whole message.
 * @returns The error.
 * @example
 * ```ts
 * throw unexpected(ctx, "blockscout", "Blockscout", answer, "the lookup");
 * ```
 */
export function unexpected(
  ctx: Context,
  backend: BackendName,
  label: string,
  answer: Answer,
  what: string,
  whole = false,
): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "unexpected-response", backend, status: answer.status, excerpt: answer.text },
    whole
      ? what
      : `${label} gave an answer to ${what} that this client does not recognise (status ${String(answer.status)}).`,
    { secrets: ctx.http.secrets },
  );
}

/**
 * The contract's page from the routing table, or `undefined` when the route has none.
 *
 * @param target - The contract.
 * @param ctx - The call's context.
 * @returns The page.
 * @example
 * ```ts
 * const backend: Backend = { name, lookup, submit, poll, explorerUrl };
 * ```
 */
export function explorerUrl(target: Target, ctx: Context): string | undefined {
  return ctx.route.explorerUrl?.(target.address);
}

/**
 * Throws `invalid-input` unless the handle names `backend` and holds a job id of the shape
 * `parseHandle` accepts, so a handle built by hand never puts an odd value in a request.
 *
 * @param handle - The handle to poll. It may come from storage.
 * @param backend - The client's backend.
 * @param label - The client's name in the message, such as `Sourcify`.
 * @param ctx - The call's context, for its secrets.
 * @example
 * ```ts
 * checkHandle(handle, "sourcify", "Sourcify", ctx);
 * ```
 */
export function checkHandle(
  handle: Handle,
  backend: BackendName,
  label: string,
  ctx: Context,
): void {
  const issues = [];
  if (handle.backend !== backend) {
    issues.push({ field: "backend", message: `must be ${backend} for the ${label} client` });
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
