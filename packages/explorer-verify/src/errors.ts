/**
 * The one error class the library throws, and the codes it carries (decision 0009). Each code has
 * a fix hint, its own page in docs/user/reference/errors/ and a CLI exit code (R-DX-3, R-AX-7,
 * R-AX-10). The constructor redacts API keys from everything the error holds (R-SEC-1).
 */
import { toBackendName } from "./backend-names.ts";
import type { BackendName } from "./backend-names.ts";
import { formatHandle } from "./flow/format-handle.ts";
import { addressDigits, readFields } from "./internal/read-fields.ts";
import { redact, redactExcerpt, redactJobId } from "./redact.ts";
import type { Handle, Hex } from "./types.ts";

/**
 * Every error code the library throws. A code never changes meaning once released; new codes are
 * added to the end.
 *
 * @example
 * ```ts
 * import { ERROR_CODES } from "explorer-verify";
 *
 * for (const code of ERROR_CODES) {
 *   console.log(code); // "invalid-input", "not-confirmed", "unsupported-chain", ...
 * }
 * ```
 * @experimental
 */
export const ERROR_CODES = [
  "invalid-input",
  "not-confirmed",
  "unsupported-chain",
  "network",
  "rate-limited",
  "timeout",
  "unexpected-response",
  "in-progress",
  "unknown-state",
  "job-not-found",
  "cancelled",
  "incomplete-input",
  "insufficient-artifact",
  "unsupported-compiler",
  "verification-inconclusive",
  "source-mismatch",
  "missing-api-key",
  "api-key-rejected",
  "quota-exceeded",
  "internal-error",
  "no-metadata-hash",
  "metadata-unavailable",
  "constructor-args-unavailable",
  "proxy-link-pending",
  "proxy-link-unknown-state",
  "handler-refused",
] as const;

/**
 * One of {@link ERROR_CODES}.
 *
 * @example
 * ```ts
 * import type { ErrorCode } from "explorer-verify";
 *
 * function isInputError(code: ErrorCode): boolean {
 *   return code === "invalid-input" || code === "unsupported-chain";
 * }
 * ```
 * @experimental
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * One problem found in the caller's input.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { InputIssue } from "explorer-verify";
 *
 * function report(error: ExplorerVerifyError): InputIssue[] {
 *   return error.code === "invalid-input" ? error.details.issues : [];
 * }
 * ```
 * @experimental
 */
export interface InputIssue {
  /** The field, as a dotted path from the value that was checked (`chainId`, `route.apiUrl`). */
  field: string;
  /** What is wrong with it. Never repeats the value, which may hold a secret. */
  message: string;
}

/**
 * One source `buildVerifyInputFromBytecode` tried, and what happened.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { MetadataAttempt } from "explorer-verify";
 *
 * function tried(error: ExplorerVerifyError): MetadataAttempt[] {
 *   return error.code === "metadata-unavailable" ? error.details.attempts : [];
 * }
 * ```
 * @experimental
 */
export interface MetadataAttempt {
  /**
   * Where the resolver asked: `rpc` for the bytecode at the JSON-RPC endpoint, `ipfs` for the
   * metadata at the IPFS gateway, `sourcify` for a verified copy on Sourcify.
   */
  source: "rpc" | "ipfs" | "sourcify";
  /**
   * `not-found`: the source answered that it does not hold it. `hash-mismatch`: it answered with
   * metadata whose hash differs from the bytecode's. `not-metadata`: the file has the right hash
   * but is not Solidity metadata a rebuild can use. `unavailable`: no usable answer, after
   * retries. `timeout`: the time budget ran out; the resolver stops there.
   */
  outcome: "not-found" | "hash-mismatch" | "not-metadata" | "unavailable" | "timeout";
  /** The HTTP status of the last answer, when there was one. */
  status?: number;
}

/**
 * The data that comes with each error code. Checking `error.code`, or `details.code`, narrows
 * `details` to that code's member, with no cast. A `backend` field always holds a name from
 * `BACKEND_NAMES`: a name outside it, which only code that bypasses the types can pass, becomes
 * `etherscan-compatible`, as in a handle.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 *
 * try {
 *   await verify(input);
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
 *     localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
 *   }
 * }
 * ```
 * @experimental
 */
