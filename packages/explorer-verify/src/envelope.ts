/**
 * The machine contract for an outcome (R-AX-5, R-AX-7): the exit code of a result or an error,
 * and the versioned JSON envelope the CLI prints on stdout. The server handler and the CLI both
 * use these, so they cannot disagree. `schema/envelope.schema.json` describes the envelope. The
 * `explorer-verify/envelope` entry exports them (decision 0055).
 */
import { toBackendName } from "./backend-names.ts";
import { newError } from "./error-hints.ts";
import {
  ERROR_CODES,
  ExplorerVerifyError,
  detailsFromJson,
  docsUrlOf,
  errorJsonOf,
} from "./errors.ts";
import type {
  AnyExplorerVerifyError,
  ErrorCode,
  ErrorJson,
  ErrorJsonFields,
  InputIssue,
} from "./errors.ts";
import { JOB_ID } from "./flow/check-handle.ts";
import { redactSplitHandle, splitHandle } from "./flow/format-handle.ts";
import type { SplitHandle } from "./flow/format-handle.ts";
import { ownKeys, unknownKeys } from "./internal/known-keys.ts";
import { addressDigits, readChainId, readFields } from "./internal/read-fields.ts";
import { REDACTED, redact, redactExcerpt } from "./redact.ts";
import type {
  BackendOutcome,
  DryRunResult,
  LinkProxyResult,
  VerifyEachResult,
  VerifyResult,
} from "./types.ts";

/**
 * The exit codes of the CLI (R-AX-7): 0 verified, 1 failed, 2 invalid input, 3 key problem,
 * 4 still pending, 5 network or explorer unavailable, 6 unknown state or internal error,
 * 130 cancelled.
 *
 * @example
 * ```ts
 * import type { ExitCode } from "explorer-verify/envelope";
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
 * import { ERROR_EXIT_CODES } from "explorer-verify/envelope";
 * import { ExplorerVerifyError } from "explorer-verify/errors";
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
 * What a `verify()` or `checkStatus()` call ends with: the result it returned or the error it
 * threw.
 *
 * @example
 * ```ts
 * import { ExplorerVerifyError } from "explorer-verify";
 * import type { VerifyOutcome } from "explorer-verify/envelope";
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
 * import type { Envelope } from "explorer-verify/envelope";
 *
 * function summary(envelope: Envelope): string {
 *   if (envelope.error !== undefined) {
 *     return `${envelope.error.code}: ${envelope.error.hint}`;
 *   }
 *   return envelope.result.status;
 * }
 * ```
 * @experimental
 */
export type Envelope<R extends EnvelopeResult = EnvelopeResult> =
  | (R extends VerifyEachResult<ExplorerVerifyError | ErrorJson>
      ?
          | {
              /** The envelope schema version. */
              schemaVersion: 1;
              /** Every backend succeeded. */
              ok: true;
              /** Successful results in the requested order. */
              result: {
                /** One successful outcome per entry. */ outcomes: Extract<
                  BackendOutcome<ErrorJson>,
                  Record<"ok", true>
                >[];
              };
              /** Result envelopes carry no top-level error. */
              error?: never;
            }
          | {
              /** The envelope schema version. */
              schemaVersion: 1;
              /** At least one backend failed. */
              ok: false;
              /** All outcomes in the requested order. */
              result: VerifyEachResult<ErrorJson>;
              /** Backend errors are inside the outcomes. */
              error?: never;
            }
      : {
          /** The envelope schema version. */
          schemaVersion: 1;
          /** Whether the result exits successfully. */
          ok: R extends {
            /** Result states that exit unsuccessfully. */ status:
              | "failed"
              | "mismatch"
              | "not-linked";
          }
            ? false
            : true;
          /** The validated result. */
          result: R;
          /** Result envelopes carry no error. */
          error?: never;
        })
  | {
      /** The envelope schema version. */
      schemaVersion: 1;
      /** An error always exits with a nonzero code. */
      ok: false;
      /** The serialized error. */
      error: ErrorJson;
      /** Error envelopes carry no result. */
      result?: never;
    };

