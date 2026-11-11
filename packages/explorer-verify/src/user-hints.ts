// References: R-DX-3, R-AX-10, decision 0061.
/**
 * Hints for the people who use a tool built on explorer-verify, such as an IDE, a dapp or a
 * verification service, apart from the error class and the default hints, so that a bundle that
 * does not import {@link hintFor} holds none of this text.
 */
import type { ErrorCode, ErrorDetails, ErrorDetailsJson } from "./errors.ts";
import { NOT_INDEXED_ANSWER } from "./not-indexed.ts";

/**
 * The end-user hint of each code. No entry names a function, an option, a field or a CLI command,
 * and none holds a parenthesis: a person who cannot change the tool's code can act on it.
 */
const USER_HINTS: Readonly<Record<ErrorCode, string>> = {
  "invalid-input":
    "The verification request is not valid. Check the contract, the chain and the address, then try again; if it keeps failing, report the error to the tool's maintainer.",
  "not-confirmed":
    "The explorer is still verifying the contract. Check the contract's page on the explorer in a few minutes; there is no need to submit it again.",
  "unsupported-chain":
    "This explorer does not support this chain. Check the chain, or pick another explorer.",
  network:
    "The explorer could not be reached. Check the network connection and the explorer's status page, then try again.",
  "rate-limited": "The explorer is limiting requests. Wait a few seconds, then try again.",
  timeout: "The explorer did not accept the submission in time. Try again.",
  "unexpected-response":
    "The explorer gave an answer that could not be read. Try again later; if it keeps failing, check the explorer's status page.",
  "in-progress":
    "The explorer is already verifying this contract. Wait for it to finish, then check the contract's page on the explorer.",
  "unknown-state":
    "The explorer gave a final answer that could not be read. Check the contract's page on the explorer before you try again.",
  "job-not-found":
    "The explorer no longer knows this verification. Check the contract's page on the explorer; if the contract is not verified, start a new verification.",
  cancelled: "The verification was cancelled before the explorer accepted it. Try again.",
  "incomplete-input":
    "The build output lacks something the explorer needs: the compiler input, the full compiler version, the choice of contract or some source files. Compile the project again and pick the contract, then try again.",
  "insufficient-artifact":
    "The build output holds only the ABI and the bytecode, which is not enough for verification. Use the full build output of the compiler.",
  "unsupported-compiler":
    "This contract was built with a compiler or language that cannot be verified here. Use Solidity built with solc, or with zksolc on ZKsync Era or ZKsync Sepolia through Blockscout.",
  "verification-inconclusive":
    "The explorer ended the verification without a verdict. Wait a minute, then try again.",
  "source-mismatch":
    "A source file differs from the one the contract was compiled from. Use the exact source files of the deployed build.",
  "missing-api-key":
    "The explorer needs an API key and none is set. Add a key for this explorer in the tool's settings, or ask the tool's maintainer to set one.",
  "api-key-rejected":
    "The explorer refused the API key. Check the key: it may be mistyped, revoked or issued by another explorer.",
  "quota-exceeded":
    "The API key has used up its daily limit. Try again after the explorer resets it, or use a key with a higher limit.",
  "internal-error":
    "Something went wrong inside the tool. Report it to the tool's maintainer, without your API key.",
  "no-metadata-hash":
    "The deployed bytecode does not say where its source is published, so the source cannot be found from the address alone. Use the build output instead.",
  "metadata-unavailable":
    "The contract's published metadata could not be fetched. Try again later.",
  "constructor-args-unavailable":
    "The build does not match the creation code of the deployed contract, so its constructor arguments cannot be read. Use the build output of the deployed contract, or enter the constructor arguments.",
  "proxy-link-pending":
    "The explorer has not finished linking the proxy. Try again later; repeating the request is safe.",
  "proxy-link-unknown-state":
    "The explorer gave an answer about the proxy that could not be read. Check the proxy's page on the explorer before you try again.",
  "handler-refused":
    "The verification server refused the request. Report it to the tool's maintainer; trying again will not help.",
};

/** The end-user hint of a code that is not in this copy's catalogue, such as one from a newer copy. */
const UNKNOWN_CODE =
  "The verification failed. Try again later; if it keeps failing, report the error to the tool's maintainer.";

