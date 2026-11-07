/**
 * The default fix hint of each error code (R-DX-3), apart from the error class so that importing
 * `ExplorerVerifyError` alone, to check a caught error, does not bundle the hint text
 * (decision 0044). Library code builds its errors through {@link newError}, which fills the hint
 * from this table.
 */
import { ExplorerVerifyError } from "./errors.ts";
import type { DetailsOf, ErrorCode, ExplorerVerifyErrorOptions } from "./errors.ts";

/**
 * The default `hint` of each error code: one sentence that says what to do next (R-DX-3). Errors
 * the library throws carry these unless a more specific hint applies. Pass one as `hint` when you
 * create an `ExplorerVerifyError` yourself.
 *
 * @example
 * ```ts
 * import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
 *
 * const error = new ExplorerVerifyError({ code: "internal-error" }, "Unexpected failure.", {
 *   hint: ERROR_HINTS["internal-error"],
 *   secrets: [],
 * });
 * console.log(error.hint); // "This is a bug in explorer-verify. ..."
 * ```
 * @experimental
 */
export const ERROR_HINTS: Readonly<Record<ErrorCode, string>> = {
  "invalid-input": "Fix the fields listed in details.issues, then call again.",
  "not-confirmed": "Call checkStatus with details.handle later to continue polling.",
  "unsupported-chain":
    "Check the chain ID, or pick a backend that serves this chain with the route option.",
  network: "Check the network connection and the explorer's status page, then call again.",
  "rate-limited":
    "Wait details.retryAfterMs, or a few seconds when it is not set, then call again.",
  timeout: "Call again, or raise timeoutMs. The explorer had not accepted the submission yet.",
  "unexpected-response":
    "Call again later. If the error persists, check the explorer's status page and report details.status and details.excerpt.",
  "in-progress":
    "Wait for the explorer to finish its current verification of this contract, then call again.",
  "unknown-state":
    "Do not retry automatically. Check the contract on the explorer and report details.excerpt.",
  "job-not-found":
    "Do not retry automatically. Check the contract on the explorer; if it is not verified, call verify() again.",
  cancelled:
    "The run was cancelled. If error.handle or error.handles is set, resume each handle with explorer-verify status instead of submitting again.",
  "incomplete-input":
    "Add what details.field names: a build-info with its input, the full compiler version, the contract as path:Name, or the source files listed in details.candidates.",
  "insufficient-artifact":
    "ABI and bytecode are not enough to verify. Routes left: (1) ask the publisher to ship build-info or metadata; (2) the bytecode-metadata resolver, when the bytecode carries a metadata hash and the metadata is published; (3) the explorer's own matching (Etherscan Similar Match, Sourcify similarity), when an identical contract is already verified.",
  "unsupported-compiler":
    "Use Solidity compiled with solc, or zksolc through Blockscout on ZKsync Era (324) or Sepolia (300). Verify other compilers with their own tooling.",
  "verification-inconclusive":
    "Wait a minute, then call verify() again: it looks the contract up first and submits only when the contract is not verified.",
  "source-mismatch":
    "Pass the source file named in details.path exactly as it was compiled, byte for byte, line endings included.",
  "missing-api-key":
    "Pass the key in apiKeys under the backend named in details.backend, or as route.apiKey for an explorer on its own host, then call again. Keep the key out of browser code.",
  "api-key-rejected":
    "Check the key on the explorer's account page: it may be mistyped, revoked or issued by another explorer. Pass a valid key, then call again.",
  "quota-exceeded":
    "The key's daily limit is spent. Call again after the explorer resets the limit, or use a key on a plan with a higher limit.",
  "internal-error":
    "This is a bug in explorer-verify. Report it with the command you ran, without your API key.",
  "no-metadata-hash": "Build the input from the build files with buildVerifyInput instead.",
  "metadata-unavailable":
    "Read details.attempts. Call again later, or pass an ipfsGateway that holds the metadata.",
  "constructor-args-unavailable":
    "Pass constructorArgs, the ABI-encoded arguments, or check creationBytecode against the deployed build.",
  "proxy-link-pending":
    "Call linkProxy() again later: the explorer had not finished linking the proxy. A new call is safe.",
  "proxy-link-unknown-state":
    "Do not retry automatically. Check the proxy's page on the explorer and report details.excerpt.",
  "handler-refused":
    "Do not retry. Fix the createVerifyHandler option or the request that details.handlerCode names.",
};

/**
 * A new `ExplorerVerifyError` with the code's default hint from {@link ERROR_HINTS} when
 * `options.hint` is missing or blank. Every error the library throws is built here.
 *
 * @param details - The code and its data.
 * @param message - What went wrong.
 * @param options - The key values to redact, and optionally a specific hint and the cause.
 * @returns The error, redacted by its constructor.
 */
export function newError<C extends ErrorCode>(
  details: DetailsOf<C> & { code: C },
  message: string,
  options: ExplorerVerifyErrorOptions,
): ExplorerVerifyError<C> {
  const hint =
    options.hint !== undefined && options.hint.trim() !== ""
      ? options.hint
      : ERROR_HINTS[details.code];
  return new ExplorerVerifyError<C>(details, message, { ...options, hint });
}
