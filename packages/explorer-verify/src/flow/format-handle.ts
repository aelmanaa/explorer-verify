import type { Handle } from "../types.ts";

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
