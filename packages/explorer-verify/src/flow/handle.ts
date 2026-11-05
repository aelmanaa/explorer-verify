import { toBackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import { addressDigits, readChainId, readFields } from "../internal/read-fields.ts";
import type { Handle, Hex } from "../types.ts";

export { formatHandle } from "./format-handle.ts";

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
const SHAPE_MESSAGE =
  "must be a handle object or its one-line form ev1:<backend>:<chainId>:<address>:<jobId>";

/**
 * Reads a handle from untrusted input, such as a command-line argument, a URL parameter, local
 * storage or a request body, and checks every field (R-FLOW-5). It takes the handle object, for
 * example `JSON.parse` of a stored handle, or the one-line form that `formatHandle` writes,
 * `ev1:<backend>:<chainId>:<address>:<jobId>`. The one-line form must split on `:` into exactly
 * five parts; a job id never holds a `:`.
 *
 * Any field it does not know, such as a URL, is rejected, so no host can enter through a handle
 * (R-SEC-2). Error messages name the known fields only and never repeat a value or a field name
 * the input chose.
 *
 * @param value - The handle object, or its one-line form.
 * @returns A new handle with exactly the fields of {@link Handle}. The address keeps its case.
 * @throws ExplorerVerifyError with code `invalid-input`, listing each bad field in `details.issues`.
 * @example
 * ```ts
 * import { parseHandle } from "explorer-verify";
 *
 * const stored = localStorage.getItem("pending-verification");
 * if (stored !== null) {
 *   // Either form: '{"version":1,...}' after JSON.parse, or 'ev1:sourcify:11155111:0x…:<jobId>'.
 *   const handle = parseHandle(stored.startsWith("ev1:") ? stored : JSON.parse(stored));
 * }
 * ```
 * @experimental
 */
export function parseHandle(value: unknown): Handle {
  const line = typeof value === "string";
  const fields = line ? lineFields(value) : readFields(value);
  if (fields === undefined) {
    throw invalid([{ field: "handle", message: SHAPE_MESSAGE }]);
  }
  return checkFields(fields, line ? "must be 1 (ev1 in the one-line form)" : "must be 1");
}

/**
 * The fields of a one-line handle, with the version and chain id as numbers when they are well
 * formed, so {@link checkFields} checks both forms the same way. `undefined` when the line does not
 * split into five parts.
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
    ["chainId", chainId !== undefined && DECIMAL.test(chainId) ? Number(chainId) : chainId],
    ["address", address],
    ["jobId", jobId],
  ]);
}

/** Checks the fields of a handle in either form and builds a new handle from them. */
function checkFields(fields: ReadonlyMap<string, unknown>, versionMessage: string): Handle {
  const issues: InputIssue[] = [];

  const version = fields.get("version") === 1 ? 1 : undefined;
  if (version === undefined) {
    issues.push({ field: "version", message: versionMessage });
  }
  const rawBackend = fields.get("backend");
  const backend = typeof rawBackend === "string" ? toBackendName(rawBackend) : undefined;
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

  if (
    issues.length > 0 ||
    version === undefined ||
    backend === undefined ||
    chainId === undefined ||
    address === undefined ||
    jobId === undefined
  ) {
    throw invalid(issues);
  }
  return { version, backend, chainId, address, jobId };
}

function invalid(issues: InputIssue[]): ExplorerVerifyError {
  const fields = issues.map((issue) => issue.field).join(", ");
  return newError({ code: "invalid-input", issues }, `The handle is invalid: ${fields}.`, {
    hint: "Pass the handle exactly as verify() or a not-confirmed error returned it.",
    secrets: [],
  });
}
