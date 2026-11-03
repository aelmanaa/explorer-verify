import { redact, redactJobId } from "../redact.ts";
import type { Handle } from "../types.ts";

// The fields of a handle in its one-line form before the job id: `ev1:<backend>:<chainId>:<address>`.
const HANDLE_PREFIX_FIELDS = 4;

/**
 * Writes a handle on one line, as `ev1:<backend>:<chainId>:<address>:<jobId>`. The CLI prints this
 * form and the `error` object of its JSON output carries it (R-AX-5).
 *
 * @param handle - A handle from `verify()` or `parseHandle`.
 * @returns The one-line form.
 */
export function formatHandle(handle: Handle): string {
  return `ev${String(handle.version)}:${handle.backend}:${String(handle.chainId)}:${handle.address}:${handle.jobId}`;
}

/**
 * A handle in its one-line form split into `ev1:<backend>:<chainId>:<address>:` and the job id,
 * which may hold any character. `undefined` when `value` is not in that form.
 *
 * @param value - Any value.
 * @returns The prefix, with its last `:`, and the job id.
 */
export function splitHandle(value: unknown): { prefix: string; jobId: string } | undefined {
  if (typeof value !== "string" || !value.startsWith("ev1:")) {
    return undefined;
  }
  // Lenient on purpose: this only finds the job id to redact in text that may hold any job id,
  // even one with a `:`. parseHandle, which decides what a valid handle is, demands five parts.
  const fields = value.split(":");
  if (fields.length <= HANDLE_PREFIX_FIELDS) {
    return undefined;
  }
  const prefix = `${fields.slice(0, HANDLE_PREFIX_FIELDS).join(":")}:`;
  return { prefix, jobId: value.slice(prefix.length) };
}

/**
 * A split one-line handle with its job id redacted by {@link redactJobId}, so a job id shaped like
 * a key still resumes (R-SEC-1). The envelope, the errors and the `verify.submitted` event share
 * this rule.
 *
 * @param handle - The prefix and job id from {@link splitHandle}.
 * @param secrets - Key values to remove.
 * @returns The one-line handle.
 */
export function redactSplitHandle(
  handle: { prefix: string; jobId: string },
  secrets: readonly string[],
): string {
  return `${handle.prefix}${redactJobId(handle.jobId, secrets)}`;
}

/**
 * A one-line handle with only its job id redacted. Text that is not a one-line handle is
 * redacted whole with {@link redact}.
 *
 * @param line - The one-line form, as {@link formatHandle} writes it.
 * @param secrets - Key values to remove.
 * @returns The redacted line.
 */
export function redactHandleLine(line: string, secrets: readonly string[]): string {
  const handle = splitHandle(line);
  return handle === undefined ? redact(line, secrets) : redactSplitHandle(handle, secrets);
}
