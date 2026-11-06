/**
 * `checkStatus()`: resumes a submitted verification from its handle (R-FLOW-5). It runs the poll
 * and result steps of `verify()` through the same helpers, so a resumed job ends as it would have
 * in `verify()`.
 */
import type { Target } from "../backends/backend.ts";
import { newError } from "../error-hints.ts";
import type { Route } from "../routing/resolve.ts";
import type { CheckStatusOptions, Handle, VerifyResult } from "../types.ts";
import { parseHandle } from "./handle.ts";
import {
  DEFAULT_DEPENDENCIES,
  abortWins,
  announceRoute,
  openCall,
  routeOf,
  settingsOf,
  settle,
  startBudget,
  withClient,
  withHandler,
} from "./verify.ts";
import type { FlowDependencies } from "./verify.ts";

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
 * @throws The error of the explorer client module, unchanged, when it fails to load, such as a
 *   chunk the page cannot fetch (decision 0031).
 * @throws ExplorerVerifyError with `invalid-input` for a bad handle or options, or a handle whose
 *   backend is not the route's; `not-confirmed` with the handle when the job is still pending;
 *   `job-not-found` when the explorer no longer knows the job and the contract is not verified;
 *   `verification-inconclusive` when the job ended without a verdict (call `verify()` again);
 *   `timeout` when the client does not load within the budget; `unknown-state`, `network`,
 *   `rate-limited` and `unexpected-response`.
 * @example
 * ```ts
 * import { ExplorerVerifyError, checkStatus, formatHandle, verify } from "explorer-verify";
 *
 * try {
 *   await verify(input);
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
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
  options?: CheckStatusOptions,
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
  options: CheckStatusOptions | undefined,
  dependencies: FlowDependencies,
): Promise<VerifyResult> {
  const read = settingsOf(options);
  read.signal?.throwIfAborted();
  const handle = parseHandle(value);
  // Lower case, as verify() uses it, so the lookup and the explorer page match a verify() call.
  const target: Target = {
    chainId: handle.chainId,
    address: `0x${handle.address.slice(2).toLowerCase()}`,
  };
  // The routing table and the client load inside abortWins, as in verify(): an abort during a
  // load rejects with signal.reason, whatever the load does after it.
  return await abortWins(read.signal, async () => {
    const budget = startBudget(read);
    const settings = await withHandler(read, budget);
    const route = await routeOf(handle.chainId, settings, dependencies, budget);
    checkBackend(handle, route);
    const loaded = await withClient(route, dependencies, settings, budget);
    const call = openCall(settings, route, target, loaded, true, budget);
    announceRoute(
      call,
      `Resuming ${call.backend.name} job ${handle.jobId} for ${target.address} on chain ${String(target.chainId)}`,
    );
    // settle() looks the contract up for a job the explorer no longer knows, as in verify().
    return await settle(call, handle, 0);
  });
}

/**
 * Throws `invalid-input` unless the handle names the backend the route resolves for its chain. A
 * handle never chooses where requests go or which key goes with them (R-SEC-2).
 */
function checkBackend(handle: Handle, route: Route): void {
  if (handle.backend === route.backend) {
    return;
  }
  throw newError(
    {
      code: "invalid-input",
      issues: [{ field: "backend", message: `must be ${route.backend}, the route's backend` }],
    },
    `The handle names ${handle.backend}, but chain ${String(handle.chainId)} routes to ${route.backend}.`,
    {
      hint: "Pass the route option and the keys the submission used, or the handle that verify() returned for this route.",
      // Stryker disable next-line ArrayDeclaration: equivalent. The message names only backends and the chain id, never the text Stryker puts here.
      secrets: [],
    },
  );
}