export type ErrorDetails =
  | {
      /** The input failed validation, or a handle did not parse. */
      code: "invalid-input";
      /** Every problem found, in field order. */
      issues: InputIssue[];
    }
  | {
      /** The time budget ran out while the explorer was still verifying. */
      code: "not-confirmed";
      /** Pass it to `checkStatus()` to continue polling. */
      handle: Handle;
    }
  | {
      /** The backend does not serve this chain. */
      code: "unsupported-chain";
      /** The chain that was asked for. */
      chainId: number;
      /** The backend that refused it. */
      backend: BackendName;
    }
  | {
      /** Every request to the backend failed before it answered, retries included. */
      code: "network";
      /** The backend that could not be reached. */
      backend: BackendName;
      /** How many requests were tried. */
      attempts: number;
    }
  | {
      /** The backend answered 429 on every try. */
      code: "rate-limited";
      /** The backend that limited the requests. */
      backend: BackendName;
      /**
       * How long the backend asked to wait, when it said: `Retry-After`, or Routescan's
       * `x-ratelimit-rpm-retry-after`.
       */
      retryAfterMs?: number;
      /** How many requests were tried, when the HTTP layer gave up after retries. */
      attempts?: number;
    }
  | {
      /** The time budget ran out before the explorer accepted the submission: there is no handle. */
      code: "timeout";
      /** The backend that did not answer in time. */
      backend: BackendName;
      /** The budget that ran out, in milliseconds. */
      timeoutMs: number;
    }
  | {
      /** The backend answered with a status or a body the library does not recognise. */
      code: "unexpected-response";
      /** The backend that answered. */
      backend: BackendName;
      /** The HTTP status. */
      status: number;
      /** The start of the response body, redacted, at most 300 characters. */
      excerpt: string;
      /** How long the backend asked to wait, when it sent `Retry-After` with its last answer. */
      retryAfterMs?: number;
      /** How many requests were tried, when the HTTP layer gave up after retries. */
      attempts?: number;
    }
  | {
      /** The backend is already verifying this contract from another submission. */
      code: "in-progress";
      /** The backend that is busy with the contract. */
      backend: BackendName;
    }
  | {
      /** The explorer reported a final state the library cannot classify. */
      code: "unknown-state";
      /** The verification the state belongs to. */
      handle: Handle;
      /** The start of the explorer's answer, redacted, at most 300 characters. */
      excerpt: string;
    }
  | {
      /** The explorer no longer knows the job id in the handle. */
      code: "job-not-found";
      /** The handle whose job id the explorer does not know. */
      handle: Handle;
    }
  | {
      /**
       * The run was cancelled. The core never throws this code: an abort rejects with
       * `signal.reason`. The CLI creates it for exit code 130, so its JSON output has a typed error.
       */
      code: "cancelled";
      /** Present when the explorer accepted the submission before the cancel. */
      handle?: Handle;
      /**
       * A run on several backends: the handle of each backend that accepted a submission and had
       * not ended before the cancel, in the order of the run's backends.
       */
      handles?: readonly Handle[];
    }
  | {
      /**
       * The documents passed to `buildVerifyInput` lack something the verification needs: the
       * compiler input, the full compiler version, the choice of contract, or source files that
       * the Solidity metadata lists.
       */
      code: "incomplete-input";
      /** What is missing. */
      field: "input" | "compilerVersion" | "contract" | "sources";
      /**
       * For `contract`: the fully qualified names found in the documents, sorted, at most 20.
       * For `sources`: the source paths the metadata lists that have no content, sorted, at most
       * 1000; the message gives the full count.
       * Empty for the other fields.
       */
      candidates: string[];
    }
  | {
      /**
       * The documents hold only ABI and bytecode: no compiler input, settings or metadata, so the
       * input cannot be built from them.
       */
      code: "insufficient-artifact";
      /** The part that cannot be built. */
      field: "input";
    }
  | {
      /** The documents come from a compiler other than solc, or a language other than Solidity. */
      code: "unsupported-compiler";
      /**
       * The field that names the compiler: `compilerType`, `language`, or the zksolc field that
       * marked an EraVM build, such as `input.zksolc_version`.
       */
      field: string;
    }
  | {
      /**
       * The explorer finished the verification job without a verdict, for example with an internal
       * error or before its node saw the contract. Polling that job again gives the same answer.
       */
      code: "verification-inconclusive";
      /** The backend whose job ended without a verdict. */
      backend: BackendName;
      /** The explorer's code and message, redacted, at most 300 characters. */
      reason: string;
    }
  | {
      /**
       * A source file passed to `buildVerifyInput` does not match the keccak-256 hash that the
       * Solidity metadata records for it, so the rebuilt input would not reproduce the bytecode.
       */
      code: "source-mismatch";
      /** The source path, as the metadata lists it. */
      path: string;
      /** The hash the metadata records, `0x` and 64 lowercase hex digits. */
      expected: Hex;
      /** The keccak-256 hash of the content passed, `0x` and 64 lowercase hex digits. */
      actual: Hex;
    }
  | {
      /**
       * The route's backend needs an API key and none is bound to its host, or the explorer
       * answered that the key is missing.
       */
      code: "missing-api-key";
      /** The backend that needs the key. */
      backend: BackendName;
    }
  | {
      /** The explorer refused the API key, as Etherscan's `Invalid API Key (#err2)`. */
      code: "api-key-rejected";
      /** The backend that refused the key. */
      backend: BackendName;
    }
  | {
      /** The API key's daily limit is spent, so another request in this call cannot succeed. */
      code: "quota-exceeded";
      /** The backend whose limit is spent. */
      backend: BackendName;
    }
  | {
      /**
       * An unexpected exception reached the CLI's top level: a bug in explorer-verify. The library
       * never throws this code. The CLI creates it, so its JSON output has a typed error.
       */
      code: "internal-error";
    }
  | {
      /**
       * The deployed bytecode holds no metadata hash, so `buildVerifyInputFromBytecode` cannot find
       * the metadata.
       */
      code: "no-metadata-hash";
      /**
       * What the end of the bytecode holds: `no-code` (nothing is deployed at the address),
       * `no-metadata` (no CBOR block, as with `appendCBOR: false`) or `version-only` (only the
       * compiler version, as with `bytecodeHash: "none"`).
       */
      found: "no-code" | "no-metadata" | "version-only";
    }
  | {
      /**
       * `buildVerifyInputFromBytecode` could not read the bytecode from the JSON-RPC endpoint, or no
       * source it tried returned the metadata the bytecode's hash names.
       */
      code: "metadata-unavailable";
      /**
       * The hash from the bytecode: `ipfs:` and the CID, or `bzzr0:` or `bzzr1:` and 64 hex
       * digits. Empty when the bytecode could not be read.
       */
      hash: string;
      /** Each source tried, in order. */
      attempts: MetadataAttempt[];
    }
  | {
      /**
       * The creation code shows that `creationBytecode` is not the deployed build (R-IN-3), on a
       * backend that would refuse another build, so `verify()` sent nothing to the explorer
       * (decision 0032).
       */
      code: "constructor-args-unavailable";
      /**
       * `prefix-mismatch`: the creation code does not start with `creationBytecode`.
       * `bad-length`: what follows `creationBytecode` is not a whole number of 32-byte words.
       */
      reason: "prefix-mismatch" | "bad-length";
    }
  | {
      /**
       * `linkProxy()` asked the explorer to link a proxy, and the link was still pending when the
       * time budget ran out, or the status requests kept failing (R-FLOW-8). There is no handle:
       * calling `linkProxy()` again starts a new link, which is safe.
       */
      code: "proxy-link-pending";
      /** The backend that is linking the proxy. */
      backend: BackendName;
    }
  | {
      /**
       * `linkProxy()` got an answer about a proxy link that the library cannot classify, such as
       * Etherscan's `Error!` or an implementation that is not one address (R-FLOW-4, R-FLOW-8). The
       * proxy is not reported as linked. There is no handle: a link has none.
       */
      code: "proxy-link-unknown-state";
      /** The backend that answered. */
      backend: BackendName;
      /** The start of the explorer's answer, redacted, at most 300 characters. */
      excerpt: string;
    }
  | {
      /**
       * The caller's server handler, `createVerifyHandler`, refused the request with a code that
       * holds until its options or the request change, such as `chain-not-allowed`. The request
       * did not reach the explorer (decision 0048).
       */
      code: "handler-refused";
      /** The backend whose requests go through the handler. */
      backend: BackendName;
      /** The HTTP status of the refusal, such as 403. */
      status: number;
      /**
       * The handler's refusal code: `chain-not-allowed`, `address-not-allowed`,
       * `action-not-allowed`, `forbidden-field`, `body-too-large`, `bad-request`,
       * `method-not-allowed` or `unsupported-media-type`. Empty when the value is not of that
       * shape.
       */
      handlerCode: string;
      /** The start of the handler's answer, redacted, at most 300 characters. */
      excerpt: string;
    };

