/**
 * The machine contract for an outcome (R-AX-5, R-AX-7): the exit code of a result or an error,
 * and the versioned JSON envelope the CLI prints on stdout. The server handler and the CLI both
 * use these, so they cannot disagree. `schema/envelope.schema.json` describes the envelope.
 */
import { toBackendName } from "./backend-names.ts";
import { ERROR_CODES, ERROR_EXIT_CODES, ExplorerVerifyError } from "./errors.ts";
import type { ErrorJson, ExitCode, InputIssue } from "./errors.ts";
import { redactSplitHandle, splitHandle } from "./flow/format-handle.ts";
import { JOB_ID } from "./flow/handle.ts";
import { addressDigits, readChainId, readFields } from "./internal/read-fields.ts";
import { REDACTED, redact } from "./redact.ts";
import type { DryRunResult, VerifyResult } from "./types.ts";

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
 * is 0. A `failed` result has `ok: false` and the result, with no `error`. A `DryRunResult` has
 * `ok: true`: a dry run submits nothing and exits 0 (R-AX-8). Keys appear in the order
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
  | { schemaVersion: 1; ok: true; result: DryRunResult }
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

/** Every result status: those of `VerifyResult` and `dry-run`. */
type Status = VerifyResult["status"] | DryRunResult["status"];

/** A result `toEnvelope` takes: a `VerifyResult` or a `DryRunResult`. */
type AnyResult = VerifyResult | DryRunResult;

// The exit code of each result status (R-AX-7). A status without an entry fails to compile.
const RESULT_EXIT_CODES: Readonly<Record<Status, ExitCode>> = {
  verified: 0,
  "already-verified": 0,
  failed: 1,
  "dry-run": 0,
};

const MATCHES = ["exact", "partial"] as const;

// The name every copy of the package gives its error class.
const ERROR_NAME = "ExplorerVerifyError";

/** A chain id in decimal digits, with no leading zero. */
const DECIMAL = /^[1-9][0-9]*$/;

/**
 * {@link splitHandle} for a handle from another copy of the package, whose `toJSON()` this copy
 * did not build. Every field is checked, so no text, such as a key, rides in a field that is not
 * redacted: a known backend, a positive safe integer chain id, `0x` and 40 hex digits, and a job id
 * of the handle charset or the literal `[redacted]`.
 */
function strictHandle(value: unknown): { prefix: string; jobId: string } | undefined {
  const handle = splitHandle(value);
  const [, backend = "", chainId = "", address = "", jobId = ""] =
    typeof value === "string" ? value.split(":") : [];
  const valid =
    handle !== undefined &&
    toBackendName(backend) !== undefined &&
    DECIMAL.test(chainId) &&
    readChainId(Number(chainId)) !== undefined &&
    addressDigits(address) !== undefined &&
    (JOB_ID.test(jobId) || jobId === REDACTED) &&
    handle.jobId === jobId;
  return valid ? handle : undefined;
}

const NOT_AN_OUTCOME = "The value is not a VerifyResult, a DryRunResult or an ExplorerVerifyError.";
const NOT_AN_OUTCOME_HINT =
  "Pass the result that verify() or checkStatus() returned, or the ExplorerVerifyError it threw.";
const BAD_OPTIONS = "The options are invalid.";
const BAD_OPTIONS_HINT = "Pass options as { secrets: string[] }, or leave them out.";

/** Collects the problems found in a value. `add` returns `undefined`, so it ends a `??` chain. */
class Problems {
  readonly issues: InputIssue[] = [];

  add(field: string, message: string): undefined {
    this.issues.push({ field, message });
    return undefined;
  }
}

/** An `invalid-input` error for a value outside the types. It never repeats a value. */
function invalid(issues: InputIssue[], message = NOT_AN_OUTCOME, hint = NOT_AN_OUTCOME_HINT) {
  return new ExplorerVerifyError({ code: "invalid-input", issues }, message, {
    secrets: [],
    hint,
  });
}

/** The status as a key of {@link RESULT_EXIT_CODES}, or `undefined`. */
function statusOf(value: unknown): Status | undefined {
  return value === "verified" ||
    value === "already-verified" ||
    value === "failed" ||
    value === "dry-run"
    ? value
    : undefined;
}

const LOOKUPS = ["exact", "partial", "none", "skipped"] as const;

/**
 * The `explorerUrl` field: `undefined` when absent, `null` when present but not a string, which
 * adds an issue.
 */
function explorerUrlOf(
  fields: Map<string, unknown>,
  problems: Problems,
): string | null | undefined {
  const value = fields.get("explorerUrl");
  return value === undefined
    ? undefined
    : (stringOf(value) ??
        problems.add("outcome.explorerUrl", "must be a string when present") ??
        null);
}

