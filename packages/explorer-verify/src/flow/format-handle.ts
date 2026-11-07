import { toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import { redact, redactJobId } from "../redact.ts";
import type { Handle, HandleString, Hex } from "../types.ts";

// The fields of a handle in its one-line form before the job id: `ev1:<backend>:<chainId>:<address>`.
const HANDLE_PREFIX_FIELDS = 4;

/**
 * A one-line handle split before its job id: the prefix keeps its last `:`. The chain id is as
 * JavaScript writes the number, possibly `NaN` for a handle built by untyped code.
 */
export interface SplitHandle {
  prefix: `ev1:${BackendName}:${number}:${Hex}:`;
  jobId: string;
}

// References: R-AX-5.
/**
 * Writes a handle on one line, as `ev1:<backend>:<chainId>:<address>:<jobId>`. The CLI prints this
 * form and the `error` object of its JSON output carries it.
 *
 * @param handle - A handle from `verify()` or `parseHandle`.
 * @returns The one-line form.
 */
export function formatHandle(handle: Handle): HandleString {
  return `ev${handle.version}:${handle.backend}:${handle.chainId}:${handle.address}:${handle.jobId}`;
}

/**
 * A handle in its one-line form split into `ev1:<backend>:<chainId>:<address>:` and the job id,
 * which may hold any character. `undefined` when `value` is not in that form: the prefix must be
 * `ev1`, a known backend, a chain id as JavaScript writes the number (possibly `NaN` for a handle
 * built by untyped code), and `0x` with anything after it.
 *
 * @param value - Any value.
 * @returns The prefix, with its last `:`, and the job id.
 */
export function splitHandle(value: unknown): SplitHandle | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // Lenient on purpose: this only finds the job id to redact in text that may hold any job id,
  // even one with a `:`. parseHandle, which decides what a valid handle is, demands five parts.
  const fields = value.split(":");
  const [version, name, chain] = fields;
  const address = fields[3] ?? "";
  const backend = toBackendName(name);
  const chainId = Number(chain);
  if (
    fields.length <= HANDLE_PREFIX_FIELDS ||
    version !== "ev1" ||
    backend === undefined ||
    String(chainId) !== chain ||
    !address.startsWith("0x")
  ) {
    return undefined;
  }
  const prefix: SplitHandle["prefix"] = `ev1:${backend}:${chainId}:0x${address.slice(2)}:`;
  return { prefix, jobId: value.slice(prefix.length) };
}

// References: R-SEC-1.
/**
 * A split one-line handle with its job id redacted by {@link redactJobId}, so a job id shaped like
 * a key still resumes. The envelope, the errors and the `verify.submitted` event share
 * this rule.
 *
 * @param handle - The prefix and job id from {@link splitHandle}.
 * @param secrets - Key values to remove.
 * @returns The one-line handle.
 */
export function redactSplitHandle(handle: SplitHandle, secrets: readonly string[]): HandleString {
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