/**
 * Each code's member of {@link ErrorDetails}, keyed by code. `DetailsByCode["rate-limited"]` is the
 * same type as `DetailsOf<"rate-limited">`.
 *
 * @example
 * ```ts
 * import type { DetailsByCode } from "explorer-verify";
 *
 * const handlers: { [C in keyof DetailsByCode]?: (details: DetailsByCode[C]) => string } = {
 *   "rate-limited": (details) => `wait ${String(details.retryAfterMs ?? 5_000)} ms`,
 *   "not-confirmed": (details) => `resume ${details.handle.jobId}`,
 * };
 * ```
 * @experimental
 */
export type DetailsByCode = {
  [C in ErrorCode]: Extract<
    ErrorDetails,
    {
      /** The member's code. */
      code: C;
    }
  >;
};

/**
 * The `details` of an error with code `C`: its member of {@link ErrorDetails}.
 *
 * @template C - One error code, or a union of codes.
 * @example
 * ```ts
 * import type { DetailsOf } from "explorer-verify";
 *
 * function wait(details: DetailsOf<"rate-limited">): number {
 *   return details.retryAfterMs ?? 5_000;
 * }
 * ```
 * @experimental
 */
export type DetailsOf<C extends ErrorCode> = DetailsByCode[C];

/**
 * One `ExplorerVerifyError<K>` for each code `K` in `C`, as a union. `ExplorerVerifyError.is` and
 * `instanceof` narrow a caught value to this type, so a check of `error.code`, in an `if` or a
 * `switch`, also narrows `error.details`.
 *
 * @template C - The codes. Defaults to every code.
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { AnyExplorerVerifyError } from "explorer-verify";
 *
 * function waitMs(error: AnyExplorerVerifyError): number | undefined {
 *   return error.code === "rate-limited" ? error.details.retryAfterMs : undefined;
 * }
 *
 * function onError(error: unknown): void {
 *   if (error instanceof ExplorerVerifyError) {
 *     console.error(waitMs(error));
 *   }
 * }
 * ```
 * @experimental
 */
export type AnyExplorerVerifyError<C extends ErrorCode = ErrorCode> = C extends ErrorCode
  ? ExplorerVerifyError<C>
  : never;

/**
 * The exit codes of the CLI (R-AX-7): 0 verified, 1 failed, 2 invalid input, 3 key problem,
 * 4 still pending, 5 network or explorer unavailable, 6 unknown state or internal error,
 * 130 cancelled.
 *
 * @example
 * ```ts
 * import type { ExitCode } from "explorer-verify";
 *
 * const cancelled: ExitCode = 130;
 * ```
 * @experimental
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 130;

/**
 * The CLI exit code for each error code (R-AX-7). Every code maps to exactly one exit code.
 *
 * @example
 * ```ts
 * import { ERROR_EXIT_CODES, ExplorerVerifyError } from "explorer-verify";
 *
 * function exitCode(error: unknown): number {
 *   return error instanceof ExplorerVerifyError ? ERROR_EXIT_CODES[error.code] : 1;
 * }
 * ```
 * @experimental
 */