/** A new `DryRunResult`, its fields in a fixed order, each string redacted. */
function copyDryRun(
  fields: Map<string, unknown>,
  backend: DryRunResult["backend"] | undefined,
  problems: Problems,
  secrets: readonly string[],
): DryRunResult {
  const apiHost =
    stringOf(fields.get("apiHost")) ?? problems.add("outcome.apiHost", "must be a string");
  const lookupValue = fields.get("lookup");
  const lookup =
    LOOKUPS.find((name) => name === lookupValue) ??
    problems.add("outcome.lookup", "must be exact, partial, none or skipped");
  const explorerUrl = explorerUrlOf(fields, problems);
  if (
    backend === undefined ||
    apiHost === undefined ||
    lookup === undefined ||
    explorerUrl === null
  ) {
    throw invalid(problems.issues);
  }
  const result: DryRunResult = {
    status: "dry-run",
    backend,
    apiHost: redact(apiHost, secrets),
    lookup,
  };
  return explorerUrl === undefined
    ? result
    : { ...result, explorerUrl: redact(explorerUrl, secrets) };
}

/** `value` when it is a string, else `undefined`. */
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A copy of `value` when it is an array of strings, else `undefined`. An array whose entries
 * cannot be read, as a hostile Proxy's, is `undefined` too.
 */
function stringsOf(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const items: readonly unknown[] = value;
    const strings: string[] = [];
    for (const item of items) {
      if (typeof item !== "string") {
        return undefined;
      }
      strings.push(item);
    }
    return strings;
  } catch {
    return undefined;
  }
}

/**
 * The secrets in `options`, copied. Throws `invalid-input` when `options` is not an object or
 * `secrets` is not an array of strings, which only code that bypassed the types can pass.
 */
function secretsOf(options: unknown): readonly string[] {
  if (options === undefined) {
    return [];
  }
  const fields = readFields(options);
  if (fields === undefined) {
    throw invalid(
      [{ field: "options", message: "must be an object" }],
      BAD_OPTIONS,
      BAD_OPTIONS_HINT,
    );
  }
  const secrets = fields.get("secrets");
  if (secrets === undefined) {
    return [];
  }
  const copy = stringsOf(secrets);
  if (copy === undefined) {
    throw invalid(
      [{ field: "options.secrets", message: "must be an array of strings" }],
      BAD_OPTIONS,
      BAD_OPTIONS_HINT,
    );
  }
  return copy;
}

/**
 * A new result with only the fields its status declares, in a fixed order, each string redacted.
 * Throws `invalid-input` for a value that bypassed the types.
 */
function copyResult(result: unknown, secrets: readonly string[]): AnyResult {
  const fields = readFields(result);
  if (fields === undefined) {
    throw invalid([{ field: "outcome", message: "must be an object whose fields can be read" }]);
  }
  const problems = new Problems();
  const status =
    statusOf(fields.get("status")) ??
    problems.add("outcome.status", "must be verified, already-verified, failed or dry-run");
  const backendValue = stringOf(fields.get("backend"));
  const backend =
    (backendValue === undefined ? undefined : toBackendName(backendValue)) ??
    problems.add("outcome.backend", "must be one of BACKEND_NAMES");
  if (status === "failed") {
    const reason =
      stringOf(fields.get("reason")) ?? problems.add("outcome.reason", "must be a string");
    if (backend === undefined || reason === undefined) {
      throw invalid(problems.issues);
    }
    return { status, backend, reason: redact(reason, secrets) };
  }
  if (status === "dry-run") {
    return copyDryRun(fields, backend, problems, secrets);
  }
  const matchValue = fields.get("match");
  const match =
    MATCHES.find((name) => name === matchValue) ??
    problems.add("outcome.match", "must be exact or partial");
  // `null` stands for an explorerUrl that is present but not a string.
  const explorerUrl = explorerUrlOf(fields, problems);
  if (
    status === undefined ||
    backend === undefined ||
    match === undefined ||
    explorerUrl === null
  ) {
    throw invalid(problems.issues);
  }
  return explorerUrl === undefined
    ? { status, backend, match }
    : { status, backend, match, explorerUrl: redact(explorerUrl, secrets) };
}

/**
 * A reader of the error object of `outcome`: its own `toJSON()` when it is an
 * `ExplorerVerifyError` of this copy of the package or of another copy, which `instanceof` misses
 * but which has the same name and a `toJSON()`. `foreign` marks the other copy, whose handle is
 * checked field by field. `undefined` for any other value.
 */
