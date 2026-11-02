/**
 * The machine contract for an outcome (R-AX-5, R-AX-7): the exit code of a result or an error,
 * and the versioned JSON envelope the CLI prints on stdout. The server handler and the CLI both
 * use these, so they cannot disagree. `schema/envelope.schema.json` describes the envelope.
 */
import { toBackendName } from "./backend-names.ts";
import { ERROR_EXIT_CODES, ExplorerVerifyError } from "./errors.ts";
import type { ErrorJson, ExitCode, InputIssue } from "./errors.ts";
import { readFields } from "./internal/read-fields.ts";
import { redact } from "./redact.ts";
import type { VerifyResult } from "./types.ts";

/**
 * What a `verify()` or `checkStatus()` call ends with: the result it returned or the error it
 * threw.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { VerifyOutcome } from "explorer-verify";
 *
 * async function outcomeOf(run: () => Promise<VerifyResult>): Promise<VerifyOutcome> {
 *   try {
 *     return await run();
 *   } catch (error) {
 *     if (error instanceof ExplorerVerifyError) {
 *       return error;
 *     }
 *     throw error;
 *   }
 * }
 * ```
 * @experimental
 */
export type VerifyOutcome = VerifyResult | ExplorerVerifyError;

/**
 * The versioned JSON document for an outcome (R-AX-5). `ok` is `true` exactly when the exit code
 * is 0. A `failed` result has `ok: false` and the result, with no `error`. Keys appear in the order
 * shown, and `schema/envelope.schema.json` in the package describes every form.
 *
 * @example
 * ```ts
 * import type { Envelope } from "explorer-verify";
 *
 * function summary(envelope: Envelope): string {
 *   if ("error" in envelope) {
 *     return `${envelope.error.code}: ${envelope.error.hint}`;
 *   }
 *   return envelope.result.status;
 * }
 * ```
 * @experimental
 */
export type Envelope =
  | {
      schemaVersion: 1;
      ok: true;
      result: Extract<VerifyResult, { status: "verified" | "already-verified" }>;
    }
  | { schemaVersion: 1; ok: false; result: Extract<VerifyResult, { status: "failed" }> }
  | { schemaVersion: 1; ok: false; error: ErrorJson };

/**
 * Options for {@link toEnvelope}.
 *
 * @example
 * ```ts
 * import type { EnvelopeOptions } from "explorer-verify";
 *
 * const options: EnvelopeOptions = { secrets: [apiKey] };
 * ```
 * @experimental
 */
export interface EnvelopeOptions {
  /**
   * Key values to remove from every string in the envelope, such as the call's API key. Key-like
   * URL and form parameters, bearer tokens and bare Etherscan-style keys are removed without it.
   */
  secrets?: readonly string[];
}

// The exit code of each result status (R-AX-7). A status without an entry fails to compile.
const RESULT_EXIT_CODES: Readonly<Record<VerifyResult["status"], ExitCode>> = {
  verified: 0,
  "already-verified": 0,
  failed: 1,
};

const MATCHES = ["exact", "partial"] as const;

const NOT_AN_OUTCOME = "The value is not a VerifyResult or an ExplorerVerifyError.";
const NOT_AN_OUTCOME_HINT =
  "Pass the result that verify() or checkStatus() returned, or the ExplorerVerifyError it threw.";

/** The status as a key of {@link RESULT_EXIT_CODES}, or `undefined`. */
function statusOf(value: unknown): VerifyResult["status"] | undefined {
  return value === "verified" || value === "already-verified" || value === "failed"
    ? value
    : undefined;
}

/** An `invalid-input` error for a value outside the outcome types. It never repeats a value. */
function notAnOutcome(issues: InputIssue[]): ExplorerVerifyError {
  return new ExplorerVerifyError({ code: "invalid-input", issues }, NOT_AN_OUTCOME, {
    secrets: [],
    hint: NOT_AN_OUTCOME_HINT,
  });
}

/**
 * A new result with only the fields its status declares, in a fixed order, each string redacted.
 * Throws `invalid-input` for a value that bypassed the types.
 */
