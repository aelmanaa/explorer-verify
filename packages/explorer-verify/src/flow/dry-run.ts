// References: R-AX-8.
/**
 * `dryRun()`: the steps of `verify()` before the submit. It validates, resolves the route
 * and looks the contract up through the same helpers as `verify()`, then stops. It never submits.
 * A match whose stored contract is not the input's is reported with `storedContract`, as
 * `verify()` would submit over it.
 */
import { BACKEND_LABELS } from "../backend-names.ts";
import type { Target } from "../backends/backend.ts";
import { keyMissing } from "../http/api-keys.ts";
import { validateInput } from "../input/validate.ts";
import type { DryRunOptions, DryRunResult, VerifyInput } from "../types.ts";
import { heldText, otherContract } from "./stored.ts";
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
 * @internal
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
      observer.emit({ type: "verify.lookup", backend: backend.name, lookup: "skipped" });
      observer.log.info(
        `${BACKEND_LABELS[backend.name]} needs an API key and none is set, so the dry run skipped the lookup. Nothing was submitted.`,
        fields,
      );
      return { ...base, lookup: "skipped", ...chosen };
    }
    const found = await backend.lookup(target, ctx);
    observer.emit({ type: "verify.lookup", backend: backend.name, lookup: found?.match ?? "none" });
    // References: decision 0063.
    const other = found === undefined ? undefined : otherContract(found, checked);
    observer.log.info(
      found === undefined
        ? `Dry run: ${BACKEND_LABELS[backend.name]} holds no match, so a verification would submit the source. Nothing was submitted.`
        : other === undefined
          ? found.match === "partial" && settings.submitOverPartial === true
            ? `Dry run: ${BACKEND_LABELS[backend.name]} holds a partial match of this source, so a verification with submitOverPartial would submit over it. Nothing was submitted.`
            : `Dry run: ${BACKEND_LABELS[backend.name]} already holds the contract (${found.match} match), so a verification would not submit${found.match === "partial" ? " unless submitOverPartial is set" : ""}.`
          : `Dry run: ${heldText(BACKEND_LABELS[backend.name], other)}, so a verification would submit. Nothing was submitted.`,
      fields,
    );
    if (found === undefined) {
      return { ...base, lookup: "none", ...chosen };
    }
    const explorerUrl = backend.explorerUrl(target, ctx);
    return {
      ...base,
      lookup: found.match,
      ...(explorerUrl === undefined ? {} : { explorerUrl }),
      ...chosen,
      ...(other === undefined ? {} : { storedContract: other }),
    };
  });
}