/** The longest wait the end-user hint names: one hour. A longer one reads "later". */
const MAX_WAIT_MS = 3_600_000;

/** From this wait on, the end-user hint names minutes instead of seconds. */
const MINUTES_FROM_MS = 120_000;

/**
 * A property of `value`, or `undefined` when `value` is not an object or reading it throws, as a
 * throwing getter or a revoked `Proxy` does. `hintFor` reads every field through this, so it never
 * throws.
 */
function read(value: unknown, key: string): unknown {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

/** The wait in words, or `undefined` when there is no usable wait. */
function waitText(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  if (ms > MAX_WAIT_MS) {
    return "later";
  }
  if (ms >= MINUTES_FROM_MS) {
    return `${String(Math.ceil(ms / 60_000))} minutes`;
  }
  const whole = Math.ceil(ms / 1_000);
  return whole === 1 ? "1 second" : `${String(whole)} seconds`;
}

/** Whether a cancelled error holds a handle: a non-empty one-line form, a handle object or a non-empty list. */
function holdsHandle(details: unknown): boolean {
  const handle = read(details, "handle");
  const accepted =
    typeof handle === "string" ? handle !== "" : read(handle, "backend") !== undefined;
  const count = read(read(details, "handles"), "length");
  return accepted || (typeof count === "number" && count > 0);
}

/** The end-user hint, from the code and what its details say. Never throws. */
function userHint(details: unknown): string {
  const code = read(details, "code");
  if (typeof code !== "string" || !Object.hasOwn(USER_HINTS, code)) {
    return UNKNOWN_CODE;
  }
  if (code === "rate-limited") {
    const wait = waitText(read(details, "retryAfterMs"));
    if (wait === "later") {
      return "The explorer is limiting requests. Try again later.";
    }
    if (wait !== undefined) {
      return `The explorer is limiting requests. Wait ${wait}, then try again.`;
    }
  }
  const excerpt = read(details, "excerpt");
  if (
    code === "unexpected-response" &&
    typeof excerpt === "string" &&
    excerpt.includes(NOT_INDEXED_ANSWER)
  ) {
    return "The explorer has not found the contract at this address yet. Check the chain and the address; if the contract was deployed moments ago, try again in a minute.";
  }
  if (code === "cancelled" && holdsHandle(details)) {
    return "The verification was cancelled after the explorer accepted it. Check the contract's page on the explorer before you submit it again.";
  }
  const hint: unknown = Reflect.get(USER_HINTS, code);
  return typeof hint === "string" ? hint : UNKNOWN_CODE;
}

// References: R-DX-3, R-AX-10.
/**
 * The hint of an error for one audience. `"developer"` is `error.hint`, which names the library's
 * functions, options and error fields. `"user"` is for the people who use your tool, such as an
 * IDE, a dapp or a verification service: it names no function, option, field or command, and
 * reads the error's details, such as the wait the explorer asked for. Pass the error, or its JSON
 * form from `toJSON()` or an envelope. It never throws: a value without a known code, or whose
 * fields cannot be read, gets a general hint, and so does a developer hint that is not a string.
 *
 * @param error - The error, or its JSON form.
 * @param audience - `"developer"`, for code that calls explorer-verify, or `"user"`, for the
 *   people who use your tool. Any value other than `"developer"` gives the user hint.
 * @returns One or two sentences that say what to do next.
 * @example
 * ```ts
 * import { ExplorerVerifyError, hintFor } from "explorer-verify/errors";
 *
 * const error = new ExplorerVerifyError(
 *   { code: "rate-limited", backend: "etherscan-v2", retryAfterMs: 3_000 },
 *   "Etherscan limited the requests.",
 *   { secrets: [] },
 * );
 * console.log(hintFor(error, "user")); // "The explorer is limiting requests. Wait 3 seconds, then try again."
 * ```
 * @experimental
 */
export function hintFor(
  error: { readonly hint: string; readonly details: ErrorDetails | ErrorDetailsJson },
  audience: "developer" | "user",
): string {
  if (audience !== "developer") {
    return userHint(read(error, "details"));
  }
  const hint = read(error, "hint");
  return typeof hint === "string" ? hint : UNKNOWN_CODE;
}
