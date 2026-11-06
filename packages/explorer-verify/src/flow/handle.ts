import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import type { Handle } from "../types.ts";
import { SHAPE_ISSUE, checkHandle } from "./check-handle.ts";

export { isHandleString, tryParseHandle } from "./check-handle.ts";
export { formatHandle } from "./format-handle.ts";

/**
 * Reads a handle from untrusted input, such as a command-line argument, a URL parameter, local
 * storage or a request body, and checks every field (R-FLOW-5). It takes the handle object, or
 * the one-line form that `formatHandle` writes, `ev1:<backend>:<chainId>:<address>:<jobId>`,
 * which must split on `:` into exactly five parts; a job id never holds a `:`.
 *
 * Any field it does not know, such as a URL, is rejected, so no host can enter through a handle
 * (R-SEC-2). Error messages name the known fields only and never repeat a value or a field name
 * the input chose. To check a value without catching an error, use `tryParseHandle` or
 * `isHandleString`.
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
 *   // 'ev1:sourcify:11155111:0x…:<jobId>', as formatHandle wrote it.
 *   const handle = parseHandle(stored);
 * }
 * ```
 * @experimental
 */
export function parseHandle(value: unknown): Handle {
  const { handle, issues } = checkHandle(value);
  if (handle === undefined) {
    throw invalid(issues);
  }
  return handle;
}

function invalid(issues: InputIssue[]): ExplorerVerifyError {
  const fields = issues.map((issue) => issue.field).join(", ");
  // A value in neither form gives SHAPE_ISSUE alone; the message then names the two forms.
  const forms = issues[0] === SHAPE_ISSUE ? ` It ${SHAPE_ISSUE.message}.` : "";
  return newError({ code: "invalid-input", issues }, `The handle is invalid: ${fields}.${forms}`, {
    hint: "Pass the handle object or its one-line form, as verify() or a not-confirmed error returned it.",
    // Stryker disable next-line ArrayDeclaration: untestable sentinel. The message names only fields, never Stryker's placeholder text.
    secrets: [],
  });
}
