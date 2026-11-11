// References: R-DX-3, R-AX-10, decisions 0044 and 0061.
/**
 * The default fix hint of each error code, apart from the error class so that importing
 * `ExplorerVerifyError` alone, to check a caught error, does not bundle the hint text. Library code
 * builds its errors through {@link newError}, which fills the hint
 * from this table.
 */
import { ExplorerVerifyError } from "./errors.ts";
import type { DetailsOf, ErrorCode, ExplorerVerifyErrorOptions } from "./errors.ts";

// References: R-DX-3.
/**
 * The default `hint` of each error code: one sentence that says what to do next. Errors
 * the library throws carry these unless a more specific hint applies. Pass one as `hint` when you
 * create an `ExplorerVerifyError` yourself. A hint names each value in words, and a field path
 * follows only in parentheses, so it still reads correctly where the error's fields have other
 * names. The hints are for the developer who calls the library; `hintFor(error, "user")` gives
 * one for the people who use your tool.
 *
 * @example
 * ```ts
 * import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
 *
 * const error = new ExplorerVerifyError({ code: "internal-error" }, "Unexpected failure.", {
 *   hint: ERROR_HINTS["internal-error"],
 *   secrets: [],
 * });
 * console.log(error.hint); // "This is a bug in explorer-verify...."
 * ```
 * @experimental
 */
export const ERROR_HINTS: Readonly<Record<ErrorCode, string>> = {
  "invalid-input": "Fix the fields that the issues list (details.issues), then call again.",
  "not-confirmed":
    "Call checkStatus later with the error's handle (details.handle) to continue polling.",
  "unsupported-chain":
    "Check the chain ID, or pick a backend that serves this chain with the route option.",
  network: "Check the network connection and the explorer's status page, then call again.",
  "rate-limited":
    "Wait as long as the explorer asked (details.retryAfterMs), or a few seconds, then call again.",
  timeout: "Call again, or raise timeoutMs. The explorer had not accepted the submission yet.",
  "unexpected-response":
    "Call again later. If the error persists, check the explorer's status page and report the status and the answer (details.status, details.excerpt).",
  "in-progress":
    "Wait for the explorer to finish its current verification of this contract, then call again.",
  "unknown-state":
    "Do not retry automatically. Check the contract on the explorer and report its answer (details.excerpt).",
  "job-not-found":
    "Do not retry automatically. Check the contract on the explorer; if it is not verified, call verify() again.",
  cancelled:
    "The run was cancelled. If the error holds handles (error.handle, error.handles), resume each one with checkStatus instead of submitting again.",
  "incomplete-input":
    "Add what is missing (details.field): a build-info with its input, the full compiler version, the contract as path:Name, or the missing source files (details.candidates).",
  "insufficient-artifact":
    "ABI and bytecode are not enough to verify. Routes left: (1) ask the publisher to ship build-info or metadata; (2) the bytecode-metadata resolver, when the bytecode carries a metadata hash and the metadata is published; (3) the explorer's own matching (Etherscan Similar Match, Sourcify similarity), when an identical contract is already verified.",
  "unsupported-compiler":
    "Use Solidity compiled with solc, or zksolc through Blockscout on ZKsync Era (324) or Sepolia (300). Verify other compilers with their own tooling.",
  "verification-inconclusive":
    "Wait a minute, then call verify() again: it looks the contract up first and submits only when the contract is not verified.",
  "source-mismatch":
    "Pass the source file that the error names (details.path) exactly as it was compiled, byte for byte, line endings included.",
  "missing-api-key":
    "Pass the key in apiKeys under the backend that the error names (details.backend), or as route.apiKey for an explorer on its own host, then call again. Keep the key out of browser code.",
  "api-key-rejected":
    "Check the key on the explorer's account page: it may be mistyped, revoked or issued by another explorer. Pass a valid key, then call again.",
  "quota-exceeded":
    "The key's daily limit is spent. Call again after the explorer resets the limit, or use a key on a plan with a higher limit.",
  "internal-error":
    "This is a bug in explorer-verify. Report it with the command you ran, without your API key.",
  "no-metadata-hash": "Build the input from the build files with buildVerifyInput instead.",
  "metadata-unavailable":
    "The error lists each source tried (details.attempts). Call again later, or pass an ipfsGateway that holds the metadata.",
  "constructor-args-unavailable":
    "Pass constructorArgs, the ABI-encoded arguments, or check creationBytecode against the deployed build.",
  "proxy-link-pending":
    "Call linkProxy() again later with resumeJobId set to the job id (details.jobId): it checks the same link and sends no new request. A call without it sends a new request, which is also safe.",
  "proxy-link-unknown-state":
    "Do not retry automatically. Check the proxy's page on the explorer and report its answer (details.excerpt).",
  "handler-refused":
    "Do not retry. Fix the createVerifyHandler option or the request that the handler's refusal code names (details.handlerCode).",
  "not-indexed":
    "Check the chain and the address (chainId, address). If the contract was just deployed, call again in a minute, or wait longer with indexWaitMs.",
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
