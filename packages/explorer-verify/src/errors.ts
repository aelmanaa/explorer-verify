/**
 * The one error class the library throws, and the codes it carries (decision 0009). Each code has
 * a fix hint, an entry in docs/user/reference/errors.md and a CLI exit code (R-DX-3, R-AX-7,
 * R-AX-10). The constructor redacts API keys from everything the error holds (R-SEC-1).
 */
import type { BackendName } from "./backend-names.ts";
import { formatHandle } from "./flow/format-handle.ts";
import { redact } from "./redact.ts";
import type { Handle } from "./types.ts";

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
 *   return error.details.code === "invalid-input" ? error.details.issues : [];
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
 * The data that comes with each error code. Checking `details.code` narrows `details` to that
 * code's member, with no cast.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 *
 * try {
 *   await verify(input);
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
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
      /** How long the backend asked to wait, when it said (`Retry-After`). */
      retryAfterMs?: number;
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
    };

/**
 * The exit codes of the CLI (R-AX-7): 0 verified, 1 failed, 2 invalid input, 3 key problem,
 * 4 still pending, 5 network or explorer unavailable, 6 unknown state, 130 cancelled.
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
  "in-progress": 4,
  "unknown-state": 6,
  "job-not-found": 5,
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
  /** The code's entry in the error reference. */
  docsUrl: string;
  /**
   * Whether trying again may succeed without changing the input. For `not-confirmed`, trying
   * again means `checkStatus(details.handle)`, not a new `verify()`.
   */
  retryable: boolean;
  /** The handle in its one-line form, when the error carries one. */
  handle?: string;
}

/**
 * Options for {@link ExplorerVerifyError}.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { ExplorerVerifyErrorOptions } from "explorer-verify";
 *
 * const options: ExplorerVerifyErrorOptions = {
 *   hint: "Only sourcify is available in this version.",
 *   cause: new Error("unsupported backend"),
 *   secrets: [apiKey],
 * };
 * new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "The route is invalid.", options);
 * ```
 * @experimental
 */
export interface ExplorerVerifyErrorOptions {
  /** Replaces the code's default hint when the fix is more specific. */
  hint?: string;
  /**
   * The underlying error, kept for debugging as a redacted copy: its name, message, stack and own
   * cause, up to four levels deep. A string is redacted; an object that is not an `Error` is
   * replaced by `[cause omitted]`. `toJSON()` leaves it out.
   */
  cause?: unknown;
  /** Key values to remove from the message, hint, details and cause, such as this call's API key. */
  secrets?: readonly string[];
}

const ERRORS_PAGE =
  "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md";

// The longest excerpt of an explorer's answer that an error keeps.
const EXCERPT_LENGTH = 300;
// How many levels of `cause` an error keeps, its own cause included.
const CAUSE_DEPTH = 4;
const UNREADABLE_CAUSE = "[unreadable cause]";
const OMITTED_CAUSE = "[cause omitted]";

const CATALOGUE: Record<ErrorCode, { hint: string; retryable: boolean }> = {
  "invalid-input": {
    hint: "Fix the fields listed in details.issues, then call again.",
    retryable: false,
  },
  "not-confirmed": {
    hint: "Call checkStatus with details.handle later to continue polling.",
    retryable: true,
  },
  "unsupported-chain": {
    hint: "Check the chain ID, or pick a backend that serves this chain with the route option.",
    retryable: false,
  },
  network: {
    hint: "Check the network connection and the explorer's status page, then call again.",
    retryable: true,
  },
  "rate-limited": {
    hint: "Wait details.retryAfterMs, or a few seconds when it is not set, then call again.",
    retryable: true,
  },
  timeout: {
    hint: "Call again, or raise timeoutMs. The explorer had not accepted the submission yet.",
    retryable: true,
  },
  "unexpected-response": {
    hint: "Check the explorer's status page. If the error persists, report details.status and details.excerpt.",
    retryable: false,
  },
  "in-progress": {
    hint: "Wait for the explorer to finish its current verification of this contract, then check the contract again.",
    retryable: true,
  },
  "unknown-state": {
    hint: "Do not retry automatically. Check the contract on the explorer and report details.excerpt.",
    retryable: false,
  },
  "job-not-found": {
    hint: "Call verify() again to submit the contract again.",
    retryable: false,
  },
};

