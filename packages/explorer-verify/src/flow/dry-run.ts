/**
 * `dryRun()`: the steps of `verify()` before the submit (R-AX-8). It validates, resolves the route
 * and looks the contract up through the same helpers as `verify()`, then stops. It never submits.
 */
import type { Target } from "../backends/backend.ts";
import { keyMissing } from "../http/api-keys.ts";
import { validateInput } from "../input/validate.ts";
import type { DryRunResult, VerifyInput, VerifyOptions } from "../types.ts";
import {
  DEFAULT_DEPENDENCIES,
  abortWins,
  announceRoute,
  openCall,
  routeOf,
  settingsOf,
} from "./verify.ts";
import type { FlowDependencies } from "./verify.ts";

/**
 * Runs the steps of `verify()` that send no submission, and reports what `verify()` would do
 * (R-AX-8). Use it to check an input, the route and the keys before a real run.
 *
 * 1. Validates the input and the options, and resolves the route, as `verify()` does. A bad
 *    input throws `invalid-input`, and a chain with no route throws `unsupported-chain`.
 * 2. When the route's backend needs an API key and none is set, it sends no request: the result
 *    says `lookup: "skipped"`. `verify()` would throw `missing-api-key` here. With an injected
 *    `fetch`, which may lead to a server that adds the key, it looks the contract up.
 * 3. Otherwise it looks the contract up once and returns what it found.
 *
 * It emits `verify.validated`, `verify.routed` and `verify.lookup`, whose `match` is `skipped`
 * when no request was sent. It emits no `verify.submitted` and no `verify.result`.
 *
 * @param input - What `verify()` would verify. It is checked with `validateInput` first.
 * @param options - The same options as `verify()`. `pollIntervalMs` is not used.
 * @returns The backend, its API host and the lookup's answer.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6).
 * @throws ExplorerVerifyError with `invalid-input` for bad input or options; `unsupported-chain`;
 *   and `network`, `rate-limited`, `timeout`, `unexpected-response` or a key error when the lookup
 *   fails.
 * @example
 * ```ts
 * import { dryRun } from "explorer-verify";
 *
 * const result = await dryRun(input);
 * if (result.lookup === "none") {
 *   console.log(`verify() would submit to ${result.backend} at ${result.apiHost}`);
 * }
 * ```
 * @experimental
 */
export async function dryRun(input: VerifyInput, options?: VerifyOptions): Promise<DryRunResult> {
  return await runDryRun(input, options, DEFAULT_DEPENDENCIES);
}

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
  options: VerifyOptions | undefined,
  dependencies: FlowDependencies,
): Promise<DryRunResult> {
  const settings = settingsOf(options);
  settings.signal?.throwIfAborted();
  return await abortWins(settings.signal, async () => {
    const checked = validateInput(input);
    const route = routeOf(checked.chainId, settings, dependencies);
    const target: Target = { chainId: checked.chainId, address: checked.address };
    const call = openCall(settings, route, target, dependencies, false);
    const { backend, ctx, observer } = call;
    observer.emit({ type: "verify.validated", chainId: target.chainId, address: target.address });
    announceRoute(call, `Dry run for ${target.address} on chain ${String(target.chainId)}`);
    const apiHost = new URL(ctx.route.apiBase).host;
    const fields = { backend: backend.name };
    if (keyMissing({ route, apiKeys: settings.apiKeys }, settings.fetch !== undefined)) {
      observer.emit({ type: "verify.lookup", backend: backend.name, match: "skipped" });
      observer.log.info(
        `${backend.name} needs an API key and none is set, so the dry run skipped the lookup. Nothing was submitted.`,
        fields,
      );
      return { status: "dry-run", backend: backend.name, apiHost, lookup: "skipped" };
    }
    const found = await backend.lookup(target, ctx);
    observer.emit({ type: "verify.lookup", backend: backend.name, match: found ?? "none" });
    observer.log.info(
      found === undefined
        ? `Dry run: ${backend.name} holds no match, so verify() would submit. Nothing was submitted.`
        : `Dry run: ${backend.name} already holds the contract (${found} match), so verify() would not submit.`,
      fields,
    );
    if (found === undefined) {
      return { status: "dry-run", backend: backend.name, apiHost, lookup: "none" };
    }
    const explorerUrl = backend.explorerUrl(target, ctx);
    return explorerUrl === undefined
      ? { status: "dry-run", backend: backend.name, apiHost, lookup: found }
      : { status: "dry-run", backend: backend.name, apiHost, lookup: found, explorerUrl };
  });
}
