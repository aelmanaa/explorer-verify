/**
 * The default entry's flow functions: `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` and
 * `linkProxy()`, each with every backend client, the routing table, the constructor argument
 * derivation and the `handlerUrl` code behind a dynamic `import()` (decisions 0031, 0040 and 0046).
 * A bundler that splits code puts each in a chunk of its own, and a call loads only what its route
 * needs.
 *
 * With `routing/load-table.ts`, this is the only module with a dynamic `import()`.
 * `explorer-verify/core` runs the same engine with the clients and the table its caller passes,
 * and never imports either (decision 0052).
 */
import type { Backend, ProxyLinker } from "../backends/backend.ts";
import type { withDerivedArgs as WithDerivedArgs } from "../input/constructor-args.ts";
import { loadRoutingTable } from "../routing/load-table.ts";
import type {
  CheckStatusOptions,
  DryRunOptions,
  DryRunResult,
  Handle,
  LinkProxyOptions,
  LinkProxyResult,
  LinkProxyTarget,
  VerifyEachOptions,
  VerifyEachResult,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../types.ts";
import { runDryRun } from "./dry-run.ts";
import { runLinkProxy } from "./link-proxy.ts";
import type { LinkDependencies } from "./link-proxy.ts";
import { runCheckStatus } from "./status.ts";
import { runVerifyEach } from "./verify-each.ts";
import { runVerify } from "./verify.ts";
import type { FlowDependencies, HandlerCode } from "./verify.ts";

/** Loads the shipped derivation, the first time a call derives (decisions 0031 and 0032). */
const loadDerivation = async (): Promise<typeof WithDerivedArgs> =>
  (await import("../input/constructor-args.ts")).withDerivedArgs;

/** Loads the `handlerUrl` code, in a chunk of its own (decision 0046). */
const loadHandlerCode = async (): Promise<HandlerCode> => await import("../http/handler-url.ts");

/** The loader of each backend's client. */
const BACKENDS: FlowDependencies["backends"] = {
  /** Loads the Sourcify client. */
  sourcify: async (): Promise<Backend> => (await import("../backends/sourcify.ts")).sourcify,
  /** Loads the Etherscan v2 client. */
  "etherscan-v2": async (): Promise<Backend> =>
    (await import("../backends/etherscan.ts")).etherscan,
  /** Loads the standalone Etherscan-compatible client, which imports the Etherscan v2 client's request code. */
  "etherscan-compatible": async (): Promise<Backend> =>
    (await import("../backends/etherscan-compatible.ts")).etherscanCompatible,
  /** Loads the Routescan client, which imports the Etherscan v2 client's request code. */
  routescan: async (): Promise<Backend> => (await import("../backends/routescan.ts")).routescan,
  /** Loads the Blockscout client. */
  blockscout: async (): Promise<Backend> => (await import("../backends/blockscout.ts")).blockscout,
  /** Loads the client for Blockscout's hosted API, from the same module (decision 0041). */
  "blockscout-hosted": async (): Promise<Backend> =>
    (await import("../backends/blockscout.ts")).blockscoutHosted,
};

/**
 * The backend clients `verify()`, `checkStatus()`, `dryRun()` and `verifyEach()` use. Each one
 * loads through a dynamic `import()` with a literal path, so a bundler that splits code puts it
 * in a chunk of its own, and a call loads only the client its route names (decision 0031). The
 * routing table and the `handlerUrl` code load the same way. `checkStatus()` and `dryRun()` never
 * derive constructor arguments, so the derivation's loader is only in
 * {@link VERIFY_DEPENDENCIES}: esbuild without splitting would otherwise inline it into them.
 */
export const DEFAULT_DEPENDENCIES: FlowDependencies = {
  backends: BACKENDS,
  /** Loads the routing table, only for a call without `route.apiUrl` (decision 0040). */
  table: loadRoutingTable,
  handler: loadHandlerCode,
};

/**
 * {@link DEFAULT_DEPENDENCIES} with the constructor argument derivation, loaded the first time a
 * call derives (decisions 0031 and 0032), for `verify()` and `verifyEach()`. A literal, not a
 * spread, so a bundler drops it from a bundle that does not verify.
 */
export const VERIFY_DEPENDENCIES: FlowDependencies = {
  backends: BACKENDS,
  table: loadRoutingTable,
  handler: loadHandlerCode,
  derivation: loadDerivation,
};

/**
 * The proxy-link code `linkProxy()` uses. Each one loads through a dynamic `import()` with a
 * literal path, so a bundler that splits code puts it in a chunk of its own. Routescan has none
 * yet: what its `verifyproxycontract` does is not known.
 */
export const DEFAULT_LINK_DEPENDENCIES: LinkDependencies = {
  linkers: {
    /** Loads the Etherscan v2 proxy-link code. */
    "etherscan-v2": async (): Promise<ProxyLinker> =>
      (await import("../backends/proxy-etherscan.ts")).etherscanProxyLinker,
    /** Loads the standalone Etherscan-compatible proxy-link code. */
    "etherscan-compatible": async (): Promise<ProxyLinker> =>
      (await import("../backends/proxy-etherscan.ts")).compatibleProxyLinker,
    /** Loads the Blockscout proxy-link code. */
    blockscout: async (): Promise<ProxyLinker> =>
      (await import("../backends/proxy-blockscout.ts")).blockscoutProxyLinker,
    /** The same code links on Blockscout's hosted API (decision 0041). */
    "blockscout-hosted": async (): Promise<ProxyLinker> =>
      (await import("../backends/proxy-blockscout.ts")).blockscoutProxyLinker,
    /** Loads the Sourcify proxy-link code. */
    sourcify: async (): Promise<ProxyLinker> =>
      (await import("../backends/proxy-sourcify.ts")).sourcifyProxyLinker,
  },
  /** Loads the routing table, only for a call without `route.apiUrl` (decision 0040). */
  table: loadRoutingTable,
  handler: loadHandlerCode,
};

/**
 * Verifies a deployed contract's source on the explorer the route names (R-FLOW-1 to R-FLOW-6).
 *
 * 1. Validates the input and the options, and resolves the route. Nothing is sent before both
 *    pass (R-IN-6).
 * 2. Looks the contract up. When the explorer already holds an `exact` or `partial` match, it
 *    returns `already-verified` with that match and sends no submission (R-FLOW-1).
 * 3. Submits the source. This is outward and permanent: the explorer publishes it. When the
 *    explorer answers that the contract is already verified, it returns `already-verified`.
 * 4. Polls the job every `pollIntervalMs` until it ends or `timeoutMs` is spent (R-FLOW-2). The
 *    budget covers every request, the submit and its retries included.
 * 5. Maps the outcome (R-FLOW-3, R-FLOW-4): `verified` with the match, `already-verified` when
 *    the job found the contract verified, or `failed` with the explorer's reason, only for a
 *    definitive rejection. Any other final state throws.
 * 6. When the budget runs out while the job is still pending, it looks the contract up once more,
 *    within one more `pollIntervalMs`: some explorers finish before their status endpoint says so.
 *    A match returns `verified`; otherwise it throws `not-confirmed` with the handle.
 * 7. When a poll answers that the explorer no longer knows the job, it looks the contract up once,
 *    within the same window. A match returns `verified`; otherwise it throws `job-not-found` with
 *    the handle.
 *
 * So the call ends within `timeoutMs` plus one `pollIntervalMs`.
 *
 * `already-verified` can describe a verification this call caused. When the submit got no clear
 * answer, the client looks the contract up before it submits again; if the first submit was
 * accepted and has finished, that lookup finds the contract verified.
 *
 * The handle is passed to `onEvent` in a `verify.submitted` event, and logged at `info`, as soon as
 * the explorer accepts the submission, so a call that is aborted or that crashes after that point
 * can still be resumed (R-FLOW-5).
 *
 * @param input - What to verify. It is checked with `validateInput` first.
 * @param options - Fetch, abort signal, time budget, poll interval, logger, event callback and
 *   route. Every field is optional.
 * @returns `verified` or `already-verified` with the match and, when the library knows one, the
 *   public page of the contract; or `failed` with the explorer's reason, API keys removed.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6).
 * @throws ExplorerVerifyError with `invalid-input` for bad input or options; `unsupported-chain`;
 *   `network` when a module of the library fails to load, such as a chunk the page cannot fetch
 *   (decision 0054); `timeout` when the budget runs out before the explorer accepts the submission;
 *   `not-confirmed`, with the handle, when it runs out while the job is pending;
 *   `verification-inconclusive` when the job ends without a verdict; `unknown-state` for a final
 *   state the library cannot classify; `job-not-found`, with the handle, when the explorer no
 *   longer knows the job and a lookup finds no match or fails; `in-progress`, `network`,
 *   `rate-limited` and `unexpected-response`. See the error reference for each.
 * @example
 * ```ts
 * import { ExplorerVerifyError, formatHandle, verify } from "explorer-verify";
 *
 * try {
 *   const result = await verify(input, { timeoutMs: 60_000 });
 *   if (result.status === "failed") {
 *     console.error(`Rejected: ${result.reason}`);
 *   } else {
 *     console.log(`${result.status} (${result.match}) ${result.explorerUrl ?? ""}`);
 *   }
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
 *     localStorage.setItem("pending-verification", formatHandle(error.details.handle));
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 * @experimental
 */
export async function verify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult> {
  return await runVerify(input, options, VERIFY_DEPENDENCIES);
}

/**
 * Runs the steps of `verify()` that send no submission, and reports what `verify()` would do
 * (R-AX-8). Use it to check an input, the route and the keys before a real run.
 *
 * 1. Validates the input and the options, and resolves the route, as `verify()` does. A bad
 *    input throws `invalid-input`, and a chain with no route throws `unsupported-chain`.
 * 2. When the route's backend needs an API key and none is set, it sends no request: the result
 *    says `lookup: "skipped"`. `verify()` would throw `missing-api-key` here. With `handlerUrl`,
 *    whose server handler adds the key, it looks the contract up.
 * 3. Otherwise it looks the contract up once and returns what it found.
 *
 * It emits `verify.validated`, `verify.routed` and `verify.lookup`, whose `match` is `skipped`
 * when no request was sent. It emits no `verify.submitted` and no `verify.result`.
 *
 * @param input - What `verify()` would verify. It is checked with `validateInput` first.
 * @param options - The options of `verify()`. `pollIntervalMs` and `rpcUrl` are checked and not
 *   used; `rpcUrl` is sent no request.
 * @returns The backend, its API host, how it was chosen and the lookup's answer.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6).
 * @throws ExplorerVerifyError with `invalid-input` for bad input or options; `unsupported-chain`;
 *   `network` when a module of the library fails to load (decision 0054); and `network`,
 *   `rate-limited`, `timeout`, `unexpected-response` or a key error when the lookup fails.
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
export async function dryRun(input: VerifyInput, options?: DryRunOptions): Promise<DryRunResult> {
  return await runDryRun(input, options, DEFAULT_DEPENDENCIES);
}

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
 *   `timeout` when the client does not load within the budget; `network` when it fails to load
 *   (decision 0054); `unknown-state`, `network`, `rate-limited` and `unexpected-response`.
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
 * Verifies a deployed contract's source on several backends in one call (R-RT-4), and returns
 * one outcome per entry of `options.backends`, in the same order.
 *
 * 1. Validates the input and the options, reads `backends` and resolves each entry's route.
 *    Nothing is sent before all of them pass. `"all"` stands for every backend the routing table
 *    lists for the chain that this version has a client for, less a backend that needs a key when
 *    none is set, as the routing table chooses for `verify()`. Two entries that resolve to the same
 *    backend and API URL, and a key found in the address or a handle's fixed part, throw
 *    `invalid-input`. An entry is known by its position: the same backend may appear twice on two
 *    hosts. Fields of an entry other than `backend`, `apiUrl` and `apiKey` are ignored, as in `route`.
 * 2. Runs the steps of `verify()` on every backend at once, with one time budget, `timeoutMs`,
 *    shared by all of them, and the caller's `signal`. Each backend gets only its own key: a key
 *    from `apiKeys` goes only to its backend's routing-table host, and `route.apiKey` only to its
 *    entry's `apiUrl` (decision 0016).
 * 3. Maps each backend's end to an outcome: `{ backend, ok: true, result }` for `verified` or
 *    `already-verified`, `{ backend, ok: false, result }` for `failed`, and
 *    `{ backend, ok: false, error }` with the `ExplorerVerifyError` for an error. A `not-confirmed`
 *    error keeps its handle, so `checkStatus()` with that entry's route resumes that backend alone.
 *    A backend the chain's row does not list is an `unsupported-chain` outcome, and a client
 *    module that fails to load a `network` outcome with the load's error as its cause; the other
 *    backends still run. The routing table loads only when an entry needs it, mostly one without
 *    `apiUrl`, or for `"all"` (decision 0040). When it fails to load, each entry that needs it
 *    gets that outcome too, as a client's load failure; for `"all"`, the call throws that
 *    `network` error (decision 0054).
 *
 * It emits `verify.validated` once, then each backend's events as `verify()` emits them. Every
 * event after the first carries its `backend`, so the streams interleave.
 *
 * @param input - What to verify. It is checked with `validateInput` first.
 * @param options - The options of `verify()` without `route`, and `backends`.
 * @returns One outcome per backend.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6). The
 *   `verify.submitted` event of every submission made before the abort was emitted.
 * @throws ExplorerVerifyError `invalid-input` for bad input, options or `backends`, and
 *   `unsupported-chain` for `"all"` on a chain the routing table does not list. Nothing was sent.
 * @throws Any error that is not an `ExplorerVerifyError` and does not come from a client load,
 *   which only a bug can cause.
 * @example
 * ```ts
 * import { verifyEach } from "explorer-verify";
 *
 * declare const etherscanKey: string;
 *
 * const { outcomes } = await verifyEach(input, {
 *   backends: ["sourcify", "etherscan-v2"],
 *   apiKeys: { "etherscan-v2": etherscanKey },
 * });
 * for (const outcome of outcomes) {
 *   console.log(outcome.backend, outcome.error !== undefined ? outcome.error.code : outcome.result.status);
 * }
 * ```
 * @experimental
 */
export async function verifyEach(
  input: VerifyInput,
  options: VerifyEachOptions,
): Promise<VerifyEachResult> {
  return await runVerifyEach(input, options, VERIFY_DEPENDENCIES);
}

/**
 * Links a verified proxy to its implementation on the explorer the route names, so the explorer
 * shows the implementation's functions on the proxy's page (R-FLOW-8). It verifies nothing
 * itself. Run the steps in this order: verify the implementation, verify the proxy, then link.
 *
 * - Etherscan v2 and a standalone Etherscan-compatible explorer: sends `verifyproxycontract`, with
 *   `expectedimplementation` when set, then checks `checkproxyverification` every
 *   `pollIntervalMs`. This changes the proxy's page on the explorer.
 * - Blockscout: sends `verifyproxycontract`, which asks the instance to read the implementation
 *   again, then checks `checkproxyverification`, then looks the implementation up. Right after
 *   `verify()` it refuses a request within a short interval; the call then waits that interval
 *   once, when it fits `timeoutMs`, and otherwise reads the implementation Blockscout holds.
 * - Sourcify: sends nothing that changes Sourcify. One lookup reads the implementation Sourcify
 *   recorded when it verified the proxy, and one more says whether the implementation is verified.
 * - Routescan: throws `invalid-input` on `route.backend` and sends nothing.
 *
 * Linking again is safe: a call never undoes a link. The call ends within `timeoutMs` plus one
 * request. It emits `verify.routed`, then `verify.poll` for each pending check, and HTTP retries as
 * `verify.retry`; no `verify.validated` and no `verify.result`.
 *
 * A request answered in a form the library does not know throws `unexpected-response`: nothing
 * started. A status check answered with a text it does not know, or an implementation that is not
 * one address, throws `proxy-link-unknown-state`: the explorer may have changed the proxy's page.
 *
 * @param target - The proxy's chain id and address, and the implementation it should point at.
 *   Other fields are ignored.
 * @param options - The options of `verify()`; `rpcUrl` is checked and not used. Etherscan needs `apiKeys["etherscan-v2"]`.
 * @returns `linked`, with the implementation and whether its source is verified; `mismatch` when
 *   the explorer holds another implementation than `expectedImplementation`; or `not-linked` with
 *   the explorer's reason, API keys removed.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts.
 * @throws ExplorerVerifyError with `invalid-input` for a bad target or options, or for Routescan;
 *   `proxy-link-pending` when the link is still pending when `timeoutMs` runs out (call again
 *   later); `proxy-link-unknown-state` for a link state the library cannot classify;
 *   `missing-api-key`, `unsupported-chain`, `timeout`, `network` (also when the proxy-link
 *   module fails to load, decision 0054), `rate-limited` and `unexpected-response`.
 * @example
 * ```ts
 * import { linkProxy, verify } from "explorer-verify";
 *
 * const options = { apiKeys: { "etherscan-v2": apiKey } };
 * await verify(implementationInput, options); // 1. the implementation
 * await verify(proxyInput, options); // 2. the proxy
 * const result = await linkProxy(
 *   { chainId: proxyInput.chainId, address: proxyInput.address, expectedImplementation: implementationInput.address },
 *   options,
 * ); // 3. the link
 * if (result.status === "linked") {
 *   console.log(`linked to ${result.implementation}`);
 * } else if (result.status === "mismatch") {
 *   console.error(`the proxy points at ${result.implementation ?? "another implementation"}`);
 * } else {
 *   console.error(`not linked: ${result.reason}`);
 * }
 * ```
 * @experimental
 */
export async function linkProxy(
  target: LinkProxyTarget,
  options?: LinkProxyOptions,
): Promise<LinkProxyResult> {
  return await runLinkProxy(target, options, DEFAULT_LINK_DEPENDENCIES);
}
