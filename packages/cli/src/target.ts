/**
 * The target of a submitting `verify` (R-AX-8, decision 0043). A submit publishes source and
 * cannot be undone, so `verify` submits only where the caller said: `--backend <name>` or
 * `--backend auto`. Without one it exits 2 before any request, with a hint that names the backends
 * the chain lists and what `auto` would pick, and why.
 *
 * The hint comes from `routesFor()`, which reads the routing table and sends no request. It holds
 * backend names and the chain id only, never a key.
 */
import { ExplorerVerifyError, routesFor } from "explorer-verify";
import type { ChainRoutes, RoutePick, VerifyInput, VerifyOptions } from "explorer-verify";

import { usageError } from "./command.ts";
import { ownHint } from "./hints.ts";
import { KEY_VARIABLES } from "./keys.ts";

/** The `--backend` value that lets the routing table pick the backend. */
export const AUTO = "auto";

/** What the caller named: `auto`, one or more backends, or nothing. */
export type Target = typeof AUTO | "named" | undefined;

/** The environment variable of Blockscout's hosted API key, `BLOCKSCOUT_API_KEY`. */
const HOSTED_KEY = KEY_VARIABLES.filter(({ backend }) => backend === "blockscout-hosted")
  .map(({ name }) => name)
  .join(" or ");

/** `a`, `a and b`, or `a, b and c`. */
function listed(names: readonly string[]): string {
  const last = names.slice(-1).join("");
  return names.length < 2 ? last : `${names.slice(0, -1).join(", ")} and ${last}`;
}

/** Why the routing table picked `pick.backend`, for the hint. */
function reason(pick: RoutePick, chain: string): string {
  if (pick.routedBy === "fallback") {
    return `the public Sourcify API, because the routing table has no row for ${chain}`;
  }
  if (pick.keyMissing) {
    return `${pick.backend}, but every backend ${chain} lists needs an API key and none is set, so the submit would exit 3 with missing-api-key`;
  }
  return pick.skipped.length === 0
    ? `${pick.backend}, the first backend ${chain} lists`
    : `${pick.backend}, because no API key is set for ${pick.skipped.join(" or ")}`;
}

/** The hint's advice, from the chain's routes. */
function advice(routes: ChainRoutes, chain: string, field: string): string {
  const request = field !== "--backend";
  const verb = request ? "set" : "pass";
  const auto = request ? `${field} "auto"` : `${field} auto`;
  // Blockscout's hosted API needs no row, so it is a target on any chain, with its key.
  const hosted = request
    ? `${field} "blockscout-hosted" with ${HOSTED_KEY}`
    : `${field} blockscout-hosted with ${HOSTED_KEY}`;
  const { pick } = routes;
  if (pick instanceof ExplorerVerifyError) {
    return request
      ? `The routing table has no row for ${chain}: set ${field} with route.apiUrl, or set ${hosted}.`
      : `The routing table has no row for ${chain}: pass ${auto} with --allow-sourcify-fallback to use the public Sourcify API, ${hosted}, or --backend with --api-url.`;
  }
  const which =
    pick.routedBy === "fallback"
      ? ""
      : `${verb} ${field} ${request ? "to" : "with"} one of the backends ${chain} lists (${listed(routes.listed)}) or blockscout-hosted with ${HOSTED_KEY}, or `;
  return `Name where to submit: ${which}${verb} ${auto} for the routing table's pick, which is ${reason(pick, chain)}.`;
}

/**
 * The `invalid-input` error of a submitting `verify` without a target. Its hint names the backends
 * the chain's row lists, in order, what `auto` would pick and why, and `--dry-run`. When the
 * routing table cannot be read, the hint names the options only: the run still exits 2.
 *
 * @param input - The checked input.
 * @param options - The options of the run: only the keys and the fallback option are read.
 * @param field - `--backend`, or `route.backend` for `--input-json`.
 * @param query - Reads the routes; the tests pass their own.
 * @returns The error to throw.
 */
export async function refusal(
  input: VerifyInput,
  options: VerifyOptions,
  field: string,
  query: typeof routesFor = routesFor,
): Promise<ExplorerVerifyError> {
  const { apiKeys, allowSourcifyFallback } = options;
  const chain = `chain ${String(input.chainId)}`;
  let text: string;
  try {
    const routes = await query(input.chainId, {
      ...(apiKeys === undefined ? {} : { apiKeys }),
      ...(allowSourcifyFallback === undefined ? {} : { allowSourcifyFallback }),
    });
    text = advice(routes, chain, field);
  } catch {
    // The table failed to load: the run still refuses, with the options alone.
    text = `Name where to submit: ${field} with a backend name, or auto for the routing table's pick.`;
  }
  const base = usageError([
    {
      field,
      message:
        "is needed to submit: a submit publishes the source and cannot be undone, so name the backend, or auto for the routing table's pick",
    },
  ]);
  return ownHint(
    new ExplorerVerifyError(base.details, base.message, {
      hint: `${text} Add --dry-run to see the target without submitting.`,
      secrets: [],
    }),
  );
}
