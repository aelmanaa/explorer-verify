/**
 * The public contract of explorer-verify, drafted from docs/contributor/requirements.md before any
 * backend exists. Every type is experimental until 1.0: change it when an implementation shows a
 * better shape, and record the change in the decision log.
 */
import type { BackendName, KeyedBackendName } from "./backend-names.ts";
import type { AnyExplorerVerifyError, ErrorJson, ExplorerVerifyError } from "./errors.ts";

/** A hex string with the `0x` prefix. */
export type Hex = `0x${string}`;

/**
 * The Solidity compiler's Standard JSON input, as solc reads it. Only the fields this library
 * reads are typed; the rest pass through to the explorer unchanged.
 *
 * @experimental
 */
export interface SolidityStandardJsonInput {
  /** Always `"Solidity"` for this input kind. */
  language: "Solidity";
  /** Source files by path, with their content. */
  sources: Record<
    string,
    {
      /** The source text, as the compiler read it. */
      content: string;
    }
  >;
  /** Compiler settings: optimizer, EVM version, libraries, metadata and so on. */
  settings: Record<string, unknown>;
}

/**
 * What to verify. `compiler` is a discriminated union so other languages (Vyper and others) can
 * be added as new members without changing existing callers (decision 0004). An optional field
 * set to `undefined` counts as absent.
 *
 * @experimental
 */
export interface VerifyInput {
  /** EVM chain id the contract is deployed on. */
  chainId: number;
  /** The deployed contract address. */
  address: Hex;
  /** The compiler and its input. */
  compiler: {
    /** The compiler family. */
    kind: "solc";
    /** Full version, as `0.8.24+commit.e11b9ed9`. */
    version: string;
    /** The Standard JSON input used for the deployment. */
    input: SolidityStandardJsonInput;
  };
  /** Fully qualified contract name, as `src/Token.sol:Token`. */
  contractName: string;
  /**
   * ABI-encoded constructor arguments without the selector. `0x` means none. When absent,
   * `verify()` derives them from the creation code for a backend that takes them, if
   * `creationBytecode` is set (R-IN-3). When set, they win: nothing is derived.
   */
  constructorArgs?: Hex | undefined;
  /**
   * The creation transaction hash. Lets backends that support it attempt a creation match, and
   * with `VerifyOptions.rpcUrl` it is where `verify()` reads the creation code.
   */
  creationTxHash?: Hex | undefined;
  /**
   * The compiled creation bytecode, the compiler's `evm.bytecode.object` with or without `0x`,
   * library placeholders (`__$`, 34 hex digits, `$__`) included. `verify()` uses it only to
   * derive missing `constructorArgs`: the creation code minus this prefix is the arguments
   * (R-IN-3). It is never sent to an explorer. `buildVerifyInput` fills it when the documents
   * hold it.
   */
  creationBytecode?: Hex | undefined;
  /**
   * Library link addresses, keyed by the library's fully qualified name, as
   * `{ "src/MathLib.sol:MathLib": "0x…" }` (R-IN-4). `verify()` checks them and sends
   * `compiler.input` unchanged (decision 0025): for a contract linked after compiling, adding the
   * addresses to `settings.libraries` changes the metadata hash. In a live test on 2026-11-03,
   * Sourcify then gave only a partial match.
   * Call `linkLibraries` to merge them into `settings.libraries` for an explorer that needs them
   * there.
   */
  libraries?: Record<string, Hex> | undefined;
}

/**
 * The outcome of a verification. `failed` means the explorer definitively rejected the
 * submission; any unknown or ambiguous state throws instead, so a caller never mistakes it for
 * success. `match` is `partial` when the explorer matched the code but not its metadata hash.
 *
 * `explorerUrl` is the public page of the verified contract. It is absent when the library knows
 * no such page, for example when `VerifyOptions.route` points at a self-hosted Sourcify server or
 * a local test server: the public Sourcify repository does not show what those servers verified.
 *
 * @example
 * ```ts
 * import type { VerifyResult } from "explorer-verify";
 *
 * function describe(result: VerifyResult): string {
 *   if (result.status === "failed") {
 *     return `rejected: ${result.reason}`;
 *   }
 *   return result.explorerUrl ?? `${result.status} on ${result.backend}`;
 * }
 * ```
 * @experimental
 */
