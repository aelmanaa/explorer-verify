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
}

/**
 * The outcome of a verification. `failed` means the explorer definitively rejected the
 * submission; any unknown or ambiguous state throws instead, so a caller never mistakes it for
 * success. `match` is `partial` when the explorer matched the code but not its metadata hash.
 *
 * @experimental
 */
export type VerifyResult =
  | { status: "verified"; backend: BackendName; match: "exact" | "partial"; explorerUrl: string }
  | {
      status: "already-verified";
      backend: BackendName;
      match: "exact" | "partial";
      explorerUrl: string;
    }
  | { status: "failed"; backend: BackendName; reason: string };

/**
 * Receives the library's log lines. Every line is a plain string with API keys already removed
 * (R-SEC-1). `console` fits this shape.
 *
 * @example
 * ```ts
 * import type { Logger } from "explorer-verify";
 *
 * const logger: Logger = {
 *   debug: () => {},
 *   info: (message) => console.info(message),
 *   warn: (message) => console.warn(message),
 *   error: (message) => console.error(message),
 * };
 * ```
 * @experimental
 */
export interface Logger {
  /** Request and polling detail. */
  debug: (message: string) => void;
  /** Progress a person may want to see. */
  info: (message: string) => void;
  /** A retry or a recovered problem. */
  warn: (message: string) => void;
  /** A failure, logged before the error is thrown. */
  error: (message: string) => void;
}

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
  /** The backend to use instead of the one the routing table names. */
  backend?: BackendName;
  /**
   * The API base URL. This release only declares the field; nothing reads it yet. The routing
   * change (issue #15) validates it: `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`,
   * no user name or password in the URL, and the query string redacted in logs.
   */
  apiUrl?: string;
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
  /** The `fetch` every request goes through. Defaults to `globalThis.fetch` (R-SRV-5). */
  fetch?: typeof fetch;
  /** Cancels the call. The call rejects with `signal.reason` unchanged (R-FLOW-6). */
  signal?: AbortSignal;
  /** Time budget for the whole call, polling included, in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
  /** Wait between two status polls, in milliseconds. Defaults to 3000. */
  pollIntervalMs?: number;
  /** Receives log lines with keys removed. Nothing is logged when it is absent. */
  logger?: Logger;
  /** Overrides the routing table for this call. */
  route?: RouteOverride;
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
 *   address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
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
  /** The contract address. */
  address: Hex;
  /** The backend's job id: Sourcify's `verificationId` or Etherscan's `guid`. */
  jobId: string;
}
