/**
 * The public contract of explorer-verify, drafted from docs/contributor/requirements.md before any
 * backend exists. Every type is experimental until 1.0: change it when an implementation shows a
 * better shape, and record the change in the decision log.
 */
import type { BackendName } from "./backend-names.ts";

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
  sources: Record<string, { content: string }>;
  /** Compiler settings: optimizer, EVM version, libraries, metadata and so on. */
  settings: Record<string, unknown>;
}

/**
 * What to verify. `compiler` is a discriminated union so other languages (Vyper and others) can
 * be added as new members without changing existing callers (decision 0004).
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
  /** ABI-encoded constructor arguments without the selector. Derived from the creation code when absent. */
  constructorArgs?: Hex;
  /** The creation transaction hash. Lets backends that support it attempt a creation match. */
  creationTxHash?: Hex;
  /**
   * Library link addresses, keyed by the library's fully qualified name, as
   * `{ "src/MathLib.sol:MathLib": "0x…" }` (R-IN-4). `verify()` checks them and sends
   * `compiler.input` unchanged (decision 0025): for a contract linked after compiling, adding the
   * addresses to `settings.libraries` changes the metadata hash. In a live test on 2026-11-03,
   * Sourcify then gave only a partial match.
   * Call `linkLibraries` to merge them into `settings.libraries` for an explorer that needs them
   * there.
   */
  libraries?: Record<string, Hex>;
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
      status: "verified";
      backend: BackendName;
      match: "exact" | "partial";
      /** The public page of the contract. Absent when the library knows none. */
      explorerUrl?: string;
    }
  | {
      status: "already-verified";
      backend: BackendName;
      match: "exact" | "partial";
      /** The public page of the contract. Absent when the library knows none. */
      explorerUrl?: string;
    }
  | { status: "failed"; backend: BackendName; reason: string };

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
      readonly type: "verify.validated";
      /** EVM chain id the contract is deployed on. */
      readonly chainId: number;
      /** The contract address. */
      readonly address: Hex;
    }
  | {
      readonly type: "verify.routed";
      /** The backend the call goes to. */
      readonly backend: BackendName;
      /** The API host, such as `sourcify.dev`. Never a scheme, a path or a query. */
      readonly apiHost: string;
    }
  | {
      readonly type: "verify.lookup";
      /** The backend that was asked. */
      readonly backend: BackendName;
      /** What the already-verified check found, or `skipped` when it did not run. */
      readonly match: "exact" | "partial" | "none" | "skipped";
    }
  | {
      readonly type: "verify.submitted";
      /** The backend that accepted the submission. */
      readonly backend: BackendName;
      /** The handle in its one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`. */
      readonly handle: string;
    }
  | {
      readonly type: "verify.poll";
      /** The backend that was polled. */
      readonly backend: BackendName;
      /** The poll number, from 1. */
      readonly attempt: number;
      /** The state the explorer reported. */
      readonly state: "pending" | "queued" | "completed";
    }
  | {
      readonly type: "verify.retry";
      /** The backend the request goes to. */
      readonly backend: BackendName;
      /** The number of the attempt that follows the wait: 2 for the first retry. */
      readonly attempt: number;
      /** Why the previous attempt failed. */
      readonly reason: "rate-limited" | "network" | "server-error" | "duplicate-submission";
      /** The wait before that attempt, in milliseconds. */
      readonly delayMs: number;
    }
  | {
      readonly type: "verify.result";
      /** The backend that gave the result. */
      readonly backend: BackendName;
      /** The result's status. */
      readonly status: "verified" | "already-verified";
      /** The result's match. */
      readonly match: "exact" | "partial";
    }
  | {
      readonly type: "verify.result";
      /** The backend that gave the result. */
      readonly backend: BackendName;
      /** The result's status. A failed result has no match. */
      readonly status: "failed";
    };

