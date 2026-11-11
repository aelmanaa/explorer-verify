// References: decision 0048.
/**
 * The refusal codes of `createVerifyHandler`, each with the error code the client throws for it.
 * The handler refuses only with a `HandlerRefusal`, the table needs an entry for
 * each, and the client's handler code reads the table, so the two cannot drift. Internal: neither
 * entry point exports the table.
 */
import type { ErrorCode } from "../errors.ts";

// References: decision 0048.
/**
 * The stable code of a refusal of `createVerifyHandler`. Every refusal body is
 * `{ "status": "0", "message": "NOTOK", "result": "<sentence>", "code": "<code>" }`: the shape of
 * an Etherscan error, plus `code`. The sentence may change in any release; the code does not. An
 * answer without `code` is Etherscan's own. A client that set `handlerUrl` maps each code to an
 * error code.
 *
 * @experimental
 */
export type HandlerRefusal =
  | "method-not-allowed"
  | "unsupported-media-type"
  | "body-too-large"
  | "request-timeout"
  | "bad-request"
  | "forbidden-field"
  | "action-not-allowed"
  | "chain-not-allowed"
  | "address-not-allowed"
  | "address-not-indexed"
  | "rate-limited"
  | "upstream-rate-limited"
  | "upstream-timeout"
  | "upstream-error"
  | "internal-error";

/**
 * The error codes a client that set `handlerUrl` throws for a refusal code:
 *
 * - `handler-refused`: the handler's options or the request must change; not retryable.
 * - `network`: the handler or Etherscan did not answer in time, or Etherscan failed; retryable.
 * - `rate-limited`: the handler's `rateLimit`, or Etherscan's limit. The HTTP layer throws it for
 *   the 429 before the code is read.
 * - `not-indexed`: Etherscan has no creation record for the address yet (decision 0066); retryable.
 * - `unexpected-response`: the handler failed;
 *   retryable.
 */
export type ClientCode = Extract<
  ErrorCode,
  "handler-refused" | "network" | "rate-limited" | "unexpected-response" | "not-indexed"
>;

/**
 * Each refusal code of `createVerifyHandler`: the error code the client throws for it, and the
 * HTTP status the handler sends with it. The client maps a code only when the status matches.
 */
export const HANDLER_REFUSALS: Readonly<Record<HandlerRefusal, readonly [ClientCode, number]>> = {
  "method-not-allowed": ["handler-refused", 405],
  "unsupported-media-type": ["handler-refused", 415],
  "body-too-large": ["handler-refused", 413],
  "request-timeout": ["network", 408],
  "bad-request": ["handler-refused", 400],
  "forbidden-field": ["handler-refused", 400],
  "action-not-allowed": ["handler-refused", 403],
  "chain-not-allowed": ["handler-refused", 403],
  "address-not-allowed": ["handler-refused", 403],
  "address-not-indexed": ["not-indexed", 503],
  "rate-limited": ["rate-limited", 429],
  "upstream-rate-limited": ["rate-limited", 429],
  "upstream-timeout": ["network", 504],
  "upstream-error": ["network", 502],
  "internal-error": ["unexpected-response", 500],
};