export type VerifyResult =
  | {
      /** The explorer verified the source in this call. */
      status: "verified";
      /** The backend that verified it. */
      backend: BackendName;
      /** `partial` when the explorer matched the code but not its metadata hash. */
      match: "exact" | "partial";
      /** The public page of the contract. Absent when the library knows none. */
      explorerUrl?: string;
    }
  | {
      /** The explorer had verified the source before this call; nothing was submitted. */
      status: "already-verified";
      /** The backend that holds the verified source. */
      backend: BackendName;
      /** `partial` when the explorer matched the code but not its metadata hash. */
      match: "exact" | "partial";
      /** The public page of the contract. Absent when the library knows none. */
      explorerUrl?: string;
    }
  | {
      /** The explorer definitively rejected the submission. */
      status: "failed";
      /** The backend that rejected it. */
      backend: BackendName;
      /** The explorer's code and message, with API keys removed and cut to 300 characters. */
      reason: string;
    };

/**
 * The proxy that `linkProxy()` links to its implementation (R-FLOW-8). Other fields are ignored,
 * as `verify()` ignores fields its input does not declare.
 *
 * @example
 * ```ts
 * import type { LinkProxyTarget } from "explorer-verify";
 *
 * const target: LinkProxyTarget = {
 *   chainId: 11155111,
 *   address: "0xed5b8413e605598ef86cd7617f12701f74ca255c",
 *   expectedImplementation: "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920",
 * };
 * ```
 * @experimental
 */
export interface LinkProxyTarget {
  /** EVM chain id the proxy is deployed on. */
  chainId: number;
  /** The proxy's address. */
  address: Hex;
  /**
   * The implementation the proxy should point at now: the address in its EIP-1967 slot, not the
   * one it was deployed with if it was upgraded since. When set, any other implementation the
   * explorer reports gives `mismatch`. Etherscan also receives it as `expectedimplementation`.
   */
  expectedImplementation?: Hex | undefined;
}

/**
 * The outcome of `linkProxy()`. `linked` means the explorer links the proxy to the implementation
 * (the expected one, when `expectedImplementation` is set). `mismatch` means it holds another
 * implementation than `expectedImplementation`. `not-linked` means the explorer definitively
 * refused: the proxy is not verified there, or it detects no implementation. Any unknown answer
 * throws instead, so a caller never mistakes it for a link.
 *
 * @example
 * ```ts
 * import type { LinkProxyResult } from "explorer-verify";
 *
 * function describe(result: LinkProxyResult): string {
 *   if (result.status === "not-linked") {
 *     return `not linked: ${result.reason}`;
 *   }
 *   if (result.status === "mismatch") {
 *     return `points at ${result.implementation ?? "another address"}, not ${result.expectedImplementation}`;
 *   }
 *   return `linked to ${result.implementation}${result.implementationVerified ? "" : " (not verified)"}`;
 * }
 * ```
 * @experimental
 */
export type LinkProxyResult =
  | {
      /** The explorer links the proxy to `implementation`. */
      status: "linked";
      /** The backend that holds the link. */
      backend: BackendName;
      /** The implementation the explorer reports, `0x` and 40 lowercase hex digits. */
      implementation: Hex;
      /**
       * Whether the explorer holds the implementation's verified source. `false`, as for
       * Etherscan's "unverified - without ABI" answer, means the proxy page shows no functions
       * yet: verify the implementation, then call `linkProxy()` again.
       */
      implementationVerified: boolean;
      /** The public page of the proxy. Absent when the library knows none. */
      explorerUrl?: string;
    }
  | {
      /**
       * The explorer links the proxy to another implementation than `expectedImplementation`, or
       * refused the link because the proxy points elsewhere. The proxy may have been upgraded
       * since: read its EIP-1967 slot, then call `linkProxy()` with that address.
       */
      status: "mismatch";
      /** The backend that holds the link. */
      backend: BackendName;
      /**
       * The implementation the explorer holds for the proxy, `0x` and 40 lowercase hex digits.
       * Absent when the explorer names none: Etherscan's refusal does not say it, so it is read
       * from its record of the proxy, which may be empty, or with a lookup that fails.
       */
      implementation?: Hex;
      /** The `expectedImplementation` of the call, in lower case. */
      expectedImplementation: Hex;
    }
  | {
      /** The explorer refused to link the proxy. */
      status: "not-linked";
      /** The backend that refused. */
      backend: BackendName;
      /** Why, from the explorer's answer, with API keys removed and cut to 300 characters. */
      reason: string;
    };

/**
 * What `dryRun()` returns: where a `verify()` call with the same input and options would go, and
 * what the explorer holds now (R-AX-8). Nothing was submitted.
 *
 * - `lookup` is the already-verified check: `exact` or `partial` when the explorer holds a match,
 *   so `verify()` would return `already-verified` without a submit; `none` when it holds none, so
 *   `verify()` would submit; `skipped` when the backend needs an API key and none is set, so no
 *   request was sent.
 * - `explorerUrl` is the public page of the contract, present only for a match the library knows a
 *   page for.
 * - `routedBy` says how the backend was chosen; see {@link RoutedBy}.
 *
 * @example
 * ```ts
 * import type { DryRunResult } from "explorer-verify";
 *
 * function describe(result: DryRunResult): string {
 *   return result.lookup === "skipped"
 *     ? `${result.backend} needs an API key; the lookup was skipped`
 *     : `${result.backend} at ${result.apiHost}: ${result.lookup}`;
 * }
 * ```
 * @experimental
 */