export const ERROR_EXIT_CODES: Readonly<Record<ErrorCode, ExitCode>> = {
  "invalid-input": 2,
  "not-confirmed": 4,
  "unsupported-chain": 2,
  network: 5,
  "rate-limited": 5,
  timeout: 5,
  "unexpected-response": 5,
  "in-progress": 5,
  "unknown-state": 6,
  "job-not-found": 6,
  cancelled: 130,
  "incomplete-input": 2,
  "insufficient-artifact": 2,
  "unsupported-compiler": 2,
  "verification-inconclusive": 4,
  "source-mismatch": 2,
  "missing-api-key": 3,
  "api-key-rejected": 3,
  "quota-exceeded": 3,
  "internal-error": 6,
  "no-metadata-hash": 2,
  "metadata-unavailable": 5,
  "constructor-args-unavailable": 2,
  "proxy-link-pending": 4,
  "proxy-link-unknown-state": 6,
  "handler-refused": 2,
};

/**
 * What `ExplorerVerifyError.toJSON()` returns: the `error` object of the CLI's JSON output, field
 * for field (R-AX-5). It never holds a `cause`, a stack or an API key.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { ErrorJson } from "explorer-verify";
 *
 * function envelope(error: ExplorerVerifyError): { schemaVersion: 1; ok: false; error: ErrorJson } {
 *   return { schemaVersion: 1, ok: false, error: error.toJSON() };
 * }
 * ```
 * @experimental
 */
export interface ErrorJson {
  /** The stable error code. */
  code: ErrorCode;
  /** What went wrong. */
  message: string;
  /** What to do next. */
  hint: string;
  /** The code's own page in the error reference. */
  docsUrl: string;
  /**
   * Whether trying again may succeed without changing the input. For `not-confirmed`, trying
   * again means `checkStatus(details.handle)`, not a new `verify()`. For
   * `verification-inconclusive`, it means a new `verify()`, which looks the contract up first.
   */
  retryable: boolean;
  /** The handle in its one-line form, when the error carries one. */
  handle?: string;
  /**
   * `cancelled` only: each backend of a run on several backends that accepted a submission and had
   * not ended when the run was cancelled, with its handle in the one-line form. Resume each one.
   */
  handles?: {
    /** The backend that accepted the submission. */
    backend: BackendName;
    /** Its handle in the one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`. */
    handle: string;
  }[];
}

/**
 * Options for {@link ExplorerVerifyError}. `secrets` is required, so code that builds an error
 * cannot forget the key list; pass `[]` when the call has no key.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { ExplorerVerifyErrorOptions } from "explorer-verify";
 *
 * const apiKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";
 * const options: ExplorerVerifyErrorOptions = {
 *   hint: "Leave out route.backend, or name one of: sourcify.",
 *   cause: new Error("unsupported backend"),
 *   secrets: [apiKey],
 * };
 * new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "The route is invalid.", options);
 * ```
 * @experimental
 */
export interface ExplorerVerifyErrorOptions {
  /**
   * Replaces the code's default hint when the fix is more specific. An empty or blank hint keeps
   * the default.
   */
  hint?: string;
  /**
   * Replaces the code's default `retryable` for this error, such as `false` for a refusal of the
   * caller's server handler that only its configuration can lift.
   */
  retryable?: boolean;
  /**
   * The underlying error, kept for debugging as a redacted copy: a plain `Error` with the
   * original name, message and stack, the primitive `code`, `errno` and `syscall`, a one-line
   * summary of an `AggregateError`'s errors, and its own cause, up to four levels deep. A string
   * is redacted; an object that is not an `Error` is replaced by `[cause omitted]`. `toJSON()`
   * leaves it out.
   */
  cause?: unknown;
  /**
   * Key values to remove from the message, hint, details and cause, such as this call's API key.
   * Pass `[]` when there is none.
   */
  secrets: readonly string[];
}

/**
 * The `docsUrl` of a code: its own page on the docs site, unversioned before 1.0 (decision 0015).
 * The site build test checks that each URL maps to a page in the build output, and the deploy
 * checks that each one returns 200.
 */
function docsUrlOf(code: ErrorCode): string {
  return `https://aelmanaa.github.io/explorer-verify/reference/errors/${code}`;
}

// The longest excerpt of an explorer's answer that an error keeps.
const EXCERPT_LENGTH = 300;
// How many levels of `cause` an error keeps, its own cause included.
const CAUSE_DEPTH = 4;
// How many errors of an AggregateError the cause summary names.
const AGGREGATE_ERRORS = 5;
const UNREADABLE_CAUSE = "[unreadable cause]";
const OMITTED_CAUSE = "[cause omitted]";
// A backend name outside BACKEND_NAMES, which only code that bypasses the types can pass, becomes
// this name, so `details.backend` and a handle's backend stay within `BackendName`.
const UNKNOWN_BACKEND: BackendName = "etherscan-compatible";
// The shape of a refusal code of `createVerifyHandler`, such as `chain-not-allowed`.
const HANDLER_CODE = /^[a-z][a-z-]{0,39}$/;
// A source-mismatch hash: `0x` and 64 lowercase hex digits.
const HASH = /^0x[0-9a-f]{64}$/;

/**
 * The codes for which trying again may succeed without changing the input. A list, not a record of
 * every code, so the bundle does not repeat every code name once more.
 */
const RETRYABLE: readonly ErrorCode[] = [
  "not-confirmed",
  "network",
  "rate-limited",
  "timeout",
  "unexpected-response",
  "in-progress",
  "verification-inconclusive",
  "metadata-unavailable",
  "proxy-link-pending",
];

/** Builds the redacted copy of one code's details. */
type Redactor<C extends ErrorCode> = (
  details: DetailsOf<C>,
  secrets: readonly string[],
) => DetailsOf<C>;