/** The result types accepted by the envelope. @inline */
type EnvelopeResult =
  | VerifyResult
  | DryRunResult
  | LinkProxyResult
  | VerifyEachResult<ExplorerVerifyError | ErrorJson>;

/**
 * Options for {@link toEnvelope}.
 *
 * @example
 * ```ts
 * import type { EnvelopeOptions } from "explorer-verify/envelope";
 *
 * const options: EnvelopeOptions = { secrets: [apiKey] };
 * ```
 * @experimental
 */
export interface EnvelopeOptions {
  /**
   * Key values to remove from every string in the envelope, such as the call's API key. Key-like
   * URL and form parameters, bearer tokens and bare Etherscan-style keys are removed without it.
   * `undefined` counts as absent. Any other key of the options throws `invalid-input`.
   */
  secrets?: readonly string[] | undefined;
}

/** Every result status: those of `VerifyResult` and `dry-run`. */
type Status = VerifyResult["status"] | DryRunResult["status"] | LinkProxyResult["status"];

/** A result `toEnvelope` takes: a `VerifyResult` or a `DryRunResult`. */
type AnyResult = VerifyResult | DryRunResult | LinkProxyResult;

// The exit code of each result status (R-AX-7). A status without an entry fails to compile.
const RESULT_EXIT_CODES: Readonly<Record<Status, ExitCode>> = {
  verified: 0,
  "already-verified": 0,
  failed: 1,
  "dry-run": 0,
  linked: 0,
  mismatch: 1,
  "not-linked": 1,
};

const MATCHES = ["exact", "partial"] as const;

// The longest message or hint kept from an error object that another copy or a server built.
const MAX_TEXT = 2_000;

// The name every copy of the package gives its error class.
const ERROR_NAME = "ExplorerVerifyError";

/**
 * {@link splitHandle} for a handle from another copy of the package, whose `toJSON()` this copy
 * did not build. Every field is checked, so no text, such as a key, rides in a field that is not
 * redacted: a known backend, a positive safe integer chain id, `0x` and 40 hex digits, and a job id
 * of the handle charset or the literal `[redacted]`.
 */
function strictHandle(value: unknown): SplitHandle | undefined {
  const handle = splitHandle(value);
  if (handle === undefined) {
    return undefined;
  }
  // The prefix is `ev1:<backend>:<chainId>:<address>:`, with a known backend and a chain id in
  // decimal digits, as splitHandle checks. The job id charset has no `:`, so a valid job id is the
  // fifth field.
  const [, , chainId, address] = handle.prefix.split(":");
  const { jobId } = handle;
  const valid =
    readChainId(Number(chainId)) !== undefined &&
    addressDigits(address) !== undefined &&
    (JOB_ID.test(jobId) || jobId === REDACTED);
  return valid ? handle : undefined;
}

const NOT_AN_OUTCOME =
  "The value is not a VerifyResult, a DryRunResult, a VerifyEachResult, a LinkProxyResult or an ExplorerVerifyError.";
const NOT_AN_OUTCOME_HINT =
  "Pass the result that verify(), checkStatus(), verifyEach() or linkProxy() returned, or the ExplorerVerifyError it threw.";

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
    // Stryker disable next-line ArrayDeclaration: untestable sentinel. The message and the issues name only fields, never Stryker's placeholder text.
    secrets: [],
    hint,
  });
}

