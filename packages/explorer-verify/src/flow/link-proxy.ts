/**
 * `linkProxy()`: links a verified proxy to its implementation on the explorer the route names
 * (R-FLOW-8). It is a separate export from `verify()`, and each explorer's proxy-link code loads
 * with a dynamic `import()` only when a call is routed to it, so a caller who imports only
 * `verify` does not bundle any of it (R-RUN-5, decision 0033).
 */
import { BACKEND_NAMES } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import type { Context, LinkTarget, LinkVerdict, ProxyLinker } from "../backends/backend.ts";
import { newError } from "../error-hints.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { sleep } from "../http/fetch.ts";
import type { Budget } from "../http/fetch.ts";
import { addressDigits, readChainId, readFields } from "../internal/read-fields.ts";
import type { Observer } from "../observe.ts";
import { checkRoute, routeFrom } from "../routing/resolve.ts";
import type { Route, RoutingTable, TableLoader } from "../routing/resolve.ts";
import type { Hex, LinkProxyOptions, LinkProxyResult } from "../types.ts";
import {
  MAX_POLL_FAILURES,
  abortWins,
  bounded,
  openContext,
  settingsOf,
  startBudget,
  tableFor,
  apiHostOf,
  choiceKeys,
  withHandler,
} from "./verify.ts";
import type { HandlerLoader, LinkMissing, Settings } from "./verify.ts";

/** Loads one explorer's proxy-link code. */
export type LinkerLoader = () => Promise<ProxyLinker>;

/**
 * What `linkProxy()` takes besides the caller's target and options. The default entry passes
 * `DEFAULT_LINK_DEPENDENCIES`; `explorer-verify/core` passes the proxy-link clients and the table
 * its caller gave (decision 0052). The tests pass linkers of their own, a fixed `random` for the
 * backoff jitter, or a routing table.
 */
export interface LinkDependencies {
  /** The proxy-link code of each backend that has one, loaded or the function that loads it. */
  readonly linkers: Readonly<Partial<Record<BackendName, ProxyLinker | LinkerLoader>>>;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /**
   * The routing table, or the function that loads it, read only for a call without
   * `route.apiUrl` (decision 0040). Absent, such a call throws `invalid-input` naming `table`.
   */
  readonly table?: RoutingTable | TableLoader | undefined;
  /** Loads the `handlerUrl` code; absent, a call with `handlerUrl` throws `invalid-input`. */
  readonly handler?: HandlerLoader | undefined;
  /** Set by `explorer-verify/core`: the errors for what its caller left out. */
  readonly missing?: LinkMissing | undefined;
}

/** The proxy-link code each loader has given, by loader. */
const LINKERS = new WeakMap<LinkerLoader, ProxyLinker>();

// The poll errors that mean "no answer this time": checking goes on after them.
const CHECK_FAILURES: readonly ExplorerVerifyError["code"][] = [
  "network",
  "rate-limited",
  "unexpected-response",
];

/** What one call shares once its route and its linker are known. */
interface LinkCall {
  readonly backend: BackendName;
  readonly linker: ProxyLinker;
  readonly target: LinkTarget;
  readonly route: Route;
  readonly ctx: Context;
  readonly observer: Observer;
  readonly settings: Settings;
  readonly budget: Budget;
}

/**
 * {@link linkProxy} with its dependencies passed in. Internal: the package entry point does not
 * export it.
 *
 * @param value - The target.
 * @param options - The caller's options.
 * @param dependencies - The proxy-link code and the jitter source.
 * @returns The result.
 * @example
 * ```ts
 * const result = await runLinkProxy(target, { fetch }, { linkers: { sourcify: sourcifyProxyLinker } });
 * ```
 */
export async function runLinkProxy(
  value: unknown,
  options: LinkProxyOptions | undefined,
  dependencies: LinkDependencies,
): Promise<LinkProxyResult> {
  const read = settingsOf(options);
  read.signal?.throwIfAborted();
  const target = checkTarget(value);
  // Before routing: a backend named in route.backend that cannot link is refused with no lookup
  // of the routing table and no request.
  const named = readFields(read.route)?.get("backend");
  const chosen = BACKEND_NAMES.find((name) => name === named);
  if (chosen !== undefined && dependencies.linkers[chosen] === undefined) {
    throw dependencies.missing?.linker(chosen, read.keySecrets()) ?? cannotLink(chosen, read);
  }
  const checked = checkRoute(target.chainId, read.route, BACKEND_NAMES);
  // The routing table and the linker load inside abortWins, as in verify(): an abort during a
  // load rejects with signal.reason. Most routes with route.apiUrl load no table (decision 0040).
  return await abortWins(read.signal, async () => {
    const budget = startBudget(read);
    const settings = await withHandler(read, budget, dependencies.handler, dependencies.missing);
    const table = await tableFor(
      checked,
      dependencies.table,
      settings,
      budget,
      dependencies.missing,
    );
    const route = routeFrom(target.chainId, checked, {
      apiKeys: choiceKeys(settings),
      allowSourcifyFallback: settings.allowSourcifyFallback === true,
      clients: BACKEND_NAMES,
      table,
    });
    const load = dependencies.linkers[route.backend];
    // A standalone entry of the routing table is not linked: Bitlayer refuses the POSTs a link
    // sends, and no standalone explorer's proxy answers were probed (decision 0039).
    if (load === undefined || (route.backend === "etherscan-compatible" && !route.overridden)) {
      throw (
        (load === undefined
          ? dependencies.missing?.linker(route.backend, settings.keySecrets())
          : undefined) ?? cannotLink(route.backend, settings)
      );
    }
    const linker =
      typeof load === "function"
        ? await bounded(
            load,
            LINKERS,
            `the ${route.backend} proxy-link code`,
            route.backend,
            settings.signal,
            budget,
          )
        : load;
    const { ctx, observer } = openContext(
      settings,
      route,
      target,
      dependencies.random,
      true,
      budget,
    );
    const call: LinkCall = {
      backend: route.backend,
      linker,
      target,
      route,
      ctx,
      observer,
      settings,
      budget,
    };
    return await link(call);
  });
}