function errorReader(outcome: unknown): { read: () => unknown; foreign: boolean } | undefined {
  if (outcome instanceof ExplorerVerifyError) {
    return { read: () => outcome.toJSON(), foreign: false };
  }
  if (typeof outcome !== "object" || outcome === null) {
    return undefined;
  }
  try {
    const name: unknown = Reflect.get(outcome, "name");
    const toJSON: unknown = Reflect.get(outcome, "toJSON");
    return name === ERROR_NAME && typeof toJSON === "function"
      ? { read: (): unknown => Reflect.apply(toJSON, outcome, []), foreign: true }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The error object, checked field by field and rebuilt in a fixed order, every string redacted
 * again. The job id of the handle skips the bare-key shape rule, as in the error itself, and the
 * rest of the handle is kept. Throws `invalid-input` for an object that is not an error object.
 */
function copyError(
  { read, foreign }: { read: () => unknown; foreign: boolean },
  secrets: readonly string[],
): ErrorJson {
  let source: unknown;
  try {
    source = read();
  } catch {
    source = undefined;
  }
  const fields = readFields(source);
  if (fields === undefined) {
    throw invalid([{ field: "outcome", message: "must have a toJSON() that returns an object" }]);
  }
  const problems = new Problems();
  const codeValue = fields.get("code");
  const code =
    ERROR_CODES.find((known) => known === codeValue) ??
    problems.add("outcome.code", "must be one of ERROR_CODES");
  const message =
    stringOf(fields.get("message")) ?? problems.add("outcome.message", "must be a string");
  const hintValue = stringOf(fields.get("hint"));
  const hint =
    hintValue === undefined || hintValue === ""
      ? problems.add("outcome.hint", "must be a non-empty string")
      : hintValue;
  const urlValue = stringOf(fields.get("docsUrl"));
  const docsUrl =
    urlValue?.startsWith("https://") === true
      ? urlValue
      : problems.add("outcome.docsUrl", "must be an https URL");
  const retryableValue = fields.get("retryable");
  const retryable =
    typeof retryableValue === "boolean"
      ? retryableValue
      : problems.add("outcome.retryable", "must be a boolean");
  const handleValue = fields.get("handle");
  // `null` stands for a handle that is present but not in its one-line form.
  const handle =
    handleValue === undefined
      ? undefined
      : ((foreign ? strictHandle(handleValue) : splitHandle(handleValue)) ??
        problems.add("outcome.handle", "must be a handle in its one-line form") ??
        null);
  if (
    code === undefined ||
    message === undefined ||
    hint === undefined ||
    docsUrl === undefined ||
    retryable === undefined ||
    handle === null
  ) {
    throw invalid(problems.issues);
  }
  const json: ErrorJson = {
    code,
    message: redact(message, secrets),
    hint: redact(hint, secrets),
    docsUrl,
    retryable,
  };
  if (handle !== undefined) {
    json.handle = redactSplitHandle(handle, secrets);
  }
  return json;
}

/** The outcome, checked and copied: the error object of an error, or the result. */
function readOutcome(
  outcome: unknown,
  secrets: readonly string[],
): { error: ErrorJson } | { result: AnyResult } {
  const read = errorReader(outcome);
  return read === undefined
    ? { result: copyResult(outcome, secrets) }
    : { error: copyError(read, secrets) };
}

/**
 * The CLI exit code of an outcome (R-AX-7): 0 for `verified`, `already-verified` and a
 * `DryRunResult`, 1 for
 * `failed`, and {@link ERROR_EXIT_CODES} for an error. A server handler or a script uses it to
 * decide what to do next without parsing messages. It checks the outcome as {@link toEnvelope}
 * does, so the two never disagree.
 *
 * An error from another copy of the package in the same program, which `instanceof` misses, is
 * accepted when its `name` is `"ExplorerVerifyError"` and its `toJSON()` returns a valid error
 * object.
 *
 * @param outcome - The result a call returned, a `DryRunResult`, or the error a call threw.
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
export function exitCodeOf(outcome: VerifyOutcome | DryRunResult): ExitCode {
  const read = readOutcome(outcome, []);
  return "error" in read
    ? ERROR_EXIT_CODES[read.error.code]
    : RESULT_EXIT_CODES[read.result.status];
}

/**
 * The versioned JSON envelope of an outcome (R-AX-5), as the CLI prints it with `--json`:
 * `{ schemaVersion: 1, ok, result }` for a result and `{ schemaVersion: 1, ok: false, error }` for
 * an error. `ok` is `true` exactly when {@link exitCodeOf} is 0.
 *
 * The envelope is a new object. A result keeps only the fields its status declares, an error is
 * its `toJSON()`, keys are always in the same order (R-AX-12), and every string is redacted again,
 * so the envelope never holds an API key (R-AX-9, R-SEC-1). The job id of a handle is redacted only
 * where it holds a known secret or a key-like parameter, so a valid job id keeps working.
 *
 * An error from another copy of the package in the same program, which `instanceof` misses, is
 * accepted when its `name` is `"ExplorerVerifyError"` and its `toJSON()` returns a valid error
 * object.
 *
 * @param outcome - The result a call returned, a `DryRunResult`, or the error a call threw.
 * @param options - Key values to redact, such as the call's API key.
 * @returns The envelope, ready for `JSON.stringify`.
 * @throws ExplorerVerifyError `invalid-input` when `outcome` is neither, or `options` is not
 *   `{ secrets?: string[] }`, which only code that bypassed the types can pass.
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
export function toEnvelope(
  outcome: VerifyOutcome | DryRunResult,
  options?: EnvelopeOptions,
): Envelope {
  const read = readOutcome(outcome, secretsOf(options));
  if ("error" in read) {
    return { schemaVersion: 1, ok: false, error: read.error };
  }
  const { result } = read;
  if (result.status === "dry-run") {
    return { schemaVersion: 1, ok: true, result };
  }
  return result.status === "failed"
    ? { schemaVersion: 1, ok: false, result }
    : { schemaVersion: 1, ok: true, result };
}