export interface DryRunResult {
  /** Always `dry-run`. */
  status: "dry-run";
  /** The backend `verify()` would use. */
  backend: BackendName;
  /** The API host `verify()` would send to, such as `sourcify.dev`. Never a scheme or a path. */
  apiHost: string;
  /** What the already-verified check found, or `skipped` when the backend has no key. */
  lookup: "exact" | "partial" | "none" | "skipped";
  /** The public page of the contract, for a match the library knows a page for. */
  explorerUrl?: string;
  /** How the backend was chosen. `dryRun()` always sets it. */
  routedBy?: RoutedBy;
}

/**
 * How a call's backend was chosen, as `verify.routed` and `DryRunResult` report it:
 *
 * - `caller`: `route.backend` named it.
 * - `table`: the routing table picked it: the first backend the chain's row lists that needs no
 *   key or has one.
 * - `fallback`: the chain has no row, and `allowSourcifyFallback` sent the call to Sourcify.
 * - `api-url`: `route.apiUrl` named the server.
 *
 * @example
 * ```ts
 * import type { RoutedBy } from "explorer-verify";
 *
 * const chosen: RoutedBy = "table";
 * ```
 * @experimental
 */
export type RoutedBy = "caller" | "table" | "fallback" | "api-url";

/**
 * One log field value: flat and JSON-safe, so it maps to a JSON Lines record or an OpenTelemetry
 * attribute without conversion (R-DX-5).
 *
 * @experimental
 */
export type LogValue = string | number | boolean | null;

/**
 * The structured fields of one log line, such as the backend or the attempt number. Values are
 * flat. Field names are diagnostics and may change in any release; a program reads
 * {@link VerifyEvent} objects instead (R-DX-5).
 *
 * @example
 * ```ts
 * import type { LogFields } from "explorer-verify";
 *
 * const fields: LogFields = { backend: "sourcify", attempt: 2, delayMs: 1_000 };
 * ```
 * @experimental
 */
export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * Receives the library's log lines (R-DX-5). Each method takes a message and optional flat
 * fields, both with API keys removed (R-SEC-1). `console` fits this shape, and a logger that reads
 * only the message keeps working. Messages and fields are diagnostics: their wording may change in
 * any release.
 *
 * The library never logs at `error` a failure it throws: the thrown `ExplorerVerifyError` carries
 * it. A method that throws is ignored and does not change the outcome.
 *
 * @example
 * ```ts
 * import type { LogFields, Logger } from "explorer-verify";
 *
 * // User code: print lines at info and above, with fields only when a line has them.
 * const print =
 *   (write: (...data: unknown[]) => void) =>
 *   (message: string, fields?: LogFields): void => {
 *     if (fields === undefined) {
 *       write(message);
 *     } else {
 *       write(message, fields);
 *     }
 *   };
 * const logger: Logger = {
 *   debug: () => {},
 *   info: print(console.info),
 *   warn: print(console.warn),
 *   error: print(console.error),
 * };
 * ```
 * @experimental
 */
export interface Logger {
  /** Request and polling detail. */
  debug: (message: string, fields?: LogFields) => void;
  /** Progress a person may want to see. */
  info: (message: string, fields?: LogFields) => void;
  /** A retry, a recovered problem, or an `onEvent` callback that threw. */
  warn: (message: string, fields?: LogFields) => void;
  /** A failure the library recovers from or does not throw. Never a failure it throws. */
  error: (message: string, fields?: LogFields) => void;
}

/**
 * A stage event, passed to `VerifyOptions.onEvent` (R-DX-6). The union is keyed by `type`. Every
 * value is flat and JSON-safe, and API keys are removed from every string (R-SEC-1). The
 * `event.schema.json` file in the package describes the same objects.
 *
 * | `type`             | Emitted when                                       |
 * | ------------------ | -------------------------------------------------- |
 * | `verify.validated` | The input passed validation                        |
 * | `verify.routed`    | The route is resolved                              |
 * | `verify.lookup`    | The already-verified check finished or was skipped |
 * | `verify.submitted` | The explorer accepted the submission               |
 * | `verify.poll`      | One poll returned a state that is not final        |
 * | `verify.retry`     | A request is retried after a transient failure     |
 * | `verify.result`    | The call is about to return a result               |
 *
 * Within a schema version, a release adds event types or fields and never removes or changes one.
 *
 * @example
 * ```ts
 * import type { VerifyEvent } from "explorer-verify";
 *
 * // User code: keep the handle, count retries, and fail to compile when a type is added.
 * let retries = 0;
 * function onEvent(event: VerifyEvent): void {
 *   switch (event.type) {
 *     case "verify.submitted":
 *       localStorage.setItem("pending-verification", event.handle);
 *       break;
 *     case "verify.retry":
 *       retries += 1;
 *       break;
 *     case "verify.validated":
 *     case "verify.routed":
 *     case "verify.lookup":
 *     case "verify.poll":
 *     case "verify.result":
 *       break;
 *     default: {
 *       const unknown: never = event;
 *       throw new Error(`Unknown event ${JSON.stringify(unknown)}`);
 *     }
 *   }
 * }
 * ```
 * @experimental
 */
