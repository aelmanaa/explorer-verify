/**
 * `dryRun()`: the steps of `verify()` before the submit (R-AX-8). It validates, resolves the route
 * and looks the contract up through the same helpers as `verify()`, then stops. It never submits.
 */
import type { Target } from "../backends/backend.ts";
import { keyMissing } from "../http/api-keys.ts";
import { validateInput } from "../input/validate.ts";
import type { DryRunOptions, DryRunResult, VerifyInput } from "../types.ts";
import {
  abortWins,
  announceRoute,
  apiHostOf,
  kindsOf,
  openCall,
  routeOf,
  settingsOf,
  startBudget,
  withClient,
  withHandler,
} from "./verify.ts";
import type { FlowDependencies } from "./verify.ts";

/**
 * {@link dryRun} with its dependencies passed in. Internal: the package entry point does not export
 * it.
 *
 * @param input - What to check.
 * @param options - The caller's options.
 * @param dependencies - The backend clients and the routing table.
 * @returns The result.
 * @example
 * ```ts
 * const result = await runDryRun(input, { fetch }, { backends: { sourcify } });
 * ```
 */
export async function runDryRun(
  input: VerifyInput,
  options: DryRunOptions | undefined,
  dependencies: FlowDependencies,
): Promise<DryRunResult> {
  const read = settingsOf(options);
  read.signal?.throwIfAborted();
  return await abortWins(read.signal, async () => {
    const checked = validateInput(input);
    const budget = startBudget(read);
    const settings = await withHandler(read, budget, dependencies.handler, dependencies.missing);
    const route = await routeOf(
      checked.chainId,
      settings,
      dependencies,
      budget,
      kindsOf(checked, dependencies),
    );
    const target: Target = { chainId: checked.chainId, address: checked.address };
    const loaded = await withClient(route, dependencies, settings, budget);
    const call = openCall(settings, route, target, loaded, false, budget);
    const { backend, ctx, observer } = call;
    observer.emit({ type: "verify.validated", chainId: target.chainId, address: target.address });
    announceRoute(call, `Dry run for ${target.address} on chain ${String(target.chainId)}`);
    const apiHost = apiHostOf(ctx);
    const { routedBy } = route;
    const fields = { backend: backend.name, routedBy };
    const base = { status: "dry-run", backend: backend.name, apiHost } as const;
    const chosen = { routedBy };
    if (
      keyMissing({ route, apiKeys: settings.apiKeys }, settings.handler?.serves(route) === true)
    ) {
      observer.emit({ type: "verify.lookup", backend: backend.name, match: "skipped" });
      observer.log.info(
        `${backend.name} needs an API key and none is set, so the dry run skipped the lookup. Nothing was submitted.`,
        fields,
      );
      return { ...base, lookup: "skipped", ...chosen };
    }
    const found = await backend.lookup(target, ctx);
    observer.emit({ type: "verify.lookup", backend: backend.name, match: found ?? "none" });
    observer.log.info(
      found === undefined
        ? `Dry run: ${backend.name} holds no match, so a verification would submit the source. Nothing was submitted.`
        : `Dry run: ${backend.name} already holds the contract (${found} match), so a verification would not submit.`,
      fields,
    );
    if (found === undefined) {
      return { ...base, lookup: "none", ...chosen };
    }
    const explorerUrl = backend.explorerUrl(target, ctx);
    return explorerUrl === undefined
      ? { ...base, lookup: found, ...chosen }
      : { ...base, lookup: found, explorerUrl, ...chosen };
  });
}