/** A copy of `details` with every string redacted and every excerpt cut to 300 characters. */
function redactDetails(details: ErrorDetails, secrets: readonly string[]): ErrorDetails {
  // Every code is listed, so a new code fails the exhaustiveness lint until it is added here.
  let copy: ErrorDetails;
  switch (details.code) {
    case "invalid-input":
      copy = {
        code: details.code,
        issues: details.issues.map((issue) => ({
          field: redact(issue.field, secrets),
          message: redact(issue.message, secrets),
        })),
      };
      break;
    case "not-confirmed":
    case "job-not-found":
      copy = { ...details, handle: redactHandle(details.handle, secrets) };
      break;
    case "unknown-state":
      copy = {
        ...details,
        handle: redactHandle(details.handle, secrets),
        excerpt: excerpt(details.excerpt, secrets),
      };
      break;
    case "unexpected-response":
      copy = { ...details, excerpt: excerpt(details.excerpt, secrets) };
      break;
    case "unsupported-chain":
    case "network":
    case "rate-limited":
    case "timeout":
    case "in-progress":
      copy = { ...details };
      break;
  }
  return copy;
}

function redactHandle(handle: Handle, secrets: readonly string[]): Handle {
  return { ...handle, jobId: redact(handle.jobId, secrets) };
}

// Redacts before cutting, so a cut never leaves part of a known key behind.
function excerpt(text: string, secrets: readonly string[]): string {
  return redact(text, secrets).slice(0, EXCERPT_LENGTH);
}

/**
 * A copy of `cause` that is safe to print. An `Error` becomes a new `Error` with the redacted
 * name, message and stack, and its own cause copied the same way. A string is redacted.
 * `undefined`, `null`, numbers and booleans stay as they are. Any other value, which could print
 * a key through its own fields or `toString`, becomes `[cause omitted]`. A cause that throws when
 * read becomes `[unreadable cause]`.
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
    const copy = new Error(redact(cause.message, secrets));
    copy.name = redact(cause.name, secrets);
    if (typeof cause.stack === "string") {
      copy.stack = redact(cause.stack, secrets);
    }
    if ("cause" in cause && depth < CAUSE_DEPTH) {
      copy.cause = redactCause(cause.cause, secrets, depth + 1);
    }
    return copy;
  } catch {
    return UNREADABLE_CAUSE;
  }
}

/**
 * The error every library function throws, except on abort, where the call rejects with
 * `signal.reason` unchanged. Narrow on `details.code`; `code` holds the same value.
 *
 * The constructor removes API keys from the message, the hint, every string in `details` and the
 * cause, so nothing the error holds can print a key (R-SEC-1). `JSON.stringify(error)` calls
 * {@link ExplorerVerifyError.toJSON}, which also leaves out `cause`, the stack and `details`.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 *
 * try {
 *   await verify(input);
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError) {
 *     console.error(JSON.stringify(error));
 *     if (error.retryable) {
 *       // try again later
 *     }
 *   }
 *   throw error;
 * }
 * ```
 * @experimental
 */
export class ExplorerVerifyError extends Error {
  /** The stable error code, equal to `details.code`. */
  readonly code: ErrorCode;
  /** One sentence: what to do next (R-DX-3). */
  readonly hint: string;
  /**
   * Whether trying again may succeed without changing the input. For `not-confirmed`, trying
   * again means `checkStatus(details.handle)`, not a new `verify()`, which would submit again.
   */
  readonly retryable: boolean;
  /** The code's data, redacted. Check `details.code` to narrow it. */
  readonly details: ErrorDetails;
  /** The code's entry in the error reference (R-AX-10). */
  readonly docsUrl: string;

  /**
   * Library code creates these; callers catch them. Every string passes through the key
   * redaction here, the one place all errors are built.
   *
   * @param details - The code and its data.
   * @param message - What went wrong.
   * @param options - A specific hint, the underlying cause and the key values to redact.
   * @example
   * ```ts
   * throw new ExplorerVerifyError(
   *   { code: "invalid-input", issues: [{ field: "chainId", message: "must be a positive integer" }] },
   *   "The input is invalid: chainId.",
   * );
   * ```
   */
  constructor(details: ErrorDetails, message: string, options: ExplorerVerifyErrorOptions = {}) {
    // The message is redacted before `super`, which builds the stack from it.
    super(
      redact(message, options.secrets),
      "cause" in options
        ? { cause: redactCause(options.cause, options.secrets ?? [], 1) }
        : undefined,
    );
    const secrets = options.secrets ?? [];
    const entry = CATALOGUE[details.code];
    this.code = details.code;
    this.hint = redact(options.hint ?? entry.hint, secrets);
    this.retryable = entry.retryable;
    this.details = redactDetails(details, secrets);
    this.docsUrl = `${ERRORS_PAGE}#${details.code}`;
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
    const json: ErrorJson = {
      code: this.code,
      message: this.message,
      hint: this.hint,
      docsUrl: this.docsUrl,
      retryable: this.retryable,
    };
    if ("handle" in this.details) {
      json.handle = formatHandle(this.details.handle);
    }
    return json;
  }
}