/**
 * For each code, a function that builds a new `details` field by field from the fields its code
 * declares, so an extra field never reaches the error. Every string is redacted and every excerpt
 * cut to 300 characters. The mapped type lists every code, so a new code does not compile until it
 * has an entry here.
 */
const REDACTORS: { readonly [C in ErrorCode]: Redactor<C> } = {
  "invalid-input": (details, secrets) => ({
    code: "invalid-input",
    issues: details.issues.map((issue) => ({
      field: text(issue.field, secrets),
      message: text(issue.message, secrets),
    })),
  }),
  "not-confirmed": (details, secrets) => ({
    code: "not-confirmed",
    handle: redactHandle(details.handle, secrets),
  }),
  "job-not-found": (details, secrets) => ({
    code: "job-not-found",
    handle: redactHandle(details.handle, secrets),
  }),
  cancelled: (details, secrets) => {
    const copy: DetailsOf<"cancelled"> = { code: "cancelled" };
    if (details.handle !== undefined) {
      copy.handle = redactHandle(details.handle, secrets);
    }
    if (details.handles !== undefined) {
      copy.handles = details.handles.map((handle) => redactHandle(handle, secrets));
    }
    return copy;
  },
  "unknown-state": (details, secrets) => ({
    code: "unknown-state",
    handle: redactHandle(details.handle, secrets),
    excerpt: excerptOf(details.excerpt, secrets),
  }),
  "unexpected-response": (details, secrets) => {
    const copy: DetailsOf<"unexpected-response"> = {
      code: "unexpected-response",
      ...answerOf(details, secrets),
    };
    if (details.retryAfterMs !== undefined) {
      copy.retryAfterMs = numberOf(details.retryAfterMs);
    }
    if (details.attempts !== undefined) {
      copy.attempts = numberOf(details.attempts);
    }
    return copy;
  },
  "unsupported-chain": (details) => ({
    code: "unsupported-chain",
    chainId: numberOf(details.chainId),
    backend: backendOf(details.backend),
  }),
  network: (details) => ({
    code: "network",
    backend: backendOf(details.backend),
    attempts: numberOf(details.attempts),
  }),
  "rate-limited": (details) => {
    const copy: DetailsOf<"rate-limited"> = {
      code: "rate-limited",
      backend: backendOf(details.backend),
    };
    if (details.retryAfterMs !== undefined) {
      copy.retryAfterMs = numberOf(details.retryAfterMs);
    }
    if (details.attempts !== undefined) {
      copy.attempts = numberOf(details.attempts);
    }
    return copy;
  },
  timeout: (details) => ({
    code: "timeout",
    backend: backendOf(details.backend),
    timeoutMs: numberOf(details.timeoutMs),
  }),
  "in-progress": (details) => ({ code: "in-progress", backend: backendOf(details.backend) }),
  "incomplete-input": (details, secrets) => ({
    code: "incomplete-input",
    field: oneOf(details.field, ["input", "compilerVersion", "contract", "sources"]),
    candidates: Array.isArray(details.candidates)
      ? details.candidates.map((candidate) => text(candidate, secrets))
      : [],
  }),
  "insufficient-artifact": (details) => ({
    code: "insufficient-artifact",
    field: oneOf(details.field, ["input"]),
  }),
  "unsupported-compiler": (details, secrets) => ({
    code: "unsupported-compiler",
    field: text(details.field, secrets),
  }),
  "verification-inconclusive": (details, secrets) => ({
    code: "verification-inconclusive",
    backend: backendOf(details.backend),
    reason: excerptOf(details.reason, secrets),
  }),
  "source-mismatch": (details, secrets) => ({
    code: "source-mismatch",
    path: text(details.path, secrets),
    expected: hashOf(details.expected),
    actual: hashOf(details.actual),
  }),
  "missing-api-key": (details) => ({
    code: "missing-api-key",
    backend: backendOf(details.backend),
  }),
  "api-key-rejected": (details) => ({
    code: "api-key-rejected",
    backend: backendOf(details.backend),
  }),
  "quota-exceeded": (details) => ({ code: "quota-exceeded", backend: backendOf(details.backend) }),
  "internal-error": () => ({ code: "internal-error" }),
  "no-metadata-hash": (details) => ({
    code: "no-metadata-hash",
    found: oneOf(details.found, ["no-metadata", "no-code", "version-only"]),
  }),
  "metadata-unavailable": (details, secrets) => ({
    code: "metadata-unavailable",
    hash: text(details.hash, secrets),
    attempts: Array.isArray(details.attempts) ? details.attempts.map(copyAttempt) : [],
  }),
  "constructor-args-unavailable": (details) => ({
    code: "constructor-args-unavailable",
    reason: oneOf(details.reason, ["prefix-mismatch", "bad-length"]),
  }),
  "proxy-link-pending": (details) => ({
    code: "proxy-link-pending",
    backend: backendOf(details.backend),
  }),
  "proxy-link-unknown-state": (details, secrets) => ({
    code: "proxy-link-unknown-state",
    backend: backendOf(details.backend),
    excerpt: excerptOf(details.excerpt, secrets),
  }),
  "handler-refused": (details, secrets) => {
    const handlerCode = text(details.handlerCode, secrets);
    return {
      code: "handler-refused",
      ...answerOf(details, secrets),
      handlerCode: HANDLER_CODE.test(handlerCode) ? handlerCode : "",
    };
  },
};

