/**
 * The machine contract for an outcome (R-AX-5, R-AX-7): the exit code of a result or an error,
 * and the versioned JSON envelope the CLI prints on stdout. The server handler and the CLI both
 * use these, so they cannot disagree. `schema/envelope.schema.json` describes the envelope.
 */
import { toBackendName } from "./backend-names.ts";
import { newError } from "./error-hints.ts";
import { ERROR_CODES, ERROR_EXIT_CODES, ExplorerVerifyError } from "./errors.ts";
import type { AnyExplorerVerifyError, ErrorJson, ExitCode, InputIssue } from "./errors.ts";
import { redactSplitHandle, splitHandle } from "./flow/format-handle.ts";
import { JOB_ID } from "./flow/handle.ts";
import { addressDigits, readChainId, readFields } from "./internal/read-fields.ts";
import { REDACTED, redact } from "./redact.ts";
import type { BackendOutcome, DryRunResult, VerifyEachResult, VerifyResult } from "./types.ts";

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
export type VerifyOutcome = VerifyResult | AnyExplorerVerifyError;

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
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `true`: the exit code is 0. */
      ok: true;
      /** The verified or already-verified result. */
      result: Extract<VerifyResult, Record<"status", "verified" | "already-verified">>;
    }
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `false`: the explorer rejected the submission. */
      ok: false;
      /** The failed result. */
      result: Extract<VerifyResult, Record<"status", "failed">>;
    }
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `true`: a dry run submits nothing, and the exit code is 0. */
      ok: true;
      /** The dry run's result. */
      result: DryRunResult;
    }
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `true` when every backend holds the verified source: the exit code is 0. */
      ok: boolean;
      /** The outcome of each backend of a `verifyEach()` call. */
      result: VerifyEachResult<ErrorJson>;
    }
  | {
      /** The version of this document's form. */
      schemaVersion: 1;
      /** `false`: the call threw. */
      ok: false;
      /** The error, as `ExplorerVerifyError.toJSON()` gives it, with API keys removed. */
      error: ErrorJson;
    };

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

const NOT_AN_OUTCOME =
  "The value is not a VerifyResult, a DryRunResult, a VerifyEachResult or an ExplorerVerifyError.";
const NOT_AN_OUTCOME_HINT =
  "Pass the result that verify(), checkStatus() or verifyEach() returned, or the ExplorerVerifyError it threw.";

/**
 * The exit code of a `verifyEach()` result that is not 0, in order of precedence (R-AX-7): the
 * first code in this list that any outcome has. 0 only when every outcome has 0.
 */
