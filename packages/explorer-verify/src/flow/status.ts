/**
 * `checkStatus()`: resumes a submitted verification from its handle (R-FLOW-5). It runs the poll
 * and result steps of `verify()` through the same helpers, so a resumed job ends as it would have
 * in `verify()`.
 */
import type { Match, Target } from "../backends/backend.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { resolveRoute } from "../routing/resolve.ts";
import type { Route } from "../routing/resolve.ts";
import type { Handle, VerifyOptions, VerifyResult } from "../types.ts";
import { parseHandle } from "./handle.ts";
import {
  DEFAULT_DEPENDENCIES,
  announceRoute,
  finish,
  graceContext,
  mustRethrow,
  openCall,
  settingsOf,
  settle,
} from "./verify.ts";
import type { Call, FlowDependencies } from "./verify.ts";

/**
 * Continues polling a verification that `verify()` submitted, from its handle (R-FLOW-5). Use it
 * after a `not-confirmed` error, an abort, a page reload or a process restart. It never submits.
 *
 * 1. Reads the options, then reads the handle with `parseHandle`: the handle object or its
 *    one-line form `ev1:<backend>:<chainId>:<address>:<jobId>`.
 * 2. Resolves the route from the handle's chain id and `options.route`, never from the handle
 *    (R-SEC-2). The handle's backend must be the backend that route names; otherwise it throws
 *    `invalid-input` naming `backend` and sends nothing.
 * 3. Polls the job at once, then every `pollIntervalMs`, until it ends or `timeoutMs` is spent,
 *    and maps the end as `verify()` does: `verified`, `already-verified` or `failed`. When the
 *    budget runs out, or 3 polls in a row fail, it looks the contract up once more; a match returns
 *    `verified`, otherwise it throws `not-confirmed` with the same handle.
 * 4. When the explorer no longer knows the job, it looks the contract up. A match returns
 *    `verified`; otherwise it throws `job-not-found`, and a new `verify()` is the way forward.
 *
 * The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. It emits `verify.routed`,
 * `verify.poll`, `verify.retry` and `verify.result`.
 *
 * @param handle - The handle from a `not-confirmed` error or a `verify.submitted` event, as an
 *   object or in its one-line form.
 * @param options - The same options as `verify()`. Pass the same `route` the submit used.
 * @returns `verified`, `already-verified` or `failed`, as `verify()` returns them.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6).
 * @throws ExplorerVerifyError with `invalid-input` for a bad handle or options, or a handle whose
 *   backend is not the route's; `not-confirmed` with the handle when the job is still pending;
 *   `job-not-found` when the explorer no longer knows the job and the contract is not verified;
 *   `verification-inconclusive` when the job ended without a verdict (call `verify()` again);
 *   `unknown-state`, `network`, `rate-limited` and `unexpected-response`.
 * @example
 * ```ts
 * import { ExplorerVerifyError, checkStatus, formatHandle, verify } from "explorer-verify";
 *
 * try {
 *   await verify(input);
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
 *     localStorage.setItem("pending-verification", formatHandle(error.details.handle));
 *   } else {
 *     throw error;
 *   }
 * }
 *
 * // Later, after a page reload:
 * const stored = localStorage.getItem("pending-verification");
 * if (stored !== null) {
 *   const result = await checkStatus(stored, { timeoutMs: 60_000 });
 *   localStorage.removeItem("pending-verification");
 *   console.log(result.status);
 * }
 * ```
 * @experimental
 */
export async function checkStatus(
  handle: Handle | string,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  return await runCheckStatus(handle, options, DEFAULT_DEPENDENCIES);
}

/**
 * {@link checkStatus} with its dependencies passed in. Internal: the package entry point does not
 * export it.
 *
 * @param value - The handle, as an object or in its one-line form.
 * @param options - The caller's options.
 * @param dependencies - The backend clients and the jitter source.
 * @returns The result.
 * @example
 * ```ts
 * const result = await runCheckStatus(line, { fetch }, { backends: { sourcify }, random: () => 0 });
 * ```
 */
export async function runCheckStatus(
  value: unknown,
  options: VerifyOptions | undefined,
  dependencies: FlowDependencies,
): Promise<VerifyResult> {
  const settings = settingsOf(options);
  settings.signal?.throwIfAborted();
  const handle = parseHandle(value);
  const route = resolveRoute(handle.chainId, settings.route);
  checkBackend(handle, route);
  // Lower case, as verify() uses it, so the lookup and the explorer page match a verify() call.
  const target: Target = {
    chainId: handle.chainId,
    address: `0x${handle.address.slice(2).toLowerCase()}`,
  };
  const call = openCall(settings, route, target, dependencies);
  announceRoute(
    call,
    `Resuming ${call.backend.name} job ${handle.jobId} for ${target.address} on chain ${String(target.chainId)}`,
  );
  try {
    return await settle(call, handle, 0);
  } catch (error: unknown) {
    // An abort wins, even when the answer that arrived with it was a job-not-found.
    const { signal } = settings;
    if (signal?.aborted === true) {
      const reason: unknown = signal.reason;
      throw reason;
    }
    if (!(error instanceof ExplorerVerifyError) || error.code !== "job-not-found") {
      throw error;
    }
    return await forgottenJob(call, handle, error);
  }
}

/**
 * Throws `invalid-input` unless the handle names the backend the route resolves for its chain. A
 * handle never chooses where requests go or which key goes with them (R-SEC-2).
 */
function checkBackend(handle: Handle, route: Route): void {
  if (handle.backend === route.backend) {
    return;
  }
  throw new ExplorerVerifyError(
    {
      code: "invalid-input",
      issues: [{ field: "backend", message: `must be ${route.backend}, the route's backend` }],
    },
    `The handle names ${handle.backend}, but chain ${String(handle.chainId)} routes to ${route.backend}.`,
    {
      hint: "Pass the route option the submission used, or the handle that verify() returned for this route.",
      secrets: [],
    },
  );
}

/**
 * The explorer no longer knows the job, as Routescan forgets a job id within an hour. One lookup
 * decides: a match means the job verified the contract, so the result is `verified`. Otherwise it
 * throws `job-not-found`, whose hint says to call `verify()` again. When the lookup fails, the
 * error keeps the catalogue hint, which says to check the contract first, and the lookup error as
 * its cause.
 */
async function forgottenJob(
  call: Call,
  handle: Handle,
  notFound: ExplorerVerifyError,
): Promise<VerifyResult> {
  const { backend, settings, observer, ctx } = call;
  observer.log.debug(
    `${backend.name} does not know job ${handle.jobId}; looking the contract up instead`,
    { backend: backend.name },
  );
  let match: Match | undefined;
  try {
    match = await backend.lookup(call.target, graceContext(call));
  } catch (error: unknown) {
    if (mustRethrow(error, settings.signal)) {
      throw error;
    }
    throw new ExplorerVerifyError(
      { code: "job-not-found", handle },
      `${backend.name} does not know job ${handle.jobId}, and the lookup of the contract failed.`,
      { secrets: ctx.http.secrets, cause: error },
    );
  }
  if (match !== undefined) {
    return finish(call, "verified", match);
  }
  throw new ExplorerVerifyError(
    { code: "job-not-found", handle },
    `${backend.name} does not know job ${handle.jobId}, and a lookup found the contract not verified.`,
    {
      hint: "Call verify() again: the job is gone and the contract is not verified, so a new submission is needed.",
      secrets: ctx.http.secrets,
      cause: notFound,
    },
  );
}