/** The backend, status and excerpt of an answer, checked and redacted. */
function answerOf(
  details: { readonly backend: unknown; readonly status: unknown; readonly excerpt: unknown },
  secrets: readonly string[],
): { backend: BackendName; status: number; excerpt: string } {
  return {
    backend: backendOf(details.backend),
    status: numberOf(details.status),
    excerpt: excerptOf(details.excerpt, secrets),
  };
}

/** The redacted copy of `details`, built by its code's redactor. */
function redactDetails<C extends ErrorCode>(
  code: C,
  details: DetailsOf<C>,
  secrets: readonly string[],
): DetailsOf<C> {
  const redactor: Redactor<C> = REDACTORS[code];
  return redactor(details, secrets);
}

// The helpers below take `unknown`: the types say what callers pass, but an error must never throw
// or leak when code that bypasses the types passes something else.

/** `value` when it is one of `allowed`, else the first of `allowed`. */
function oneOf<T extends string>(value: unknown, allowed: readonly [T, ...T[]]): T {
  return allowed.find((each) => each === value) ?? allowed[0];
}

/** A new attempt with only its declared fields. Anything that is not an object becomes an empty attempt. */
function copyAttempt(attempt: unknown): MetadataAttempt {
  const fields = readFields(attempt);
  const copy: MetadataAttempt = {
    source: oneOf(fields?.get("source"), ["rpc", "ipfs", "sourcify"]),
    outcome: oneOf(fields?.get("outcome"), [
      "unavailable",
      "not-found",
      "hash-mismatch",
      "not-metadata",
      "timeout",
    ]),
  };
  const status = fields?.get("status");
  if (status !== undefined) {
    copy.status = numberOf(status);
  }
  return copy;
}

/** A known backend name, or `etherscan-compatible` for anything else. */
function backendOf(value: unknown): BackendName {
  return toBackendName(value) ?? UNKNOWN_BACKEND;
}

/**
 * A source-mismatch hash: `0x` and 64 lowercase hex digits, kept as it is; `0x` for anything else.
 * A hash is public, so it is not redacted, and the shape check keeps anything else out.
 */
function hashOf(value: unknown): Hex {
  const hash = stringOf(value);
  return HASH.test(hash) ? `0x${hash.slice(2)}` : "0x";
}

/** A redacted excerpt of an explorer's answer, at most 300 characters. */
function excerptOf(value: unknown, secrets: readonly string[]): string {
  return redactExcerpt(stringOf(value), secrets, EXCERPT_LENGTH);
}

/** A number, or `NaN` for anything else. */
function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

/** A string, or `""` for anything else. */
function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A string, redacted, or `""` for anything else. */
function text(value: unknown, secrets: readonly string[]): string {
  return redact(stringOf(value), secrets);
}

/**
 * A new handle built from its five fields, with the job id and address redacted. The job id skips
 * the bare-key shape rule, so a valid 34-character job id still resumes; it is still redacted when
 * it holds a known secret. An address of `0x` and 40 hex digits is kept as it is: it is public,
 * and a secret that happens to match part of it must not make the handle unusable.
 */
function redactHandle(handle: Handle, secrets: readonly string[]): Handle {
  const digits = addressDigits(handle.address);
  return {
    version: 1,
    backend: backendOf(handle.backend),
    chainId: numberOf(handle.chainId),
    address: `0x${digits ?? text(stringOf(handle.address).slice(2), secrets)}`,
    jobId: redactJobId(stringOf(handle.jobId), secrets),
  };
}

/** A cause copy: a plain `Error` with the redacted fields that help debugging. */
type CauseCopy = Error & {
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  errors?: string;
};

/** A string is redacted, a number kept, anything else dropped. */
function primitive(value: unknown, secrets: readonly string[]): string | number | undefined {
  if (typeof value === "string") {
    return redact(value, secrets);
  }
  return typeof value === "number" ? value : undefined;
}

// A stack frame line: V8's `    at fn (file:1:2)`, or `fn@file:1:2` in Firefox and Safari. The
// Firefox check is a line-end pattern plus `includes("@")`: a pattern such as `@.*:\d+:\d+$` takes
// time quadratic in the line length on a line full of `@`.
const V8_FRAME = /^\s+at /;
const LINE_AND_COLUMN = /:\d+:\d+$/;
// Longer lines are not frames.
const FRAME_LENGTH = 1_000;

function isFrame(line: string): boolean {
  return (
    line.length <= FRAME_LENGTH &&
    (V8_FRAME.test(line) || (LINE_AND_COLUMN.test(line) && line.includes("@")))
  );
}

/**
 * The copy's stack: its own redacted `name: message` header, then the frame lines of the original
 * stack, redacted. The original header is dropped: an engine may build it when the stack is first
 * read, from a name or message that is not a string and that the copy refused to read.
 */
function stackOf(copy: Error, stack: string, secrets: readonly string[]): string {
  const header = copy.message === "" ? copy.name : `${copy.name}: ${copy.message}`;
  const frames = stack.split("\n").filter((line) => isFrame(line));
  return [header, ...frames.map((line) => redact(line, secrets))].join("\n");
}

/** `Name: message` of one error in an AggregateError, read once each. */
function oneLine(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!(value instanceof Error)) {
    return typeof value;
  }
  const name: unknown = value.name;
  const message: unknown = value.message;
  return `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : ""}`;
}

/**
 * A copy of `cause` that is safe to print. An `Error` becomes a plain `Error` with the original
 * name, and with the message, stack, primitive `code`, `errno` and `syscall`, a one-line summary
 * of an `AggregateError`'s errors and its own cause, each read once and redacted. A string is
 * redacted. `undefined`, `null`, numbers and booleans stay as they are. Any other value, which
 * could print a key through its own fields or `toString`, becomes `[cause omitted]`. A cause that
 * throws when read becomes `[unreadable cause]`.
 */
