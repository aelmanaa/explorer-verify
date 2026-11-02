/**
 * The one error class the library throws, and the codes it carries (decision 0009). Each code has
 * a fix hint, an entry in docs/user/reference/errors.md and a CLI exit code (R-DX-3, R-AX-7,
 * R-AX-10). The constructor redacts API keys from everything the error holds (R-SEC-1).
 */
import { toBackendName } from "./backend-names.ts";
import type { BackendName } from "./backend-names.ts";
import { formatHandle } from "./flow/format-handle.ts";
import { redact, redactExcerpt } from "./redact.ts";
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
  "cancelled",
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
      /**
       * The backend that refused it. `"unknown"` appears only when code bypassed the types
       * and passed a name outside `BACKEND_NAMES`.
       */
      backend: BackendName | "unknown";
    }
  | {
      /** Every request to the backend failed before it answered, retries included. */
      code: "network";
      /**
       * The backend that could not be reached. `"unknown"` appears only when code bypassed the types
       * and passed a name outside `BACKEND_NAMES`.
       */
      backend: BackendName | "unknown";
      /** How many requests were tried. */
      attempts: number;
    }
  | {
      /** The backend answered 429 on every try. */
      code: "rate-limited";
      /**
       * The backend that limited the requests. `"unknown"` appears only when code bypassed the types
       * and passed a name outside `BACKEND_NAMES`.
       */
      backend: BackendName | "unknown";
      /** How long the backend asked to wait, when it said (`Retry-After`). */
      retryAfterMs?: number;
    }
  | {
      /** The time budget ran out before the explorer accepted the submission: there is no handle. */
      code: "timeout";
      /**
       * The backend that did not answer in time. `"unknown"` appears only when code bypassed the types
       * and passed a name outside `BACKEND_NAMES`.
       */
      backend: BackendName | "unknown";
      /** The budget that ran out, in milliseconds. */
      timeoutMs: number;
    }
  | {
      /** The backend answered with a status or a body the library does not recognise. */
      code: "unexpected-response";
      /**
       * The backend that answered. `"unknown"` appears only when code bypassed the types
       * and passed a name outside `BACKEND_NAMES`.
       */
      backend: BackendName | "unknown";
      /** The HTTP status. */
      status: number;
      /** The start of the response body, redacted, at most 300 characters. */
      excerpt: string;
    }
  | {
      /** The backend is already verifying this contract from another submission. */
      code: "in-progress";
      /**
       * The backend that is busy with the contract. `"unknown"` appears only when code bypassed the types
       * and passed a name outside `BACKEND_NAMES`.
       */
      backend: BackendName | "unknown";
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
  "in-progress": 5,
  "unknown-state": 6,
  "job-not-found": 6,
  cancelled: 130,
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
 *   hint: "Only sourcify is available in this version.",
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

const ERRORS_PAGE =
  "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md";

// The longest excerpt of an explorer's answer that an error keeps.
const EXCERPT_LENGTH = 300;
// How many levels of `cause` an error keeps, its own cause included.
const CAUSE_DEPTH = 4;
// How many errors of an AggregateError the cause summary names.
const AGGREGATE_ERRORS = 5;
const UNREADABLE_CAUSE = "[unreadable cause]";
const OMITTED_CAUSE = "[cause omitted]";
// Stands in for a backend name that is not in BACKEND_NAMES, which only code that bypasses the
// types can pass.
const UNKNOWN_BACKEND = "unknown";
// The handle's backend type has no "unknown": a handle with a name outside BACKEND_NAMES, which
// only code that bypasses the types can build, gets this name so the handle stays a valid Handle.
const UNKNOWN_HANDLE_BACKEND: BackendName = "etherscan-compatible";

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
    hint: "Call again later. If the error persists, check the explorer's status page and report details.status and details.excerpt.",
    retryable: true,
  },
  "in-progress": {
    hint: "Wait for the explorer to finish its current verification of this contract, then call again.",
    retryable: true,
  },
  "unknown-state": {
    hint: "Do not retry automatically. Check the contract on the explorer and report details.excerpt.",
    retryable: false,
  },
  "job-not-found": {
    hint: "Do not retry automatically. Check the contract on the explorer; if it is not verified, call verify() again.",
    retryable: false,
  },
  cancelled: {
    hint: "The run was cancelled. If verify.submitted was printed, resume with checkStatus and that handle.",
    retryable: false,
  },
};