export type VerifyEvent =
  | {
      /** The event type. */
      readonly type: "verify.validated";
      /** EVM chain id the contract is deployed on. */
      readonly chainId: number;
      /** The contract address. */
      readonly address: Hex;
    }
  | {
      /** The event type. */
      readonly type: "verify.routed";
      /** The backend the call goes to. */
      readonly backend: BackendName;
      /** The API host, such as `sourcify.dev`. Never a scheme, a path or a query. */
      readonly apiHost: string;
      /** How the backend was chosen. */
      readonly routedBy?: RoutedBy;
      /**
       * The backends the routing table lists before `backend` that the call passed over, because
       * each needs an API key and none is set: names joined with `,`, in table order. Present
       * only when `routedBy` is `table` and one was passed over.
       */
      readonly skipped?: string;
    }
  | {
      /** The event type. */
      readonly type: "verify.lookup";
      /** The backend that was asked. */
      readonly backend: BackendName;
      /** What the already-verified check found, or `skipped` when it did not run. */
      readonly match: "exact" | "partial" | "none" | "skipped";
    }
  | {
      /** The event type. */
      readonly type: "verify.submitted";
      /** The backend that accepted the submission. */
      readonly backend: BackendName;
      /** The handle in its one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`. */
      readonly handle: string;
    }
  | {
      /** The event type. */
      readonly type: "verify.poll";
      /** The backend that was polled. */
      readonly backend: BackendName;
      /** The poll number, from 1. */
      readonly attempt: number;
      /** The state the explorer reported. */
      readonly state: "pending" | "queued" | "completed";
    }
  | {
      /** The event type. */
      readonly type: "verify.retry";
      /** The backend the request goes to. */
      readonly backend: BackendName;
      /** The number of the attempt that follows the wait: 2 for the first retry. */
      readonly attempt: number;
      /** Why the previous attempt failed. */
      readonly reason:
        | "rate-limited"
        | "network"
        | "server-error"
        | "duplicate-submission"
        | "not-indexed"
        | "empty-submit";
      /** The wait before that attempt, in milliseconds. */
      readonly delayMs: number;
    }
  | {
      /** The event type. */
      readonly type: "verify.result";
      /** The backend that gave the result. */
      readonly backend: BackendName;
      /** The result's status. */
      readonly status: "verified" | "already-verified";
      /** The result's match. */
      readonly match: "exact" | "partial";
    }
  | {
      /** The event type. */
      readonly type: "verify.result";
      /** The backend that gave the result. */
      readonly backend: BackendName;
      /** The result's status. A failed result has no match. */
      readonly status: "failed";
    };

/**
 * Overrides the route for one call: which backend to use and where its API lives, for example a
 * self-hosted Sourcify server or a local fake in tests. Hosts come only from here or from the
 * routing table, never from a {@link Handle} (R-SEC-2). A field set to `undefined` counts as
 * absent; a key other than these three throws `invalid-input` naming `route.<key>`.
 *
 * @example
 * ```ts
 * import type { RouteOverride } from "explorer-verify";
 *
 * const route: RouteOverride = { backend: "sourcify", apiUrl: "https://sourcify.example.org/server" };
 * ```
 * @experimental
 */
