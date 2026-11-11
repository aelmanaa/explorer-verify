// One error object for every code, as the envelope holds it, with placeholders where the CLI fills
// in a value: the address and job id of a handle, `<path>` and `<names>`. The error pages show the CLI hint of these, and
// the hint tests run every code through the CLI renderer with them. A new code fails to compile
// until it has an entry.
import { ERROR_HINTS } from "explorer-verify";
import type { DetailsJsonOf, ErrorCode, ErrorJson, HandleString } from "explorer-verify";

// A handle with placeholders for its address and job id.
const PLACEHOLDER: HandleString = "ev1:sourcify:11155111:0x<address>:<job>";

const DETAILS: { readonly [C in ErrorCode]: DetailsJsonOf<C> } = {
  "invalid-input": {
    code: "invalid-input",
    issues: [{ field: "address", message: "must be 0x followed by 40 hex digits" }],
  },
  "not-confirmed": { code: "not-confirmed", handle: PLACEHOLDER },
  "unsupported-chain": { code: "unsupported-chain", chainId: 999_999, backend: "sourcify" },
  network: { code: "network", backend: "sourcify", attempts: 3 },
  "rate-limited": { code: "rate-limited", backend: "sourcify" },
  timeout: { code: "timeout", backend: "sourcify", timeoutMs: 120_000 },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 502,
    excerpt: "Bad gateway",
  },
  "in-progress": { code: "in-progress", backend: "sourcify" },
  "unknown-state": { code: "unknown-state", handle: PLACEHOLDER, excerpt: "weird" },
  "job-not-found": { code: "job-not-found", handle: PLACEHOLDER },
  cancelled: { code: "cancelled", handle: PLACEHOLDER },
  "incomplete-input": { code: "incomplete-input", field: "contract", candidates: ["<names>"] },
  "insufficient-artifact": { code: "insufficient-artifact", field: "input" },
  "unsupported-compiler": { code: "unsupported-compiler", field: "compilerType" },
  "verification-inconclusive": {
    code: "verification-inconclusive",
    backend: "sourcify",
    reason: "internal_error",
  },
  "source-mismatch": {
    code: "source-mismatch",
    path: "<path>",
    expected: `0x${"a".repeat(64)}`,
    actual: `0x${"b".repeat(64)}`,
  },
  "missing-api-key": { code: "missing-api-key", backend: "etherscan-v2" },
  "api-key-rejected": { code: "api-key-rejected", backend: "etherscan-v2" },
  "quota-exceeded": { code: "quota-exceeded", backend: "etherscan-v2" },
  "internal-error": { code: "internal-error" },
  "no-metadata-hash": { code: "no-metadata-hash", found: "version-only" },
  "metadata-unavailable": { code: "metadata-unavailable", hash: "", attempts: [] },
  "constructor-args-unavailable": {
    code: "constructor-args-unavailable",
    reason: "prefix-mismatch",
  },
  "proxy-link-pending": { code: "proxy-link-pending", backend: "etherscan-v2" },
  "proxy-link-unknown-state": {
    code: "proxy-link-unknown-state",
    backend: "etherscan-v2",
    excerpt: "Error!",
  },
  "handler-refused": {
    code: "handler-refused",
    backend: "etherscan-v2",
    status: 403,
    excerpt: "Forbidden",
    handlerCode: "<handler code>",
  },
  "not-indexed": { code: "not-indexed", backend: "etherscan-v2", submits: 10, elapsedMs: 27_000 },
};

/**
 * The error object of `code` with the library's default hint, as `toEnvelope()` gives it.
 *
 * @param code - The error code.
 * @returns The error object.
 */
export function sampleError(code: ErrorCode): ErrorJson {
  const details: DetailsJsonOf<ErrorCode> = DETAILS[code];
  const handle = "handle" in details ? details.handle : undefined;
  return make<ErrorCode>(code, details, handle);
}

/** The error object of `details`, with `code` first and `details` last. */
function make<C extends ErrorCode>(
  code: C,
  details: DetailsJsonOf<C>,
  handle: HandleString | undefined,
): ErrorJson<C> {
  return {
    code,
    message: `A ${code} error.`,
    hint: ERROR_HINTS[code],
    docsUrl: `https://aelmanaa.github.io/explorer-verify/reference/errors/${code}`,
    retryable: false,
    ...(handle === undefined ? {} : { handle }),
    details,
  };
}