/**
 * Overrides the route for one call: which backend to use and where its API lives, for example a
 * self-hosted Sourcify server or a local fake in tests. Hosts come only from here or from the
 * routing table, never from a {@link Handle} (R-SEC-2).
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
   * naming the chain and the backend. With `apiUrl`, any backend goes. A name outside
   * `BACKEND_NAMES`, or a backend this version has no client for, throws `invalid-input` naming
   * `route.backend`.
   */
  backend?: BackendName;
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
  apiUrl?: string;
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
  apiKey?: string;
}

/**
 * Options for `verify()` and `checkStatus()`. Every field is optional. A later release adds fields
 * without changing these, so existing callers keep working (decision 0009).
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
export interface VerifyOptions {
  /**
   * The `fetch` every request goes through. Defaults to `globalThis.fetch` (R-SRV-5). The library
   * sends every request with `redirect: "manual"` and never follows a redirect: a redirect could
   * carry a key to another host. An injected `fetch` must keep that behaviour and must not follow
   * redirects itself.
   */
  fetch?: typeof fetch;
  /** Cancels the call. The call rejects with `signal.reason` unchanged (R-FLOW-6). */
  signal?: AbortSignal;
  /**
   * Time budget for the whole call, polling included, in milliseconds. Defaults to 120000. A
   * positive number; a value above 2147483647 is lowered to it.
   */
  timeoutMs?: number;
  /**
   * Wait between two status polls, in milliseconds. Defaults to 3000. A positive number; a value
   * below 1000 is raised to 1000, and one above 2147483647 is lowered to it.
   */
  pollIntervalMs?: number;
  /** Receives log lines with keys removed. Nothing is logged when it is absent (R-DX-5). */
  logger?: Logger;
  /**
   * Receives the stage events, with keys removed (R-DX-6). Nothing is emitted when it is absent.
   * An exception it throws, or a rejection of a promise it returns, is logged once at `warn` and
   * does not change the outcome. A returned promise is not awaited.
   */
  onEvent?: (event: VerifyEvent) => void | Promise<void>;
  /** Overrides the routing table for this call. */
  route?: RouteOverride;
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
  allowSourcifyFallback?: boolean;
  /**
   * API keys by backend name (decision 0009, amended by 0016). A key is sent only to its backend's
   * API host in the routing table, `api.etherscan.io` for `etherscan-v2` and `api.routescan.io`
   * for `routescan`, and only when the call's route resolves to that backend (R-SEC-2). A route
   * that moves `apiUrl` to another host gets no key from here; pass `route.apiKey` for it.
   *
   * - Accepted names: `etherscan-v2` and `routescan`. `etherscan-compatible` throws
   *   `invalid-input`: each standalone explorer has its own host, so its key goes in
   *   `route.apiKey`. `sourcify` and `blockscout` take no key in this release and throw too.
   * - Each value is a primitive string of 8 to 1024 characters, each a letter, a digit, `.`, `_`,
   *   `~` or `-`, and not all digits. A bad value throws `invalid-input` naming
   *   `apiKeys.<backend>`, never the value. So does a key found in the contract address or the
   *   handle's `ev1:<backend>:<chainId>:<address>` part, which redaction would corrupt. An
   *   `undefined` value counts as absent.
   * - Only own enumerable string-keyed properties are read, each once; a non-enumerable property
   *   or a Symbol key is ignored. The object must be a plain object.
   * - Every key is removed from logs, events, errors and results (R-SEC-1).
   * - When the route's backend needs a key (`etherscan-v2`) and none is bound to its host, the
   *   call throws `missing-api-key` before any request, unless `fetch` is set: an injected `fetch`
   *   may lead to a server that adds the key, so the request goes out without one.
   *
   * Etherscan's terms forbid an Etherscan key in browser code. In a browser, inject a `fetch` that
   * targets a server that holds the key instead (R-SRV-5).
   *
   * @example
   * ```ts
   * import type { VerifyOptions } from "explorer-verify";
   *
   * declare const etherscanKey: string; // read on a server, never shipped to a browser
   * const options: VerifyOptions = { apiKeys: { "etherscan-v2": etherscanKey } };
   * ```
   */
  apiKeys?: Partial<Record<BackendName, string | undefined>>;
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