function redactCause(cause: unknown, secrets: readonly string[], depth: number): unknown {
  if (
    cause === undefined ||
    cause === null ||
    typeof cause === "number" ||
    typeof cause === "boolean"
  ) {
    return cause;
  }
  if (typeof cause === "string") {
    return redact(cause, secrets);
  }
  try {
    if (!(cause instanceof Error)) {
      return OMITTED_CAUSE;
    }
    const name: unknown = cause.name;
    const message: unknown = cause.message;
    const stack: unknown = cause.stack;
    const copy: CauseCopy = new Error(typeof message === "string" ? redact(message, secrets) : "");
    copy.name = typeof name === "string" ? redact(name, secrets) : "Error";
    if (typeof stack === "string") {
      copy.stack = stackOf(copy, stack, secrets);
    }
    const code = primitive("code" in cause ? cause.code : undefined, secrets);
    if (code !== undefined) {
      copy.code = code;
    }
    const errno = primitive("errno" in cause ? cause.errno : undefined, secrets);
    if (errno !== undefined) {
      copy.errno = errno;
    }
    const syscall = "syscall" in cause ? cause.syscall : undefined;
    if (typeof syscall === "string") {
      copy.syscall = redact(syscall, secrets);
    }
    const errors = "errors" in cause ? cause.errors : undefined;
    if (Array.isArray(errors)) {
      const listed = errors.slice(0, AGGREGATE_ERRORS).map(oneLine).join("; ");
      copy.errors = redact(
        `${String(errors.length)} errors: ${listed}`.replace(/\s+/g, " "),
        secrets,
      );
    }
    if ("cause" in cause && depth < CAUSE_DEPTH) {
      const inner: unknown = cause.cause;
      copy.cause = redactCause(inner, secrets, depth + 1);
    }
    return copy;
  } catch {
    return UNREADABLE_CAUSE;
  }
}

// The brand that `ExplorerVerifyError.is` and `instanceof` check. `Symbol.for` returns the same
// symbol in every copy of the package, so an error from another copy passes too (decision 0044).
const BRAND: unique symbol = Symbol.for("explorer-verify.error");

/**
 * The error every library function throws, except on abort, where the call rejects with
 * `signal.reason` unchanged. Check `code` to narrow `details` to that code's data.
 *
 * `ExplorerVerifyError.is(error, code?)` and `instanceof` recognise an error built by any copy of
 * explorer-verify, for example when a build helper resolves another version than the CLI. Both
 * narrow `error` to {@link AnyExplorerVerifyError}, so a check of `error.code` narrows `details`.
 *
 * The constructor removes API keys from the message, the hint, every string in `details` and the
 * cause, so nothing the error holds can print a key (R-SEC-1). `JSON.stringify(error)` calls
 * {@link ExplorerVerifyError.toJSON}, which also leaves out `cause`, the stack and `details`.
 * `Object.keys(error)` lists `code`, `hint`, `retryable`, `details` and `docsUrl`. The brand is a
 * symbol key, so `structuredClone(error)` and `postMessage` drop it, and the copy is not recognised;
 * send `error.toJSON()` across instead.
 *
 * @template C - The error's code. Defaults to every code.
 * @example
 * ```ts
 * import { ExplorerVerifyError, verify } from "explorer-verify";
 *
 * try {
 *   await verify(input);
 * } catch (error) {
 *   if (ExplorerVerifyError.is(error, "not-confirmed")) {
 *     localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
 *   } else if (error instanceof ExplorerVerifyError) {
 *     switch (error.code) {
 *       case "rate-limited":
 *         console.error(`Wait ${String(error.details.retryAfterMs ?? 5_000)} ms.`);
 *         break;
 *       default:
 *         console.error(JSON.stringify(error));
 *     }
 *   }
 * }
 * ```
 * @experimental
 */
export class ExplorerVerifyError<C extends ErrorCode = ErrorCode> extends Error {
  /** The stable error code, equal to `details.code`. Check it to narrow `details`. */
  readonly code: C;
  /** One sentence: what to do next (R-DX-3). */
  readonly hint: string;
  /**
   * Whether trying again may succeed without changing the input. For `not-confirmed`, trying
   * again means `checkStatus(details.handle)`, not a new `verify()`, which would submit again. For
   * `verification-inconclusive`, it means a new `verify()`, which looks the contract up first.
   */
  readonly retryable: boolean;
  /** The code's data, redacted. */
  readonly details: DetailsOf<C>;
  /** The code's own page in the error reference (R-AX-10). */
  readonly docsUrl: string;

