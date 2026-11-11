// References: R-BE-6.
/**
 * The interface every backend client implements, so the flow engine never branches on the
 * backend. Internal: the package entry point does not export it.
 *
 * This file holds types only: nothing in it runs, so `.c8rc.json` excludes it from coverage.
 */
import type { BackendName } from "../backend-names.ts";
import type { ApiKeysReader } from "../http/api-keys.ts";
import type { HttpContext } from "../http/fetch.ts";
import type { ResolvedHandler } from "../http/handler-url.ts";
import type { Route } from "../routing/resolve.ts";
import type { Handle, Hex, VerifyInput } from "../types.ts";

/**
 * How well the explorer matched the source: `exact` when the metadata hash matches too,
 * `partial` when everything but the metadata hash matches.
 */
export type Match = "exact" | "partial";

// References: R-FLOW-1, decision 0063.
/**
 * The contract whose source the explorer holds, where its answer names it. Each field is absent
 * when the answer does not give it.
 */
export interface Stored {
  /** The contract's name, or `path:Name` where the explorer gives the path. */
  readonly name?: string | undefined;
  /** The compiler version as the explorer gives it, such as `v0.8.34+commit.80d5c536`. */
  readonly compilerVersion?: string | undefined;
}

/** What a lookup found: the grade and, where the explorer names it, the stored contract. */
export interface Found extends Stored {
  readonly match: Match;
}

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

// References: R-IN-3.
/**
 * The input of a submit: a {@link VerifyInput} that `validateInput` has already checked and
 * normalised, with the constructor arguments that `verify()` derived when they were missing.
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
  // References: R-SEC-2.
  /**
   * Where the requests go and where a person sees the contract. Request URLs come only from
   * `route.requestUrl`, never from a handle.
   */
  readonly route: Route;
  /**
   * The HTTP context every request goes through: `fetch`, signal, budget, keys, and the call's
   * observer, whose logger and event callback redact keys and never throw.
   */
  readonly http: HttpContext;
  // References: R-SEC-2.
  /**
   * The caller's checked `apiKeys`. A client never reads it directly: it passes each request
   * through `withKey`, which decides whether the request gets a key. Absent means none.
   */
  readonly apiKeys?: ApiKeysReader;
  /**
   * The caller's `pollIntervalMs`, for a client that waits between two tries of one step, as the
   * Etherscan client does when a submit comes before the explorer has indexed the contract.
   * Absent means 3000.
   */
  readonly pollIntervalMs?: number;
  // References: R-FLOW-7, decision 0066.
  /**
   * The caller's `indexWaitMs`: how long, from the first submit, a client sends the submit again
   * while the explorer finds no contract code at the address. Absent means at most
   * 10 submits.
   */
  readonly indexWaitMs?: number | undefined;
  // References: decision 0046.
  /**
   * The caller's server handler, for a route whose requests go through it: it
   * words the errors of the handler's answers. Absent otherwise.
   */
  readonly handler?: ResolvedHandler | undefined;
  // References: R-FLOW-1, decision 0063.
  /**
   * For a `verify()` call: whether a match is of the input's own source. A client's lookup after a
   * submit without a clear answer sends the submit again over another contract's match. Absent
   * means every match counts, as for `checkStatus()`.
   */
  readonly own?: ((found: Found) => boolean) | undefined;
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
  | ({
      /** The explorer refused the submission because the contract is already verified. */
      readonly state: "already-verified";
    } & Found);

// References: R-FLOW-4.
/**
 * The result of one poll. Anything the backend cannot classify throws instead.
 *
 * - `pending`: the job is still running. Poll again.
 * - `verified`: the job verified the contract with this match. When a lookup read the grade, the
 *   outcome also names the stored contract, which the flow compares with the input.
 * - `already-verified`: the job found the contract already verified at this grade or better.
 *   `match` is absent when the explorer did not say which; the flow then looks it up.
 * - `failed`: the explorer definitively rejected the source. `reason` is the explorer's code and
 *   message.
 */