/**
 * A new `details`, built field by field from the fields its code declares, so an extra field
 * never reaches the error. Every string is redacted and every excerpt cut to 300 characters.
 */
function redactDetails(details: ErrorDetails, secrets: readonly string[]): ErrorDetails {
  // Every code is listed, so a new code fails the exhaustiveness lint until it is added here.
  let copy: ErrorDetails;
  switch (details.code) {
    case "invalid-input":
      copy = {
        code: "invalid-input",
        issues: details.issues.map((issue) => ({
          field: text(issue.field, secrets),
          message: text(issue.message, secrets),
        })),
      };
      break;
    case "not-confirmed":
      copy = { code: "not-confirmed", handle: redactHandle(details.handle, secrets) };
      break;
    case "job-not-found":
      copy = { code: "job-not-found", handle: redactHandle(details.handle, secrets) };
      break;
    case "cancelled":
      copy = { code: "cancelled" };
      if (details.handle !== undefined) {
        copy.handle = redactHandle(details.handle, secrets);
      }
      break;
    case "unknown-state":
      copy = {
        code: "unknown-state",
        handle: redactHandle(details.handle, secrets),
        excerpt: redactExcerpt(stringOf(details.excerpt), secrets, EXCERPT_LENGTH),
      };
      break;
    case "unexpected-response":
      copy = {
        code: "unexpected-response",
        backend: backendOf(details.backend),
        status: numberOf(details.status),
        excerpt: redactExcerpt(stringOf(details.excerpt), secrets, EXCERPT_LENGTH),
      };
      break;
    case "unsupported-chain":
      copy = {
        code: "unsupported-chain",
        chainId: numberOf(details.chainId),
        backend: backendOf(details.backend),
      };
      break;
    case "network":
      copy = {
        code: "network",
        backend: backendOf(details.backend),
        attempts: numberOf(details.attempts),
      };
      break;
    case "rate-limited":
      copy = { code: "rate-limited", backend: backendOf(details.backend) };
      if (details.retryAfterMs !== undefined) {
        copy.retryAfterMs = numberOf(details.retryAfterMs);
      }
      break;
    case "timeout":
      copy = {
        code: "timeout",
        backend: backendOf(details.backend),
        timeoutMs: numberOf(details.timeoutMs),
      };
      break;
    case "in-progress":
      copy = { code: "in-progress", backend: backendOf(details.backend) };
      break;
  }
  return copy;
}

// The helpers below take `unknown`: the types say what callers pass, but an error must never throw
// or leak when code that bypasses the types passes something else.

/** A known backend name, or `undefined`. */
function knownBackend(value: unknown): BackendName | undefined {
  return typeof value === "string" ? toBackendName(value) : undefined;
}

/** A known backend name, or `"unknown"`. */
function backendOf(value: unknown): BackendName | typeof UNKNOWN_BACKEND {
  return knownBackend(value) ?? UNKNOWN_BACKEND;
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

/** A new handle built from its five fields, with the job id and address redacted. */
function redactHandle(handle: Handle, secrets: readonly string[]): Handle {
  return {
    version: 1,
    backend: knownBackend(handle.backend) ?? UNKNOWN_HANDLE_BACKEND,
    chainId: numberOf(handle.chainId),
    address: `0x${text(stringOf(handle.address).slice(2), secrets)}`,
    jobId: text(handle.jobId, secrets),
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
   * @param options - The key values to redact, and optionally a specific hint and the cause.
   * @example
   * ```ts
   * throw new ExplorerVerifyError(
   *   { code: "invalid-input", issues: [{ field: "chainId", message: "must be a positive integer" }] },
   *   "The input is invalid: chainId.",
   *   { secrets: [] },
   * );
   * ```
   */
  constructor(details: ErrorDetails, message: string, options: ExplorerVerifyErrorOptions) {
    // The message is redacted before `super`, which builds the stack from it.
    super(
      redact(message, options.secrets),
      "cause" in options ? { cause: redactCause(options.cause, options.secrets, 1) } : undefined,
    );
    const entry = CATALOGUE[details.code];
    const hint =
      options.hint !== undefined && options.hint.trim() !== "" ? options.hint : entry.hint;
    this.code = details.code;
    this.hint = redact(hint, options.secrets);
    this.retryable = entry.retryable;
    this.details = redactDetails(details, options.secrets);
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
    const handle = "handle" in this.details ? this.details.handle : undefined;
    if (handle !== undefined) {
      json.handle = formatHandle(handle);
    }
    return json;
  }
}