/**
 * `invalid-input` on `route.backend` for a backend this version cannot link a proxy on, or for an
 * `etherscan-compatible` route from the routing table rather than `route.apiUrl`. Through
 * `explorer-verify/core`, a backend that has proxy-link code but whose client the caller left out
 * of `clients` gets `LinkMissing.linker` instead (decision 0052).
 */
function cannotLink(backend: BackendName, settings: Settings): ExplorerVerifyError {
  return newError(
    {
      code: "invalid-input",
      issues: [{ field: "route.backend", message: `${backend} cannot link a proxy` }],
    },
    `This version cannot link a proxy on ${backend}.`,
    {
      hint: "Pass route.backend as etherscan-v2, blockscout or sourcify, whichever serves the chain, or as etherscan-compatible with the explorer's route.apiUrl.",
      secrets: settings.keySecrets(),
    },
  );
}

/** Sends the link request, checks it until it ends, and maps the end to a result. */
async function link(call: LinkCall): Promise<LinkProxyResult> {
  const { backend, linker, target, ctx, observer } = call;
  observer.emit({ type: "verify.routed", backend, apiHost: apiHostOf(ctx) });
  observer.log.debug(
    `Linking proxy ${target.address} on chain ${String(target.chainId)} on ${backend}`,
    { backend, chainId: target.chainId, api: ctx.route.redactedApiUrl },
  );
  const step = await linker.request(target, ctx);
  if (step.state === "submitted") {
    observer.log.info(`${backend} accepted the proxy link request (job ${step.jobId})`, {
      backend,
    });
    return await finish(call, await checkUntilDone(call, step.jobId));
  }
  return await finish(call, step);
}

/**
 * Checks the link every `pollIntervalMs` until it ends. A check that fails with `network`,
 * `rate-limited` or `unexpected-response` is logged at `warn` and checking goes on. When the
 * budget runs out, or {@link MAX_POLL_FAILURES} checks in a row fail, it throws
 * `proxy-link-pending`.
 */
async function checkUntilDone(call: LinkCall, jobId: string): Promise<LinkVerdict> {
  const { backend, linker, target, ctx, observer, settings } = call;
  const { deadline } = call.budget;
  let attempt = 0;
  let failures = 0;
  let cause: ExplorerVerifyError | undefined;
  for (;;) {
    await sleep(
      Math.max(0, Math.min(settings.pollIntervalMs, deadline - Date.now())),
      settings.signal,
    );
    if (deadline - Date.now() <= 0) {
      throw pending(call, "the time budget ran out", cause);
    }
    attempt += 1;
    let verdict: LinkVerdict;
    try {
      verdict = await linker.check(jobId, target, ctx);
    } catch (error: unknown) {
      // After an abort, a failed check is not logged as one: the call rejects with the reason.
      if (settings.signal?.aborted === true || !(error instanceof ExplorerVerifyError)) {
        throw error;
      }
      if (error.code === "timeout") {
        throw pending(call, "the time budget ran out", error);
      }
      if (!CHECK_FAILURES.includes(error.code)) {
        throw error;
      }
      failures += 1;
      cause = error;
      observer.log.warn(
        `${backend} proxy link check ${String(attempt)} failed (${error.code}); ${failures < MAX_POLL_FAILURES ? "checking again" : "giving up"}`,
        { backend, attempt, code: error.code, failures },
      );
      if (failures >= MAX_POLL_FAILURES) {
        throw pending(call, `${String(MAX_POLL_FAILURES)} status checks in a row failed`, cause);
      }
      continue;
    }
    failures = 0;
    if (verdict.state !== "pending") {
      return verdict;
    }
    observer.emit({ type: "verify.poll", backend, attempt, state: "pending" });
    observer.log.debug(`${backend} proxy link is pending (check ${String(attempt)})`, {
      backend,
      attempt,
    });
  }
}

