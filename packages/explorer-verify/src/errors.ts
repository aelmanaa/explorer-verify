/**
 * The one error class the library throws, and the codes it carries (decision 0009). Each code has
 * a fix hint and an entry in docs/user/reference/errors.md (R-DX-3, R-AX-10).
 */
import { formatHandle } from "./flow/format-handle.ts";
import type { Handle } from "./types.ts";

/**
 * Every error code the library throws. A code never changes meaning once released; new codes are
 * added to the end.
 *
 * @experimental
 */
export const ERROR_CODES = ["invalid-input", "not-confirmed"] as const;

/**
 * One of {@link ERROR_CODES}.
 *
 * @experimental
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * One problem found in the caller's input.
 *
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
    };

/**
 * What `ExplorerVerifyError.toJSON()` returns: the `error` object of the CLI's JSON output, field
 * for field (R-AX-5). It never holds a `cause`, a stack or an API key.
 *
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
  /** Whether the same call may succeed later without a change. */
  retryable: boolean;
  /** The handle in its one-line form, when the error carries one. */
  handle?: string;
}

/**
 * Options for {@link ExplorerVerifyError}.
 *
 * @experimental
 */
export interface ExplorerVerifyErrorOptions {
  /** Replaces the code's default hint when the fix is more specific. */
  hint?: string;
  /** The underlying error, kept for debugging. `toJSON()` leaves it out. */
  cause?: unknown;
}

const ERRORS_PAGE =
  "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md";

const CATALOGUE: Record<ErrorCode, { hint: string; retryable: boolean }> = {
  "invalid-input": {
    hint: "Fix the fields listed in details.issues, then call again.",
    retryable: false,
  },
  "not-confirmed": {
    hint: "Call checkStatus with details.handle later to continue polling.",
    retryable: true,
  },
};

/**
 * The error every library function throws, except on abort, where the call rejects with
 * `signal.reason` unchanged. Narrow on `details.code`; `code` holds the same value.
 *
 * `JSON.stringify(error)` calls {@link ExplorerVerifyError.toJSON}, which leaves out `cause`,
 * the stack and `details`, so the output is safe to print.
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
  /** Always `"ExplorerVerifyError"`. */
  override readonly name = "ExplorerVerifyError";
  /** The stable error code, equal to `details.code`. */
  readonly code: ErrorCode;
  /** One sentence: what to do next (R-DX-3). */
  readonly hint: string;
  /** Whether the same call may succeed later without a change. */
  readonly retryable: boolean;
  /** The code's data. Check `details.code` to narrow it. */
  readonly details: ErrorDetails;
  /** The code's entry in the error reference (R-AX-10). */
  readonly docsUrl: string;

  /**
   * Library code creates these; callers catch them.
   *
   * @param details - The code and its data.
   * @param message - What went wrong. Must not contain a secret.
   * @param options - A specific hint and the underlying cause.
   * @example
   * ```ts
   * throw new ExplorerVerifyError(
   *   { code: "invalid-input", issues: [{ field: "chainId", message: "must be a positive integer" }] },
   *   "The input is invalid: chainId.",
   * );
   * ```
   */
  constructor(details: ErrorDetails, message: string, options: ExplorerVerifyErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    const entry = CATALOGUE[details.code];
    this.code = details.code;
    this.hint = options.hint ?? entry.hint;
    this.retryable = entry.retryable;
    this.details = details;
    this.docsUrl = `${ERRORS_PAGE}#${details.code}`;
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
    if (this.details.code === "not-confirmed") {
      json.handle = formatHandle(this.details.handle);
    }
    return json;
  }
}