/** The status as a key of {@link RESULT_EXIT_CODES}, or `undefined`. */
function statusOf(value: unknown): Status | undefined {
  return value === "verified" ||
    value === "already-verified" ||
    value === "failed" ||
    value === "linked" ||
    value === "mismatch" ||
    value === "not-linked" ||
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
    // Stryker disable next-line ArrayDeclaration: untestable sentinel. An extra secret of Stryker's placeholder text redacts nothing a caller writes.
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
    // Stryker disable next-line ArrayDeclaration: untestable sentinel. An extra secret of Stryker's placeholder text redacts nothing a caller writes.
    return [];
  }
  // The keys first, so a getter on an unknown key never runs (R-IN-6).
  const keys = ownKeys(options);
  const unknown = unknownKeys(keys ?? [], ["secrets"], "", "options");
  if (unknown.length > 0) {
    const names = unknown.map((issue) => issue.field).join(", ");
    throw invalid(unknown, `The options are invalid: ${names}.`, BAD_OPTIONS_HINT);
  }
  const fields = keys === undefined ? undefined : readFields(options);
  if (fields === undefined) {
    throw invalid(
      [{ field: "options", message: "must be an object" }],
      BAD_OPTIONS,
      BAD_OPTIONS_HINT,
    );
  }
  const secrets = fields.get("secrets");
  if (secrets === undefined) {
    // Stryker disable next-line ArrayDeclaration: untestable sentinel. An extra secret of Stryker's placeholder text redacts nothing a caller writes.
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
  const backend =
    toBackendName(fields.get("backend")) ??
    problems.add("outcome.backend", "must be one of BACKEND_NAMES");
  if (status === "linked" || status === "mismatch" || status === "not-linked") {
    return copyLinkResult(fields, status, backend, problems, secrets);
  }
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

/** Validates and redacts the result of linkProxy(). */
function copyLinkResult(
  fields: Map<string, unknown>,
  status: LinkProxyResult["status"],
  backend: BackendOutcome["backend"] | undefined,
  problems: Problems,
  secrets: readonly string[],
): LinkProxyResult {
  if (status === "not-linked") {
    const reason =
      stringOf(fields.get("reason")) ?? problems.add("outcome.reason", "must be a string");
    if (backend === undefined || reason === undefined) throw invalid(problems.issues);
    return { status, backend, reason: redact(reason, secrets) };
  }
  const address = (name: string): `0x${string}` | undefined => {
    const digits = addressDigits(fields.get(name));
    return digits === undefined
      ? problems.add(`outcome.${name}`, "must be 0x followed by 40 hex digits")
      : `0x${redact(digits.toLowerCase(), secrets)}`;
  };
  if (status === "mismatch") {
    const expectedImplementation = address("expectedImplementation");
    const implementation =
      fields.get("implementation") === undefined ? undefined : address("implementation");
    if (
      backend === undefined ||
      expectedImplementation === undefined ||
      (fields.get("implementation") !== undefined && implementation === undefined)
    ) {
      throw invalid(problems.issues);
    }
    return {
      status,
      backend,
      ...(implementation === undefined ? {} : { implementation }),
      expectedImplementation,
    };
  }
  const implementation = address("implementation");
  const verified = fields.get("implementationVerified");
  if (typeof verified !== "boolean")
    problems.add("outcome.implementationVerified", "must be a boolean");
  const explorerUrl = explorerUrlOf(fields, problems);
  if (
    backend === undefined ||
    implementation === undefined ||
    typeof verified !== "boolean" ||
    explorerUrl === null
  ) {
    throw invalid(problems.issues);
  }
  return {
    status,
    backend,
    implementation,
    implementationVerified: verified,
    ...(explorerUrl === undefined ? {} : { explorerUrl: redact(explorerUrl, secrets) }),
  };
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
      return {
        // Stryker disable next-line ArrayDeclaration: untestable sentinel. The mutant passes Stryker's placeholder text to toJSON(), which takes no argument.
        read: (): unknown => Reflect.apply(toJSON, outcome, []),
        foreign: true,
      };
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
  const line = handle === undefined ? undefined : redactSplitHandle(handle, secrets);
  // The details take their handles from the checked top-level fields, never from the details.
  const details = detailsFromJson(code, fields.get("details"), secrets, {
    handle: line,
    handles: handles?.map((each) => each.handle),
    foreign,
  });
  if (details === undefined) {
    throw invalid([
      {
        field: "outcome.details",
        message:
          "must be an object with the error's code and finite numbers, and the error must have a handle when its code needs one",
      },
    ]);
  }
  const json: ErrorJsonFields = {
    // A foreign message or hint is cut; this copy's own keep their full text.
    message: foreign ? redactExcerpt(message, secrets, MAX_TEXT) : redact(message, secrets),
    hint: foreign ? redactExcerpt(hint, secrets, MAX_TEXT) : redact(hint, secrets),
    // Rebuilt from the code: a URL from another copy or a server is never passed on.
    docsUrl: docsUrlOf(code),
    retryable,
  };
  if (line !== undefined) {
    json.handle = line;
  }
  if (handles !== undefined) {
    json.handles = handles;
  }
  return errorJsonOf<ErrorCode>(code, json, details);
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
    const backend = toBackendName(fields?.get("backend"));
    const line = fields?.get("handle");
    const split = foreign ? strictHandle(line) : splitHandle(line);
    // The second field of the prefix names the handle's backend.
    if (backend === undefined || split === undefined || split.prefix.split(":")[1] !== backend) {
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
  // A value that is not an object has no fields, so it has no backend.
  const fields = readFields(item) ?? new Map<string, unknown>();
  const backend = toBackendName(fields.get("backend"));
  const ok = fields.get("ok");
  if (backend === undefined || typeof ok !== "boolean") {
    throw invalid([{ field, message: "must be an object with a known backend and a boolean ok" }]);
  }
  const errorValue = fields.get("error");
  if (errorValue !== undefined) {
    if (fields.get("result") !== undefined) {
      throw invalid([{ field, message: "must not carry both result and error" }]);
    }
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
  if (
    (result.status !== "verified" &&
      result.status !== "already-verified" &&
      result.status !== "failed") ||
    result.backend !== backend
  ) {
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
    outcome.error !== undefined
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
 * import { ExplorerVerifyError } from "explorer-verify";
 * import { exitCodeOf } from "explorer-verify/envelope";
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
    | LinkProxyResult
    | ExplorerVerifyError
    | DryRunResult
    | VerifyEachResult
    | VerifyEachResult<ExplorerVerifyError>
    | VerifyEachResult<ErrorJson>,
): ExitCode {
  // Stryker disable next-line ArrayDeclaration: untestable sentinel. The exit code reads no string, so a secret of Stryker's placeholder text changes nothing.
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
 * import { ExplorerVerifyError } from "explorer-verify";
 * import { toEnvelope } from "explorer-verify/envelope";
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
export function toEnvelope<R extends EnvelopeResult>(
  outcome: R,
  options?: EnvelopeOptions,
): Envelope<R>;
export function toEnvelope(
  outcome:
    | VerifyOutcome
    | ExplorerVerifyError
    | LinkProxyResult
    | DryRunResult
    | VerifyEachResult
    | VerifyEachResult<ExplorerVerifyError>
    | VerifyEachResult<ErrorJson>,
  options?: EnvelopeOptions,
): Envelope;
export function toEnvelope(
  outcome:
    | VerifyOutcome
    | LinkProxyResult
    | ExplorerVerifyError
    | DryRunResult
    | VerifyEachResult
    | VerifyEachResult<ExplorerVerifyError>
    | VerifyEachResult<ErrorJson>,
  options?: EnvelopeOptions,
): Envelope {
  const read = readOutcome(outcome, secretsOf(options));
  if ("each" in read) {
    const outcomes: Extract<BackendOutcome<ErrorJson>, { ok: true }>[] = [];
    for (const each of read.each.outcomes) {
      if (each.ok) outcomes.push(each);
    }
    return outcomes.length === read.each.outcomes.length
      ? { schemaVersion: 1, ok: true, result: { outcomes } }
      : { schemaVersion: 1, ok: false, result: read.each };
  }
  if ("error" in read) {
    return { schemaVersion: 1, ok: false, error: read.error };
  }
  const { result } = read;
  if (result.status === "dry-run") {
    return { schemaVersion: 1, ok: true, result };
  }
  return result.status === "failed" ||
    result.status === "mismatch" ||
    result.status === "not-linked"
    ? { schemaVersion: 1, ok: false, result }
    : { schemaVersion: 1, ok: true, result };
}
