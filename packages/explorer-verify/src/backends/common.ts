/**
 * Helpers the backend clients share: sending a request and reading its body, a submit that is
 * never sent again blindly, and the handle check before a poll. Internal: the package entry point
 * does not export it.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { JOB_ID } from "../flow/handle.ts";
import { request } from "../http/fetch.ts";
import type { HttpRequest } from "../http/fetch.ts";
import { readFields } from "../internal/read-fields.ts";
import type { Handle } from "../types.ts";
import type { Backend, Context, Match, SubmitOutcome, Target } from "./backend.ts";

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
  const second = await attempt();
  if (second.kind === "answer") {
    return await read(second.answer);
  }
  throw second.error;
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
