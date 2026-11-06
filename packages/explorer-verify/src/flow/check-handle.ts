/**
 * The checks behind `parseHandle`, `tryParseHandle` and `isHandleString` (R-FLOW-5, R-SEC-2). This
 * module imports no error code, so the two checks that do not throw stay small in a bundle.
 */
import { toBackendName } from "../backend-names.ts";
import type { InputIssue } from "../errors.ts";
import { addressDigits, readChainId, readFields } from "../internal/read-fields.ts";
import type { Handle, HandleString, Hex } from "../types.ts";

const FIELDS: readonly string[] = ["version", "backend", "chainId", "address", "jobId"];
// No `:`, `.`, `/`, `%`, `?`, `#` or `\`: a job id can never parse as a URL scheme or a path
// segment when a client puts it in a request URL, and the one-line form splits on `:`.
export const JOB_ID: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// The fields of the one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`.
const LINE_FIELDS = 5;
// Longer than any valid line: "ev1", the longest backend name, a 16-digit chain id, an address, a
// 128-character job id and four separators come to under 256 characters.
const MAX_LINE_LENGTH = 512;
const LINE_VERSION = "ev1";
// A chain id in the one-line form: decimal digits without a leading zero.
const DECIMAL = /^[1-9][0-9]{0,15}$/;

/** The issue of a value in neither form. Shared, so `parseHandle` can recognise it. */
export const SHAPE_ISSUE: Readonly<InputIssue> = {
  field: "handle",
  message: "must be a handle object or its one-line form ev1:<backend>:<chainId>:<address>:<jobId>",
};

/** A checked handle, or the issues of each bad field. */
export type HandleCheck =
  | { readonly handle: Handle; readonly issues?: undefined }
  | { readonly handle?: undefined; readonly issues: InputIssue[] };

/**
 * Reads and checks a handle in either form: the handle object or its one-line form. Any field it
 * does not know, such as a URL, is an issue (R-SEC-2). Issue messages name the known fields only
 * and never repeat a value.
 *
 * @param value - Any value.
 * @returns The new handle, or the issues.
 */
export function checkHandle(value: unknown): HandleCheck {
  return typeof value === "string"
    ? checkFields(lineFields(value), "must be 1 (ev1 in the one-line form)")
    : checkFields(readFields(value), "must be 1");
}

/**
 * Reads a handle in either form, as `parseHandle` does, and returns `undefined` for a value
 * that `parseHandle` rejects. It never throws and loads none of the error code, so a page can
 * check a stored value cheaply (R-FLOW-5).
 *
 * @param value - The handle object or its one-line form, from untrusted input.
 * @returns A new handle with exactly the fields of {@link Handle}, or `undefined`.
 * @example
 * ```ts
 * import { tryParseHandle } from "explorer-verify";
 *
 * const handle = tryParseHandle(localStorage.getItem("pending-verification"));
 * if (handle === undefined) {
 *   localStorage.removeItem("pending-verification");
 * }
 * ```
 * @experimental
 */
export function tryParseHandle(value: unknown): Handle | undefined {
  return checkHandle(value).handle;
}

/**
 * Whether `value` is a valid handle in its one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`,
 * the form `formatHandle` writes. A handle object gives `false`: read it with `tryParseHandle`.
 * A handle whose job id was redacted, such as `…:[redacted]`, gives `false` too. It never throws
 * (R-FLOW-5).
 *
 * @param value - Any value.
 * @returns `true` when `parseHandle` would accept the string, which TypeScript then types as
 *   {@link HandleString}.
 * @example
 * ```ts
 * import { checkStatus, isHandleString } from "explorer-verify";
 *
 * const stored = localStorage.getItem("pending-verification");
 * if (isHandleString(stored)) {
 *   await checkStatus(stored);
 * }
 * ```
 * @experimental
 */
export function isHandleString(value: unknown): value is HandleString {
  // A string is read only as the one-line form, so a string that parses is in that form.
  return typeof value === "string" && tryParseHandle(value) !== undefined;
}

/**
 * The fields of a one-line handle, with the version and chain id as numbers when they are well
 * formed, so {@link checkFields} checks both forms the same way. `undefined` when the line does
 * not split into five parts.
 */
function lineFields(line: string): Map<string, unknown> | undefined {
  if (line.length > MAX_LINE_LENGTH) {
    return undefined;
  }
  const parts = line.split(":");
  const [version, backend, chainId, address, jobId] = parts;
  if (parts.length !== LINE_FIELDS) {
    return undefined;
  }
  return new Map<string, unknown>([
    ["version", version === LINE_VERSION ? 1 : version],
    ["backend", backend],
    ["chainId", DECIMAL.test(String(chainId)) ? Number(chainId) : chainId],
    ["address", address],
    ["jobId", jobId],
  ]);
}

/** Checks the fields of a handle in either form and builds a new handle from them. */
function checkFields(
  fields: ReadonlyMap<string, unknown> | undefined,
  versionMessage: string,
): HandleCheck {
  if (fields === undefined) {
    return { issues: [SHAPE_ISSUE] };
  }
  const issues: InputIssue[] = [];

  const version = fields.get("version") === 1 ? 1 : undefined;
  if (version === undefined) {
    issues.push({ field: "version", message: versionMessage });
  }
  const backend = toBackendName(fields.get("backend"));
  if (backend === undefined) {
    issues.push({ field: "backend", message: "must name a known backend" });
  }
  const chainId = readChainId(fields.get("chainId"));
  if (chainId === undefined) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }
  const digits = addressDigits(fields.get("address"));
  const address: Hex | undefined = digits === undefined ? undefined : `0x${digits}`;
  if (address === undefined) {
    issues.push({ field: "address", message: "must be 0x followed by 40 hex digits" });
  }
  const rawJobId = fields.get("jobId");
  const jobId = typeof rawJobId === "string" && JOB_ID.test(rawJobId) ? rawJobId : undefined;
  if (jobId === undefined) {
    issues.push({
      field: "jobId",
      message:
        "must be 1 to 128 characters from A-Z, a-z, 0-9, '_' and '-', starting with a letter or digit",
    });
  }
  let unknown = 0;
  for (const name of fields.keys()) {
    if (!FIELDS.includes(name)) {
      unknown++;
    }
  }
  if (unknown > 0) {
    issues.push({
      field: "handle",
      message:
        unknown === 1
          ? "has 1 field that is not a handle field"
          : `has ${String(unknown)} fields that are not handle fields`,
    });
  }

  // Each field and the unknown count are checked once more, so the handle is built only from
  // defined fields; `issues` then lists every problem these checks found.
  if (
    version !== undefined &&
    backend !== undefined &&
    chainId !== undefined &&
    address !== undefined &&
    jobId !== undefined &&
    unknown === 0
  ) {
    return { handle: { version, backend, chainId, address, jobId } };
  }
  return { issues };
}