export interface RouteOverride {
  /**
   * The backend to use instead of the one the routing table picks. Without `apiUrl`, the
   * routing table must list it for the chain; otherwise the call throws `unsupported-chain`
   * naming the chain and the backend. `blockscout-hosted` is the exception: the table never lists
   * it, and without `apiUrl` it goes to `https://api.blockscout.com/<chainId>/api` for any chain
   * (decision 0041). With `apiUrl`, any backend goes. A name outside
   * `BACKEND_NAMES`, or a backend this version has no client for, throws `invalid-input` naming
   * `route.backend`.
   */
  backend?: BackendName | undefined;
  /**
   * The API base URL. It must be a string of at most 8192 characters: an absolute `https:` URL,
   * or an `http:` URL whose host is exactly `localhost`, `127.0.0.1` or `[::1]`, with no user
   * name, password or fragment. Trailing slashes are removed. A query string is sent with every
   * request and redacted in logs. Only the query is redacted, so never put a key in the host or
   * path. Any other value throws `invalid-input` naming `route.apiUrl`, without repeating the
   * value. It works for any chain, including one the routing table does not list. Without
   * `backend`, the backend is `sourcify`. A URL other than the routing table's for the backend
   * and chain means results carry no `explorerUrl`. No key from `apiKeys` is ever sent to a
   * `route.apiUrl`, even one that names the routing table's own URL; pass `route.apiKey` for it.
   */
  apiUrl?: string | undefined;
  /**
   * The API key for this route's explorer, bound to the route's API host: it is sent only to that
   * host, and only for requests of the route's backend (R-SEC-2). Use it for an explorer on its
   * own host, such as a standalone Etherscan-compatible explorer, which `apiKeys` does not accept.
   * It wins over `apiKeys` for the route's backend.
   *
   * It needs `apiUrl` in the same override: without it, `invalid-input` names `route.apiKey`, so a
   * key never reaches the routing table's host for the chain. The same value rules as an `apiKeys`
   * value apply. A backend that takes no key, such as `sourcify`, throws `invalid-input` naming
   * `route.apiKey`.
   */
  apiKey?: string | undefined;
}

/**
 * The options every call to an explorer takes: `verify()`, `dryRun()`, `checkStatus()`,
 * `linkProxy()` and `verifyEach()`. Each function has its own options type that extends this one
 * with the fields it reads, so a misplaced key in an object literal fails to compile (decision
 * 0047). At run time, `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()` all accept every
 * key of `VerifyOptions`, so one options object can go to each.
 *
 * Every field is optional, and a field set to `undefined` counts as absent, so a value that may be
 * `undefined` can be passed straight through. Any other key throws `invalid-input` before any
 * request: the issue names the key and, when one matches it ignoring case or by prefix, the option
 * it may mean, such as `timeoutMs` for `timeout`. It never repeats the key's value. A later
 * release adds fields without changing these, so existing callers keep working (decision 0009).
 *
 * @example
 * ```ts
 * import type { CallOptions } from "explorer-verify";
 *
 * const controller = new AbortController();
 * const options: CallOptions = { signal: controller.signal, timeoutMs: 60_000 };
 * ```
 * @experimental
 */