  /**
   * Library code creates these; callers catch them. Every string passes through the key
   * redaction here, the one place all errors are built. Without a `hint`, the error's hint points
   * to `docsUrl`; pass one from {@link ERROR_HINTS} for the code's default hint.
   *
   * @param details - The code and its data.
   * @param message - What went wrong.
   * @param options - The key values to redact, and optionally a hint and the cause.
   * @example
   * ```ts
   * import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
   *
   * throw new ExplorerVerifyError(
   *   { code: "invalid-input", issues: [{ field: "chainId", message: "must be a positive integer" }] },
   *   "The input is invalid: chainId.",
   *   { hint: ERROR_HINTS["invalid-input"], secrets: [] },
   * );
   * ```
   */
  constructor(
    details: DetailsOf<C> & { code: C },
    message: string,
    options: ExplorerVerifyErrorOptions,
  ) {
    // The message is redacted before `super`, which builds the stack from it.
    super(
      redact(message, options.secrets),
      "cause" in options ? { cause: redactCause(options.cause, options.secrets, 1) } : undefined,
    );
    const code: C = details.code;
    const docsUrl = docsUrlOf(code);
    const hint =
      options.hint !== undefined && options.hint.trim() !== ""
        ? options.hint
        : `Read ${docsUrl} for what to do next.`;
    this.code = code;
    this.hint = redact(hint, options.secrets);
    this.retryable = options.retryable ?? RETRYABLE.includes(code);
    this.details = redactDetails(code, details, options.secrets);
    this.docsUrl = docsUrl;
    // The brand is a symbol key that is not enumerable, so `Object.keys(error)`, a spread and
    // `JSON.stringify` leave it out.
    Object.defineProperty(this, BRAND, { value: true });
  }

  /**
   * Whether `value` is an `ExplorerVerifyError` from any copy of explorer-verify. It checks a
   * brand, not the class, so it does not depend on which copy of the package built the error, and
   * it never throws.
   *
   * @param value - Anything, usually a caught error.
   * @returns `true` when `value` is such an error; `value` then narrows to
   *   {@link AnyExplorerVerifyError}, so a check of `value.code` narrows `details`.
   * @example
   * ```ts
   * import { ExplorerVerifyError } from "explorer-verify";
   *
   * function describe(error: unknown): string {
   *   if (!ExplorerVerifyError.is(error)) {
   *     return "not ours";
   *   }
   *   return error.code === "not-confirmed" ? error.details.handle.jobId : error.code;
   * }
   * ```
   */
  static is(value: unknown): value is AnyExplorerVerifyError;
  /**
   * Whether `value` is an `ExplorerVerifyError` from any copy of explorer-verify with the code
   * `code`. It checks a brand, not the class, and it never throws.
   *
   * @param value - Anything, usually a caught error.
   * @param code - The code to check for.
   * @returns `true` when `value` is such an error with that code; `value` then narrows to
   *   {@link AnyExplorerVerifyError} of `code`.
   * @example
   * ```ts
   * import { ExplorerVerifyError, checkStatus } from "explorer-verify";
   * import type { Handle } from "explorer-verify";
   *
   * async function resume(handle: Handle): Promise<void> {
   *   try {
   *     await checkStatus(handle);
   *   } catch (error) {
   *     if (ExplorerVerifyError.is(error, "rate-limited")) {
   *       console.error(error.details.retryAfterMs);
   *     }
   *     throw error;
   *   }
   * }
   * ```
   */
  static is<K extends ErrorCode>(value: unknown, code: K): value is AnyExplorerVerifyError<K>;
  static is(value: unknown, code?: ErrorCode): boolean {
    try {
      // An own property only, so a brand set on Object.prototype does not brand every object.
      return (
        typeof value === "object" &&
        value !== null &&
        Object.getOwnPropertyDescriptor(value, BRAND)?.value === true &&
        (code === undefined || Reflect.get(value, "code") === code)
      );
    } catch {
      // A Proxy whose traps throw is not an error of this library.
      return false;
    }
  }

  /**
   * Makes `instanceof ExplorerVerifyError` check the same brand as
   * {@link ExplorerVerifyError.is}, so it also holds for an error from another copy of the package.
   * For a subclass, `instanceof` checks the prototype chain as usual.
   *
   * @param value - The left side of `instanceof`.
   * @returns Whether `value` is an `ExplorerVerifyError` from any copy of explorer-verify, or, for a
   *   subclass, an instance of that subclass.
   * @example
   * ```ts
   * import { ExplorerVerifyError } from "explorer-verify";
   *
   * function code(error: unknown): string {
   *   return error instanceof ExplorerVerifyError ? error.code : "not ours";
   * }
   * ```
   */
  static override [Symbol.hasInstance]<T>(
    this: abstract new (...args: never[]) => T,
    value: unknown,
  ): value is ExplorerVerifyError extends T ? AnyExplorerVerifyError : T;
  static override [Symbol.hasInstance](value: unknown): boolean {
    return this === ExplorerVerifyError
      ? ExplorerVerifyError.is(value)
      : Function.prototype[Symbol.hasInstance].call(this, value);
  }

  /**
   * Always `"ExplorerVerifyError"`. A getter, so it is not an own field of the instance.
   *
   * @returns The class name.
   * @example
   * ```ts
   * String(error); // "ExplorerVerifyError: The handle is invalid: chainId."
   * ```
   */
  override get name(): "ExplorerVerifyError" {
    return "ExplorerVerifyError";
  }

  /**
   * The error as plain data for logs and the CLI's JSON output (R-AX-5).
   *
   * @returns The code, message, hint, docs URL, retry flag and, when there is one, the handle.
   * @example
   * ```ts
   * console.error(JSON.stringify(error)); // calls toJSON()
   * ```
   */
  toJSON(): ErrorJson {
    const details: ErrorDetails = this.details;
    const json: ErrorJson = {
      code: this.code,
      message: this.message,
      hint: this.hint,
      docsUrl: this.docsUrl,
      retryable: this.retryable,
    };
    const handle = "handle" in details ? details.handle : undefined;
    if (handle !== undefined) {
      json.handle = formatHandle(handle);
    }
    if (details.code === "cancelled" && details.handles !== undefined) {
      json.handles = details.handles.map((each) => ({
        backend: each.backend,
        handle: formatHandle(each),
      }));
    }
    return json;
  }
}