/** Maps how the link ended to a result. */
async function finish(call: LinkCall, verdict: LinkVerdict): Promise<LinkProxyResult> {
  const { backend, linker, target, ctx, observer, route } = call;
  if (verdict.state === "pending") {
    // Only `check` answers pending, and checkUntilDone never returns it.
    throw pending(call, "the explorer answered that the link is pending", undefined);
  }
  if (verdict.state === "not-linked") {
    return notLinked(observer, backend, verdict.reason);
  }
  const expected = target.expectedImplementation;
  if (verdict.state === "mismatch") {
    if (expected === undefined) {
      // Only a call with expectedImplementation can be refused for another implementation.
      throw newError(
        {
          code: "proxy-link-unknown-state",
          backend,
          excerpt: "mismatch: the explorer refused for another implementation than expected",
        },
        `${backend} refused the link for another implementation than expected, but this call expected none.`,
        { secrets: ctx.http.secrets },
      );
    }
    return mismatch(observer, backend, verdict.implementation, expected);
  }
  const { implementation } = verdict;
  if (expected !== undefined && implementation !== expected) {
    return mismatch(observer, backend, implementation, expected);
  }
  const implementationVerified =
    verdict.implementationVerified ??
    (linker.verified === undefined
      ? false
      : await linker.verified(implementation, target.chainId, ctx));
  const explorerUrl = route.explorerUrl?.(target.address);
  observer.log.info(
    `Result: linked to ${implementation}${implementationVerified ? "" : " (implementation not verified)"} on ${backend}`,
    { backend, status: "linked" },
  );
  return explorerUrl === undefined
    ? { status: "linked", backend, implementation, implementationVerified }
    : { status: "linked", backend, implementation, implementationVerified, explorerUrl };
}

/** A `mismatch` result, logged at `info`. */
function mismatch(
  observer: Observer,
  backend: BackendName,
  implementation: Hex | undefined,
  expectedImplementation: Hex,
): LinkProxyResult {
  observer.log.info(
    `Result: the proxy points at ${implementation ?? "another implementation"}, not ${expectedImplementation}, on ${backend}`,
    { backend, status: "mismatch" },
  );
  return implementation === undefined
    ? { status: "mismatch", backend, expectedImplementation }
    : { status: "mismatch", backend, implementation, expectedImplementation };
}

/** A `not-linked` result, logged at `info`. */
function notLinked(observer: Observer, backend: BackendName, reason: string): LinkProxyResult {
  observer.log.info(`Result: not linked on ${backend}`, { backend, status: "not-linked" });
  return { status: "not-linked", backend, reason };
}

/** `proxy-link-pending`: the explorer had not finished, and calling again is safe. */
function pending(call: LinkCall, why: string, cause: unknown): ExplorerVerifyError {
  const { backend, target, ctx } = call;
  return newError(
    { code: "proxy-link-pending", backend },
    `The link of proxy ${target.address} on ${backend} is not confirmed: ${why} before the explorer finished.`,
    cause === undefined ? { secrets: ctx.http.secrets } : { secrets: ctx.http.secrets, cause },
  );
}

/**
 * Checks the target: an object with `chainId` a positive safe integer, and `address` and the
 * optional `expectedImplementation` each `0x` and 40 hex digits. Returns them with the addresses
 * in lower case. Only own properties are read, each once.
 *
 * @throws ExplorerVerifyError `invalid-input` naming each bad field, never its value.
 */
function checkTarget(value: unknown): LinkTarget {
  // readFields drops what a throwing getter or Proxy trap says: it may repeat a caller value.
  const fields = readFields(value);
  if (fields === undefined) {
    throw invalidTarget([{ field: "target", message: "must be an object" }]);
  }
  const issues: InputIssue[] = [];
  const chainId = readChainId(fields.get("chainId"));
  if (chainId === undefined) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }
  const address = addressDigits(fields.get("address"));
  if (address === undefined) {
    issues.push({ field: "address", message: "must be 0x followed by 40 hex digits" });
  }
  const rawExpected = fields.get("expectedImplementation");
  const expected = addressDigits(rawExpected);
  const badExpected = rawExpected !== undefined && expected === undefined;
  if (badExpected) {
    issues.push({
      field: "expectedImplementation",
      message: "must be 0x followed by 40 hex digits",
    });
  }
  if (chainId === undefined || address === undefined || badExpected) {
    // issues is never empty here: each check above pushed one.
    throw invalidTarget(issues);
  }
  return {
    chainId,
    address: `0x${address.toLowerCase()}`,
    ...(expected === undefined ? {} : { expectedImplementation: `0x${expected.toLowerCase()}` }),
  };
}

function invalidTarget(issues: InputIssue[]): ExplorerVerifyError {
  return newError(
    { code: "invalid-input", issues },
    `The proxy target is invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    {
      hint: "Pass chainId as a positive integer, address and expectedImplementation as 0x and 40 hex digits.",
      // Stryker disable next-line ArrayDeclaration: equivalent. The message and the issues name only fields, never the text Stryker puts here.
      secrets: [],
    },
  );
}
