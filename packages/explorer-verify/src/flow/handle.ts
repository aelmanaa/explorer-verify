import { toBackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import type { Handle, Hex } from "../types.ts";

const FIELDS: readonly string[] = ["version", "backend", "chainId", "address", "jobId"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// No `:`, `.`, `/`, `%`, `?`, `#` or `\`: a job id can never parse as a URL scheme or a path
// segment when a client puts it in a request URL, and the one-line form splits on `:`.
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Own enumerable fields of `value`, or `undefined` when reading them throws (a hostile Proxy). */
function readFields(value: object): Map<string, unknown> | undefined {
  try {
    if (Array.isArray(value)) {
      return undefined;
    }
    return new Map<string, unknown>(Object.entries(value));
  } catch {
    return undefined;
  }
}

/**
 * Reads a handle from untrusted input, such as a URL parameter, local storage or a request body,
 * and checks every field (R-FLOW-5). Any field it does not know, such as a URL, is rejected, so no
 * host can enter through a handle (R-SEC-2). Error messages name the known fields only and never
 * repeat a value or a field name the input chose.
 *
 * @param value - The handle object, for example `JSON.parse` of a stored handle.
 * @returns A new handle with exactly the fields of {@link Handle}.
 * @throws ExplorerVerifyError with code `invalid-input`, listing each bad field in `details.issues`.
 * @example
 * ```ts
 * import { parseHandle } from "explorer-verify";
 *
 * const stored = localStorage.getItem("pending-verification");
 * if (stored !== null) {
 *   const handle = parseHandle(JSON.parse(stored));
 * }
 * ```
 * @experimental
 */
export function parseHandle(value: unknown): Handle {
  const fields = typeof value === "object" && value !== null ? readFields(value) : undefined;
  if (fields === undefined) {
    throw invalid([{ field: "handle", message: "must be a plain object" }]);
  }
  const issues: InputIssue[] = [];

  const version = fields.get("version") === 1 ? 1 : undefined;
  if (version === undefined) {
    issues.push({ field: "version", message: "must be 1" });
  }
  const rawBackend = fields.get("backend");
  const backend = typeof rawBackend === "string" ? toBackendName(rawBackend) : undefined;
  if (backend === undefined) {
    issues.push({ field: "backend", message: "must name a known backend" });
  }
  const rawChainId = fields.get("chainId");
  const chainId =
    typeof rawChainId === "number" && Number.isSafeInteger(rawChainId) && rawChainId > 0
      ? rawChainId
      : undefined;
  if (chainId === undefined) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }
  const rawAddress = fields.get("address");
  const address: Hex | undefined =
    typeof rawAddress === "string" && ADDRESS.test(rawAddress)
      ? `0x${rawAddress.slice(2)}`
      : undefined;
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
      message: `has ${String(unknown)} fields that are not handle fields`,
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
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The handle is invalid: ${fields}.`,
    { hint: "Pass the handle exactly as verify() or a not-confirmed error returned it." },
  );
}