export interface CallOptions {
  /**
   * The `fetch` every request goes through. Defaults to `globalThis.fetch` (R-SRV-5). The library
   * sends every request with `redirect: "manual"` and never follows a redirect: a redirect could
   * carry a key to another host. An injected `fetch` must keep that behaviour and must not follow
   * redirects itself. An injected `fetch` does not turn off the missing-key check: to send
   * Etherscan requests to a server that adds the key, set `handlerUrl`.
   */
  fetch?: typeof fetch | undefined;
  /**
   * The URL of your server handler (`createVerifyHandler` from `explorer-verify/server`), which
   * holds the Etherscan key and adds it (R-SRV-5, decision 0046). Set it in browser code, where an
   * Etherscan key must not be.
   *
   * - Each request to Etherscan's v2 API goes to this URL instead, with its query, method, headers
   *   and body, and no key. Requests to other explorers go to them directly. Log lines, events and
   *   errors name this URL, path included, for those requests, so it must not hold a secret.
   * - The routing table chooses as if `apiKeys["etherscan-v2"]` were set: a chain whose row lists
   *   Etherscan first goes to the handler, and other chains go where they would with a key. Set
   *   `route.backend` to choose yourself.
   * - The call needs no Etherscan key. A key bound to the route through the handler,
   *   `apiKeys["etherscan-v2"]` or a `route.apiKey` on Etherscan's API, throws `invalid-input`:
   *   the handler adds its own key.
   * - Requests go through `fetch` when it is set, so a logging or retrying `fetch` still works.
   * - A path such as `/api/verify` resolves against the page, so it works only in a browser page;
   *   elsewhere it throws `invalid-input`. Pass an absolute `https://` URL there, or `http://` on
   *   `localhost`, `127.0.0.1` or `[::1]`. No user name, password, query, fragment, whitespace,
   *   control character or backslash, not Etherscan's own host, and at most 2048 characters.
   *   `undefined` counts as absent. The check loads on demand, when a call starts.
   *
   * @example
   * ```ts
   * import type { VerifyOptions } from "explorer-verify";
   *
   * const options: VerifyOptions = { handlerUrl: "/api/verify" };
   * ```
   */
  handlerUrl?: string | undefined;
  /** Cancels the call. The call rejects with `signal.reason` unchanged (R-FLOW-6). */
  signal?: AbortSignal | undefined;
  /**
   * Time budget for the whole call, polling included, in milliseconds. Defaults to 120000. A
   * positive number; a value above 2147483647 is lowered to it.
   */
  timeoutMs?: number | undefined;
  /** Receives log lines with keys removed. Nothing is logged when it is absent (R-DX-5). */
  logger?: Logger | undefined;
  /**
   * Receives the stage events, with keys removed (R-DX-6). Nothing is emitted when it is absent.
   * An exception it throws, or a rejection of a promise it returns, is logged once at `warn` and
   * does not change the outcome. A returned promise is not awaited.
   */
  onEvent?: ((event: VerifyEvent) => void | Promise<void>) | undefined;
  /**
   * Overrides the routing table for this call. A key other than `backend`, `apiUrl` and `apiKey`
   * throws `invalid-input` naming `route.<key>`.
   */
  route?: RouteOverride | undefined;
  /**
   * Lets a chain that the routing table does not list resolve to the public Sourcify API (R-RT-3).
   * Defaults to `false`: such a chain throws `unsupported-chain`, whose hint names this option and
   * the `route` override. A value that is not a boolean throws `invalid-input`.
   *
   * @example
   * ```ts
   * import type { VerifyOptions } from "explorer-verify";
   *
   * const options: VerifyOptions = { allowSourcifyFallback: true };
   * ```
   */
  allowSourcifyFallback?: boolean | undefined;
  /**
   * API keys by backend name (decision 0009, amended by 0016 and 0041). A key is sent only to its
   * backend's one API host, `api.etherscan.io` for `etherscan-v2`, `api.routescan.io` for
   * `routescan` and `api.blockscout.com` for `blockscout-hosted`, Blockscout's hosted API, and
   * only when the call's route resolves to that backend (R-SEC-2). A route that moves `apiUrl` to
   * another host gets no key from here; pass `route.apiKey` for it.
   *
   * - Accepted names: `etherscan-v2`, `routescan` and `blockscout-hosted`, the
   *   {@link KeyedBackendName} type. In JavaScript, `etherscan-compatible` throws `invalid-input`:
   *   each standalone explorer has its own host, so its key goes in `route.apiKey`. `sourcify` and
   *   `blockscout`, whose instances take no key, throw too.
   * - Each value is a primitive string of 8 to 1024 characters, each a letter, a digit, `.`, `_`,
   *   `~` or `-`, and not all digits. A bad value throws `invalid-input` naming
   *   `apiKeys.<backend>`, never the value. So does a key found in the contract address or the
   *   handle's `ev1:<backend>:<chainId>:<address>` part, which redaction would corrupt. An
   *   `undefined` value counts as absent.
   * - Only own enumerable string-keyed properties are read, each once; a non-enumerable property
   *   or a Symbol key is ignored. The object must be a plain object.
   * - Every key is removed from logs, events, errors and results (R-SEC-1).
   * - When the route's backend needs a key (`etherscan-v2`, `blockscout-hosted`) and none is
   *   bound to its host, the call throws `missing-api-key` before any request, whether `fetch` is
   *   set or not. Only `handlerUrl` sends an Etherscan request without a key, to your server
   *   handler.
   *
   * Etherscan's terms forbid an Etherscan key in browser code. In a browser, set `handlerUrl` to a
   * server handler that holds the key instead (R-SRV-5). Blockscout's hosted API sends no CORS
   * headers and the server handler does not forward Blockscout, so a browser cannot use
   * `blockscout-hosted`; use `blockscout`, an instance, which needs no key.
   *
   * @example
   * ```ts
   * import type { VerifyOptions } from "explorer-verify";
   *
   * declare const etherscanKey: string; // read on a server, never shipped to a browser
   * const options: VerifyOptions = { apiKeys: { "etherscan-v2": etherscanKey } };
   * ```
   */
  apiKeys?: ApiKeys | undefined;
}

/**
 * Options for `verify()`: the {@link CallOptions}, plus the poll interval and the JSON-RPC
 * endpoint that `verify()` derives missing constructor arguments from. Any other key throws
 * `invalid-input` naming it.
 *
 * @example
 * ```ts
 * import type { VerifyOptions } from "explorer-verify";
 *
 * const controller = new AbortController();
 * const options: VerifyOptions = {
 *   signal: controller.signal,
 *   timeoutMs: 60_000,
 *   pollIntervalMs: 5_000,
 * };
 * ```
 * @experimental
 */