const EACH_EXIT_ORDER: readonly ExitCode[] = [6, 4, 3, 2, 5, 1, 130];
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
  return newError({ code: "invalid-input", issues }, message, {
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
const ROUTED_BY = ["caller", "table", "fallback", "api-url"] as const;

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
  const routedByValue = fields.get("routedBy");
  const routedBy =
    routedByValue === undefined
      ? undefined
      : (ROUTED_BY.find((name) => name === routedByValue) ??
        problems.add(
          "outcome.routedBy",
          "must be caller, table, fallback or api-url when present",
        ) ??
        null);
  if (
    backend === undefined ||
    apiHost === undefined ||
    lookup === undefined ||
    explorerUrl === null ||
    routedBy === null
  ) {
    throw invalid(problems.issues);
  }
  return {
    status: "dry-run",
    backend,
    apiHost: redact(apiHost, secrets),
    lookup,
    ...(explorerUrl === undefined ? {} : { explorerUrl: redact(explorerUrl, secrets) }),
    ...(routedBy === undefined ? {} : { routedBy }),
  };
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
 * `ExplorerVerifyError` of this copy of the package or of another copy, recognised by its name and
 * a `toJSON()`. `foreign` marks the other copy, whose handle is checked field by field. Only an
 * error whose prototype chain holds this copy's class is this copy's: `instanceof` also accepts an
 * error from another copy by its brand (decision 0044). `undefined` for any other value.
 */
function errorReader(outcome: unknown): { read: () => unknown; foreign: boolean } | undefined {
  const branded = ExplorerVerifyError.is(outcome);
  if (branded && Object.prototype.isPrototypeOf.call(ExplorerVerifyError.prototype, outcome)) {
    return { read: () => outcome.toJSON(), foreign: false };
  }
  if (typeof outcome !== "object" || outcome === null) {
    return undefined;
  }
  try {
    const name: unknown = Reflect.get(outcome, "name");
    const toJSON: unknown = Reflect.get(outcome, "toJSON");
    if ((branded || name === ERROR_NAME) && typeof toJSON === "function") {
      return { read: (): unknown => Reflect.apply(toJSON, outcome, []), foreign: true };
    }
    // A branded value claims to be an error: refuse it as one, so the message names its toJSON().
    return branded ? { read: (): unknown => undefined, foreign: true } : undefined;
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
  const handlesValue = fields.get("handles");
  const handles =
    handlesValue === undefined
      ? undefined
      : (handlesOf(handlesValue, foreign, secrets) ??
        problems.add("outcome.handles", "must be a list of backends and one-line handles") ??
        null);
  if (
    code === undefined ||
    message === undefined ||
    hint === undefined ||
    docsUrl === undefined ||
    retryable === undefined ||
    handle === null ||
    handles === null
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
  if (handles !== undefined) {
    json.handles = handles;
  }
  return json;
}

/**
 * The `handles` of a `cancelled` error, checked and redacted: a non-empty list of objects with a
 * known `backend` and a one-line `handle` of that backend. `undefined` for anything else.
 */
function handlesOf(
  value: unknown,
  foreign: boolean,
  secrets: readonly string[],
): NonNullable<ErrorJson["handles"]> | undefined {
  let items: readonly unknown[] | undefined;
  try {
    if (Array.isArray(value)) {
      const list: readonly unknown[] = value;
      items = [...list];
    }
  } catch {
    items = undefined;
  }
  if (items === undefined || items.length === 0) {
    return undefined;
  }
  const copies: NonNullable<ErrorJson["handles"]> = [];
  for (const item of items) {
    const fields = readFields(item);
    const backendValue = stringOf(fields?.get("backend"));
    const backend = backendValue === undefined ? undefined : toBackendName(backendValue);
    const line = fields?.get("handle");
    const split = foreign ? strictHandle(line) : splitHandle(line);
    if (
      backend === undefined ||
      split === undefined ||
      typeof line !== "string" ||
      line.split(":")[1] !== backend
    ) {
      return undefined;
    }
    copies.push({ backend, handle: redactSplitHandle(split, secrets) });
  }
  return copies;
}

/** The outcome, checked and copied: the error object of an error, or the result. */
function readOutcome(
  outcome: unknown,
  secrets: readonly string[],
): { error: ErrorJson } | { result: AnyResult } | { each: VerifyEachResult<ErrorJson> } {
  const read = errorReader(outcome);
  if (read !== undefined) {
    return { error: copyError(read, secrets) };
  }
  const outcomes = readFields(outcome)?.get("outcomes");
  return outcomes === undefined
    ? { result: copyResult(outcome, secrets) }
    : { each: { outcomes: copyOutcomes(outcomes, secrets) } };
}

/**
 * The outcomes of a `verifyEach()` result, each checked and copied as {@link copyResult} and
 * {@link copyError} copy one. Throws `invalid-input` for a value that bypassed the types: an empty
 * list, an unknown backend, a result of another backend, or an `ok` that disagrees with the
 * result.
 */
function copyOutcomes(value: unknown, secrets: readonly string[]): BackendOutcome<ErrorJson>[] {
  let items: readonly unknown[] | undefined;
  try {
    if (Array.isArray(value)) {
      const list: readonly unknown[] = value;
      items = [...list];
    }
  } catch {
    items = undefined;
  }
  if (items === undefined || items.length === 0) {
    throw invalid([{ field: "outcome.outcomes", message: "must be a non-empty array" }]);
  }
  return items.map((item, index) =>
    copyBackendOutcome(item, `outcome.outcomes[${String(index)}]`, secrets),
  );
}

/** One outcome of a `verifyEach()` result, checked and copied. */
function copyBackendOutcome(
  item: unknown,
  field: string,
  secrets: readonly string[],
): BackendOutcome<ErrorJson> {
  const fields = readFields(item);
  const backendValue = stringOf(fields?.get("backend"));
  const backend = backendValue === undefined ? undefined : toBackendName(backendValue);
  const ok = fields?.get("ok");
  if (fields === undefined || backend === undefined || typeof ok !== "boolean") {
    throw invalid([{ field, message: "must be an object with a known backend and a boolean ok" }]);
  }
  const errorValue = fields.get("error");
  if (errorValue !== undefined) {
    if (ok) {
      throw invalid([{ field: `${field}.ok`, message: "must be false for an error" }]);
    }
    return {
      backend,
      ok,
      error: copyError(
        errorReader(errorValue) ?? { read: () => errorValue, foreign: true },
        secrets,
      ),
    };
  }
  const result = copyResult(fields.get("result"), secrets);
  if (result.status === "dry-run" || result.backend !== backend) {
    throw invalid([
      { field: `${field}.result`, message: "must be a VerifyResult of the outcome's backend" },
    ]);
  }
  if (result.status === "failed") {
    if (ok) {
      throw invalid([{ field: `${field}.ok`, message: "must be false for a failed result" }]);
    }
    return { backend, ok, result };
  }
  if (!ok) {
    throw invalid([{ field: `${field}.ok`, message: "must be true for a verified result" }]);
  }
  return { backend, ok, result };
}

/** The exit code of each outcome of a `verifyEach()` result, combined by {@link EACH_EXIT_ORDER}. */
function eachExitCode(each: VerifyEachResult<ErrorJson>): ExitCode {
  const codes = each.outcomes.map((outcome) =>
    "error" in outcome
      ? ERROR_EXIT_CODES[outcome.error.code]
      : RESULT_EXIT_CODES[outcome.result.status],
  );
  return EACH_EXIT_ORDER.find((code) => codes.includes(code)) ?? 0;
}

/**
 * The CLI exit code of an outcome (R-AX-7): 0 for `verified`, `already-verified` and a
 * `DryRunResult`, 1 for `failed`, and {@link ERROR_EXIT_CODES} for an error. A server handler or
 * a script uses it to decide what to do next without parsing messages. It checks the outcome as
 * {@link toEnvelope} does, so the two never disagree.
 *
 * For a `verifyEach()` result, it is 0 only when every backend's outcome is 0. Otherwise it is the
 * first of 6, 4, 3, 2, 5, 1 and 130 that any outcome has: a state a person must check, then a job
 * to resume, then a key or input to fix, then what a retry may settle, then a rejection. The code
 * names only the first outcome that has it; read `outcomes` for every backend.
 *
 * An error from another copy of the package in the same program, which `instanceof` misses, is
 * accepted when its `name` is `"ExplorerVerifyError"` and its `toJSON()` returns a valid error
 * object.
 *
 * @param outcome - The result a call returned, a `DryRunResult`, a `VerifyEachResult`, or the
 *   error a call threw.
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
export function exitCodeOf(
  outcome:
    | VerifyOutcome
    | ExplorerVerifyError
    | DryRunResult
    | VerifyEachResult
    | VerifyEachResult<ExplorerVerifyError>
    | VerifyEachResult<ErrorJson>,
): ExitCode {
  const read = readOutcome(outcome, []);
  if ("each" in read) {
    return eachExitCode(read.each);
  }
  return "error" in read
    ? ERROR_EXIT_CODES[read.error.code]
    : RESULT_EXIT_CODES[read.result.status];
}

/**
 * The versioned JSON envelope of an outcome (R-AX-5), as the CLI prints it with `--json`:
 * `{ schemaVersion: 1, ok, result }` for a result and `{ schemaVersion: 1, ok: false, error }` for
 * an error. `ok` is `true` exactly when {@link exitCodeOf} is 0. A `verifyEach()` result is the
 * `result`, its outcomes each copied as a result or an error is.
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
 * @param outcome - The result a call returned, a `DryRunResult`, a `VerifyEachResult`, or the
 *   error a call threw.
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
  outcome:
    | VerifyOutcome
    | ExplorerVerifyError
    | DryRunResult
    | VerifyEachResult
    | VerifyEachResult<ExplorerVerifyError>
    | VerifyEachResult<ErrorJson>,
  options?: EnvelopeOptions,
): Envelope {
  const read = readOutcome(outcome, secretsOf(options));
  if ("each" in read) {
    return { schemaVersion: 1, ok: eachExitCode(read.each) === 0, result: read.each };
  }
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