function copyResult(result: VerifyResult, secrets: readonly string[]): VerifyResult {
  const fields = readFields(result);
  if (fields === undefined) {
    throw notAnOutcome([
      { field: "outcome", message: "must be an object whose fields can be read" },
    ]);
  }
  const issues: InputIssue[] = [];
  const status = statusOf(fields.get("status"));
  if (status === undefined) {
    issues.push({
      field: "outcome.status",
      message: "must be verified, already-verified or failed",
    });
  }
  const backendValue = fields.get("backend");
  const backend = typeof backendValue === "string" ? toBackendName(backendValue) : undefined;
  if (backend === undefined) {
    issues.push({ field: "outcome.backend", message: "must be one of BACKEND_NAMES" });
  }
  if (status === undefined || backend === undefined) {
    throw notAnOutcome(issues);
  }
  if (status === "failed") {
    const reason = fields.get("reason");
    if (typeof reason !== "string") {
      throw notAnOutcome([{ field: "outcome.reason", message: "must be a string" }]);
    }
    return { status, backend, reason: redact(reason, secrets) };
  }
  const matchValue = fields.get("match");
  const match = MATCHES.find((name) => name === matchValue);
  if (match === undefined) {
    issues.push({ field: "outcome.match", message: "must be exact or partial" });
  }
  const explorerUrl = fields.get("explorerUrl");
  if (explorerUrl !== undefined && typeof explorerUrl !== "string") {
    issues.push({ field: "outcome.explorerUrl", message: "must be a string when present" });
  }
  if (match === undefined || (explorerUrl !== undefined && typeof explorerUrl !== "string")) {
    throw notAnOutcome(issues);
  }
  return explorerUrl === undefined
    ? { status, backend, match }
    : { status, backend, match, explorerUrl: redact(explorerUrl, secrets) };
}

/** The error's `toJSON()`, rebuilt in a fixed order with every string redacted again. */
function copyError(error: ExplorerVerifyError, secrets: readonly string[]): ErrorJson {
  const source = error.toJSON();
  const json: ErrorJson = {
    code: source.code,
    message: redact(source.message, secrets),
    hint: redact(source.hint, secrets),
    docsUrl: source.docsUrl,
    retryable: source.retryable,
  };
  if (source.handle !== undefined) {
    json.handle = redact(source.handle, secrets);
  }
  return json;
}

/**
 * The CLI exit code of an outcome (R-AX-7): 0 for `verified` and `already-verified`, 1 for
 * `failed`, and {@link ERROR_EXIT_CODES} for an error. A server handler or a script uses it to
 * decide what to do next without parsing messages.
 *
 * @param outcome - The result a call returned or the error it threw.
 * @returns The exit code.
 * @throws ExplorerVerifyError `invalid-input` when `outcome` is neither, which only code that
 *   bypassed the types can pass.
 * @example
 * ```ts
 * import { ExplorerVerifyError, exitCodeOf } from "explorer-verify";
 *
 * try {
 *   const result = await verify(input);
 *   process.exitCode = exitCodeOf(result); // 0 or 1
 * } catch (error) {
 *   if (!(error instanceof ExplorerVerifyError)) throw error;
 *   process.exitCode = exitCodeOf(error); // 2 to 6, or 130
 * }
 * ```
 * @experimental
 */
export function exitCodeOf(outcome: VerifyOutcome): ExitCode {
  if (outcome instanceof ExplorerVerifyError) {
    return ERROR_EXIT_CODES[outcome.code];
  }
  const status = statusOf(readFields(outcome)?.get("status"));
  if (status === undefined) {
    throw notAnOutcome([
      { field: "outcome.status", message: "must be verified, already-verified or failed" },
    ]);
  }
  return RESULT_EXIT_CODES[status];
}

/**
 * The versioned JSON envelope of an outcome (R-AX-5), as the CLI prints it with `--json`:
 * `{ schemaVersion: 1, ok, result }` for a result and `{ schemaVersion: 1, ok: false, error }` for
 * an error. `ok` is `true` exactly when {@link exitCodeOf} is 0.
 *
 * The envelope is a new object. A result keeps only the fields its status declares, an error is
 * its `toJSON()`, keys are always in the same order (R-AX-12), and every string is redacted again,
 * so the envelope never holds an API key (R-AX-9, R-SEC-1).
 *
 * @param outcome - The result a call returned or the error it threw.
 * @param options - Key values to redact, such as the call's API key.
 * @returns The envelope, ready for `JSON.stringify`.
 * @throws ExplorerVerifyError `invalid-input` when `outcome` is neither, which only code that
 *   bypassed the types can pass.
 * @example
 * ```ts
 * import { ExplorerVerifyError, toEnvelope } from "explorer-verify";
 *
 * try {
 *   const result = await verify(input);
 *   console.log(JSON.stringify(toEnvelope(result, { secrets: [apiKey] })));
 * } catch (error) {
 *   if (!(error instanceof ExplorerVerifyError)) throw error;
 *   console.log(JSON.stringify(toEnvelope(error)));
 *   // {"schemaVersion":1,"ok":false,"error":{"code":"not-confirmed",...,"handle":"ev1:..."}}
 * }
 * ```
 * @experimental
 */
export function toEnvelope(outcome: VerifyOutcome, options: EnvelopeOptions = {}): Envelope {
  const secrets = options.secrets ?? [];
  if (outcome instanceof ExplorerVerifyError) {
    return { schemaVersion: 1, ok: false, error: copyError(outcome, secrets) };
  }
  const result = copyResult(outcome, secrets);
  return result.status === "failed"
    ? { schemaVersion: 1, ok: false, result }
    : { schemaVersion: 1, ok: true, result };
}