export interface VerifyOptions extends CallOptions {
  /**
   * Wait between two status polls, in milliseconds. Defaults to 3000. A positive number; a value
   * below 1000 is raised to 1000, and one above 2147483647 is lowered to it.
   */
  pollIntervalMs?: number | undefined;
  /**
   * A JSON-RPC endpoint of the contract's chain. `verify()` uses it only to derive missing
   * constructor arguments (R-IN-3): it checks `eth_chainId`, then reads the transaction that
   * `creationTxHash` names and its receipt. An absolute `https` URL, or `http` on `localhost`,
   * `127.0.0.1` or `[::1]`, with no user name, password or fragment. Its path segments and query
   * values of 8 or more characters are redacted from logs, events and errors, because providers
   * put keys there; the host name is not, so never put a key in it.
   *
   * @example
   * ```ts
   * import type { VerifyOptions } from "explorer-verify";
   *
   * const options: VerifyOptions = { rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" };
   * ```
   */
  rpcUrl?: string | undefined;
}

/**
 * Options for `dryRun()`: the {@link CallOptions}, plus `rpcUrl`, which it checks as `verify()`
 * does without sending it a request. A dry run polls nothing, so the type leaves out
 * `pollIntervalMs`; at run time `dryRun()` accepts and checks it, so an object built for
 * `verify()` works.
 *
 * @example
 * ```ts
 * import type { DryRunOptions } from "explorer-verify";
 *
 * const options: DryRunOptions = { timeoutMs: 30_000 };
 * ```
 * @experimental
 */
export interface DryRunOptions extends CallOptions {
  /**
   * The JSON-RPC endpoint a `verify()` call would derive constructor arguments from. `dryRun()`
   * checks it with the rules of `VerifyOptions.rpcUrl` and redacts it the same way, and sends it
   * no request.
   */
  rpcUrl?: string | undefined;
}

/**
 * Options for `checkStatus()`: the {@link CallOptions}, plus `pollIntervalMs`. It polls a job
 * that was already submitted, so the type leaves out `rpcUrl`; at run time `checkStatus()` accepts
 * and checks it, so an object built for `verify()` works.
 *
 * @example
 * ```ts
 * import type { CheckStatusOptions } from "explorer-verify";
 *
 * const options: CheckStatusOptions = { timeoutMs: 60_000, pollIntervalMs: 5_000 };
 * ```
 * @experimental
 */
export interface CheckStatusOptions extends CallOptions {
  /**
   * Wait between two status polls, in milliseconds. Defaults to 3000. A positive number; a value
   * below 1000 is raised to 1000, and one above 2147483647 is lowered to it.
   */
  pollIntervalMs?: number | undefined;
}

/**
 * Options for `linkProxy()`: the {@link CallOptions}, plus `pollIntervalMs`, the wait between two
 * checks of the link. The type leaves out `rpcUrl`; at run time `linkProxy()` accepts and checks
 * it, so an object built for `verify()` works.
 *
 * @example
 * ```ts
 * import type { LinkProxyOptions } from "explorer-verify";
 *
 * const options: LinkProxyOptions = { timeoutMs: 60_000, pollIntervalMs: 5_000 };
 * ```
 * @experimental
 */
export interface LinkProxyOptions extends CallOptions {
  /**
   * Wait between two checks of the link, in milliseconds. Defaults to 3000. A positive number; a
   * value below 1000 is raised to 1000, and one above 2147483647 is lowered to it.
   */
  pollIntervalMs?: number | undefined;
}

/**
 * The type of `VerifyOptions.apiKeys`: one key per backend that takes one, each optional. A key
 * that is `undefined` counts as absent.
 *
 * @example
 * ```ts
 * import type { ApiKeys } from "explorer-verify";
 *
 * declare const etherscanKey: string; // read on a server, never shipped to a browser
 * const keys: ApiKeys = { "etherscan-v2": etherscanKey };
 * ```
 * @experimental
 */
export type ApiKeys = { [B in KeyedBackendName]?: string | undefined };

/**
 * One backend of a `verifyEach()` call: a backend name, which the routing table resolves for the
 * chain, or a route override that names its backend, such as a standalone explorer with its own
 * `apiUrl` and `apiKey` (R-RT-2, R-RT-4).
 *
 * @example
 * ```ts
 * import type { BackendEntry } from "explorer-verify";
 *
 * const entries: BackendEntry[] = [
 *   "sourcify",
 *   { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
 * ];
 * ```
 * @experimental
 */
export type BackendEntry =
  | BackendName
  | (RouteOverride & {
      /** The backend of this entry. Required here: an entry always names its backend. */
      backend: BackendName;
    });

