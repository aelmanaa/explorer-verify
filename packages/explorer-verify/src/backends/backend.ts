/**
 * The interface every backend client implements (R-BE-6), so the flow engine never branches on the
 * backend. Internal: the package entry point does not export it.
 *
 * This file holds types only: nothing in it runs, so `.c8rc.json` excludes it from coverage.
 */
import type { BackendName } from "../backend-names.ts";
import type { HttpContext } from "../http/fetch.ts";
import type { Route } from "../routing/resolve.ts";
import type { Handle, Hex, VerifyInput } from "../types.ts";

/**
 * How well the explorer matched the source: `exact` when the metadata hash matches too,
 * `partial` when everything but the metadata hash matches.
 */
export type Match = "exact" | "partial";

/**
 * The contract a lookup or an explorer page is about.
 *
 * @example
 * ```ts
 * const target: Target = { chainId: 11155111, address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc" };
 * ```
 */
export interface Target {
  /** EVM chain id the contract is deployed on. */
  readonly chainId: number;
  /** The contract address. */
  readonly address: Hex;
}

/**
 * The input of a submit: a {@link VerifyInput} that `validateInput` has already checked and
 * normalised. Later releases derive missing constructor arguments before the submit (R-IN-3).
 */
export type ResolvedInput = VerifyInput;

/**
 * What every call of one backend shares. The flow engine builds it once per `verify()` or
 * `checkStatus()` call.
 *
 * @example
 * ```ts
 * const ctx: Context = {
 *   route: resolveRoute(11155111),
 *   http: { backend: "sourcify", secrets: [], signal: controller.signal, observer },
 * };
 * ```
 */
export interface Context {
  /**
   * Where the requests go and where a person sees the contract. Request URLs come only from
   * `route.requestUrl`, never from a handle (R-SEC-2).
   */
  readonly route: Route;
  /**
   * The HTTP context every request goes through: `fetch`, signal, budget, keys, and the call's
   * observer, whose logger and event callback redact keys and never throw.
   */
  readonly http: HttpContext;
}

/**
 * The result of a submit: the explorer accepted the job, or it says the contract is already
 * verified and started no job.
 *
 * After a submit with no clear answer, the client's recovery lookup can report `already-verified`
 * for a verification that this same call caused.
 */
export type SubmitOutcome =
  | {
      /** The explorer accepted the submission and started a job. */
      readonly state: "submitted";
      /** Pass it to {@link Backend.poll}. */
      readonly handle: Handle;
    }
  | {
      /** The explorer refused the submission because the contract is already verified. */
      readonly state: "already-verified";
      /** The stored match. */
      readonly match: Match;
    };

/**
 * The result of one poll. Anything the backend cannot classify throws instead (R-FLOW-4).
 *
 * - `pending`: the job is still running. Poll again.
 * - `verified`: the job verified the contract with this match.
 * - `already-verified`: the job found the contract already verified at this grade or better.
 *   `match` is absent when the explorer did not say which; the flow then looks it up.
 * - `failed`: the explorer definitively rejected the source. `reason` is the explorer's code and
 *   message.
 */
export type PollOutcome =
  | { readonly state: "pending" }
  | { readonly state: "verified"; readonly match: Match }
  | { readonly state: "already-verified"; readonly match?: Match }
  | { readonly state: "failed"; readonly reason: string };

/**
 * One explorer verification API. Each method sends its requests through `ctx.http` and builds
 * every URL with `ctx.route.requestUrl`.
 *
 * Every method rejects with `ctx.http.signal.reason`, unchanged, when the signal aborts, and
 * throws `ExplorerVerifyError` for every other failure.
 *
 * A submit may reach the explorer without the client learning its job id: no response, a 500, 502
 * or 504, or a success status whose body failed, stalled or could not be parsed. A client never
 * sends such a submit again blindly: it looks the contract up first, and sends the submit again
 * only when the lookup finds no verified contract. When that second submit finds a job already
 * running for the contract, the client throws `in-progress`, even though it has no job id.
 */
export interface Backend {
  /** The backend's name, as in `BACKEND_NAMES`. */
  readonly name: BackendName;
  /**
   * Asks whether the contract is verified. Sends no submission.
   *
   * @returns The match, or `undefined` when the explorer says the contract is not verified.
   * @throws ExplorerVerifyError for every answer that does not clearly say one or the other. A
   *   failed lookup never reads as "not verified" (R-FLOW-4).
   */
  readonly lookup: (target: Target, ctx: Context) => Promise<Match | undefined>;
  /**
   * Submits the source for verification. Outward and permanent: the explorer publishes it.
   *
   * @returns A handle to poll, or `already-verified` when the explorer refused the submission
   *   because the contract is already verified.
   */
  readonly submit: (input: ResolvedInput, ctx: Context) => Promise<SubmitOutcome>;
  /**
   * Asks once for the state of a submitted job.
   *
   * @throws ExplorerVerifyError `invalid-input` for a handle of another backend or with a job id
   *   `parseHandle` would reject; `unknown-state` for a final state the client cannot classify;
   *   `verification-inconclusive` for a job that ended without a verdict, which a new `verify()`
   *   may resolve; and `job-not-found` when the explorer does not know the job.
   */
  readonly poll: (handle: Handle, ctx: Context) => Promise<PollOutcome>;
  /**
   * The public page of the contract, or `undefined` when the route points at a server whose
   * contracts no public page shows, such as a self-hosted or local one (R-FLOW-3).
   */
  readonly explorerUrl: (target: Target, ctx: Context) => string | undefined;
}