export type PollOutcome =
  | { readonly state: "pending" }
  | ({ readonly state: "verified" } & Found)
  | ({ readonly state: "already-verified"; readonly match?: Match } & Stored)
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
  // References: R-FLOW-4.
  /**
   * Asks whether the contract is verified. Sends no submission.
   *
   * @returns The match, with the stored contract where the answer names it, or `undefined` when
   *   the explorer says the contract is not verified.
   * @throws ExplorerVerifyError for every answer that does not clearly say one or the other. A
   *   failed lookup never reads as "not verified".
   */
  readonly lookup: (target: Target, ctx: Context) => Promise<Found | undefined>;
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
  // References: R-FLOW-3.
  /**
   * The public page of the contract, or `undefined` when the route points at a server whose
   * contracts no public page shows, such as a self-hosted or local one.
   */
  readonly explorerUrl: (target: Target, ctx: Context) => string | undefined;
  // References: R-IN-3.
  /**
   * Whether a submit sends constructor arguments. When it does, `verify()` derives missing ones
   * from the creation code before the submit. Absent means it does not.
   */
  readonly takesConstructorArgs?: boolean;
  // References: decision 0032.
  /**
   * Whether the explorer refuses a build other than the deployed one, so a creation code that
   * does not match `creationBytecode` is an early error rather than a submit without arguments.
   * Absent means it may accept another build, as a partial match.
   */
  readonly refusesOtherBuilds?: boolean;
  /**
   * The contract's creation code as the explorer records it, `0x` and hex, such as Etherscan's
   * `getcontractcreation` `creationBytecode`: for a contract a factory created, the inner init
   * code with its arguments. `undefined` when the explorer has no record. `verify()` calls it only
   * when a key is bound to the route. Only clients whose explorer has such a record define it.
   *
   * @throws ExplorerVerifyError for an answer that is neither a record nor "no record".
   */
  readonly creationCode?: (target: Target, ctx: Context) => Promise<string | undefined>;
}

// References: R-FLOW-8.
/**
 * How a proxy link ended, as a {@link ProxyLinker} reports it.
 *
 * - `linked`: the explorer links the proxy to `implementation`, one address in lower case, never
 *   the zero address. `implementationVerified` is absent when the answer does not say; the flow
 *   then asks {@link ProxyLinker.verified}. The flow compares it with `expectedImplementation`.
 * - `mismatch`: the explorer refused because the proxy points at another implementation than
 *   `expectedImplementation`. `implementation` is the one it holds, when it says.
 * - `not-linked`: the explorer definitively refused. `reason` is its text, redacted and cut.
 */
export type LinkEnd =
  | {
      readonly state: "linked";
      readonly implementation: Hex;
      readonly implementationVerified?: boolean;
    }
  | { readonly state: "mismatch"; readonly implementation: Hex | undefined }
  | { readonly state: "not-linked"; readonly reason: string };

/**
 * What a link request answers: `submitted`, the explorer accepted the request and gave a job id to
 * check, or a {@link LinkEnd}. A request never answers `pending`.
 */
export type LinkStep = { readonly state: "submitted"; readonly jobId: string } | LinkEnd;

/** What a status check answers: `pending`, the explorer is still linking, or a {@link LinkEnd}. */
export type LinkVerdict = { readonly state: "pending" } | LinkEnd;

/**
 * The proxy to link: a {@link Target} and, when the caller set it, the implementation it should
 * point at, both in lower case.
 */
export interface LinkTarget extends Target {
  readonly expectedImplementation?: Hex;
}

// References: R-FLOW-8.
/**
 * How one explorer links a proxy to its implementation. Each linker sits in a module of
 * its own that `linkProxy()` loads with a dynamic `import()`, so `verify()` never bundles it.
 * Every method sends its requests through `ctx.http`. A request answered in a form the client does
 * not know throws `unexpected-response`, since nothing started; a status check answered with a
 * text it does not know throws `proxy-link-unknown-state`.
 */
export interface ProxyLinker {
  /**
   * Asks the explorer to link the proxy or, for an explorer that links on its own, reads the link.
   * Never answers `pending`.
   */
  readonly request: (target: LinkTarget, ctx: Context) => Promise<LinkStep>;
  /** Asks once for the state of a link that `request` submitted. */
  readonly check: (jobId: string, target: LinkTarget, ctx: Context) => Promise<LinkVerdict>;
  // References: decision 0065.
  /**
   * Whether `jobId` has the form of a job id this explorer gives for the target, so a caller's
   * `resumeJobId` may be checked with `check`. Absent for an explorer that starts no job, which
   * takes no `resumeJobId`.
   */
  readonly acceptsJobId?: (jobId: string, target: LinkTarget) => boolean;
  /**
   * Whether the explorer holds the implementation's verified source, for a linker whose `linked`
   * answer does not say. Absent when every `linked` step says.
   */
  readonly verified?: (implementation: Hex, chainId: number, ctx: Context) => Promise<boolean>;
}