/**
 * Options for `verifyEach()`: those of `verify()` without `route`, plus `backends`. Each entry of
 * `backends` carries its own route, so a top-level `route` throws `invalid-input`. Any other key
 * that is not listed here throws `invalid-input` naming it, and so does a key of an entry object
 * other than `backend`, `apiUrl` and `apiKey`.
 *
 * @example
 * ```ts
 * import type { VerifyEachOptions } from "explorer-verify";
 *
 * declare const etherscanKey: string; // read on a server, never shipped to a browser
 * const options: VerifyEachOptions = {
 *   backends: ["sourcify", "etherscan-v2"],
 *   apiKeys: { "etherscan-v2": etherscanKey },
 *   timeoutMs: 120_000,
 * };
 * ```
 * @experimental
 */
export interface VerifyEachOptions extends Omit<VerifyOptions, "route"> {
  /**
   * The backends to verify on, at most 16, or `"all"` for every backend the routing table lists
   * for the chain that this version has a client for. An entry is a backend name or a route
   * override that names its backend. Two entries with the same backend and the same `apiUrl`, or
   * the same backend both without one, throw `invalid-input`.
   */
  backends: readonly BackendEntry[] | "all";
}

/**
 * What one backend of a `verifyEach()` call ended with. `ok` is `true` exactly for `verified` and
 * `already-verified`. A `failed` result has `ok: false` and the result. An error has `ok: false`
 * and the `ExplorerVerifyError` the call on that backend threw, with its `details`; for
 * `not-confirmed`, `details.handle` resumes that backend alone with `checkStatus()`. In an
 * envelope, `E` is `ErrorJson`: `toEnvelope()` writes each error as its `toJSON()`.
 *
 * The position of an outcome in `outcomes` identifies its entry of `backends`, since two entries
 * may name the same backend on different hosts.
 *
 * @example
 * ```ts
 * import type { BackendOutcome } from "explorer-verify";
 *
 * function line(outcome: BackendOutcome): string {
 *   if ("error" in outcome) {
 *     return `${outcome.backend}: ${outcome.error.code}`;
 *   }
 *   return `${outcome.backend}: ${outcome.result.status}`;
 * }
 * ```
 * @experimental
 */
export type BackendOutcome<E extends ExplorerVerifyError | ErrorJson = AnyExplorerVerifyError> =
  | {
      /** The backend of this outcome. */
      backend: BackendName;
      /** `true`: the backend holds the verified source. */
      ok: true;
      /** The verified or already-verified result. */
      result: Extract<VerifyResult, Record<"status", "verified" | "already-verified">>;
    }
  | {
      /** The backend of this outcome. */
      backend: BackendName;
      /** `false`: the explorer rejected the submission. */
      ok: false;
      /** The failed result. */
      result: Extract<VerifyResult, Record<"status", "failed">>;
    }
  | {
      /** The backend of this outcome. */
      backend: BackendName;
      /** `false`: the call on this backend threw. */
      ok: false;
      /** The error the call on this backend threw; `ErrorJson`, its `toJSON()`, in an envelope. */
      error: E;
    };

/**
 * What `verifyEach()` returns: one outcome per entry of `backends`, in the same order (R-RT-4).
 *
 * @example
 * ```ts
 * import type { VerifyEachResult } from "explorer-verify";
 *
 * function allVerified(result: VerifyEachResult): boolean {
 *   return result.outcomes.every((outcome) => outcome.ok);
 * }
 * ```
 * @experimental
 */
export interface VerifyEachResult<
  E extends ExplorerVerifyError | ErrorJson = AnyExplorerVerifyError,
> {
  /** One outcome per backend, in the order of `backends`. */
  outcomes: BackendOutcome<E>[];
}

/**
 * Identifies a submitted verification so polling can continue later, in another process or after
 * a page reload (R-FLOW-5). It is plain JSON and survives `JSON.stringify` and `JSON.parse`.
 *
 * It carries no URL. When polling resumes, the library resolves the API from `backend`, `chainId`
 * and the caller's `route` option, so a handle read from untrusted storage cannot choose where
 * requests go (R-SEC-2). Read a stored handle back with `parseHandle`.
 *
 * @example
 * ```ts
 * import type { Handle } from "explorer-verify";
 *
 * const handle: Handle = {
 *   version: 1,
 *   backend: "sourcify",
 *   chainId: 11155111,
 *   address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
 *   jobId: "550e8400-e29b-41d4-a716-446655440000",
 * };
 * localStorage.setItem("pending-verification", JSON.stringify(handle));
 * ```
 * @experimental
 */
export interface Handle {
  /** Shape version. A later release that changes the shape still reads version 1. */
  version: 1;
  /** The backend that accepted the submission. */
  backend: BackendName;
  /** EVM chain id the contract is deployed on. */
  chainId: number;
  /** The contract address. In a handle from `verify()` it is in lower case, as `validateInput` returns it. */
  address: Hex;
  /** The backend's job id: Sourcify's `verificationId` or Etherscan's `guid`. */
  jobId: string;
}
