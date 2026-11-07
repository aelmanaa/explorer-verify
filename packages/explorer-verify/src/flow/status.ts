// References: R-FLOW-5.
/**
 * `checkStatus()`: resumes a submitted verification from its handle. It runs the poll
 * and result steps of `verify()` through the same helpers, so a resumed job ends as it would have
 * in `verify()`.
 */
import type { Target } from "../backends/backend.ts";
import { newError } from "../error-hints.ts";
import type { Route } from "../routing/resolve.ts";
import type { CheckStatusOptions, Handle, VerifyResult } from "../types.ts";
import { parseHandle } from "./handle.ts";
import {
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
 * @internal
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
    const settings = await withHandler(read, budget, dependencies.handler, dependencies.missing);
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

// References: R-SEC-2.
/**
 * Throws `invalid-input` unless the handle names the backend the route resolves for its chain. A
 * handle never chooses where requests go or which key goes with them.
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
