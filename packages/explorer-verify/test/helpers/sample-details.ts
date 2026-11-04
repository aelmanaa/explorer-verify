// Details for every code, valid and free of keys. Shared by the error tests and the error page
// tests. A new code that is missing here fails to compile.
import type { ErrorCode, ErrorDetails, Handle } from "../../src/index.ts";

function handle(): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
  };
}

export const SAMPLE_DETAILS: Record<ErrorCode, ErrorDetails> = {
  "invalid-input": { code: "invalid-input", issues: [] },
  "not-confirmed": { code: "not-confirmed", handle: handle() },
  "unsupported-chain": { code: "unsupported-chain", chainId: 999_999, backend: "sourcify" },
  network: { code: "network", backend: "sourcify", attempts: 3 },
  "rate-limited": { code: "rate-limited", backend: "sourcify", retryAfterMs: 1_000, attempts: 5 },
  timeout: { code: "timeout", backend: "sourcify", timeoutMs: 120_000 },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 502,
    excerpt: "<html>Bad gateway</html>",
    retryAfterMs: 2_000,
  },
  "in-progress": { code: "in-progress", backend: "sourcify" },
  "unknown-state": { code: "unknown-state", handle: handle(), excerpt: '{"status":"weird"}' },
  "job-not-found": { code: "job-not-found", handle: handle() },
  cancelled: { code: "cancelled", handle: handle() },
  "incomplete-input": { code: "incomplete-input", field: "compilerVersion", candidates: [] },
  "insufficient-artifact": { code: "insufficient-artifact", field: "input" },
  "unsupported-compiler": { code: "unsupported-compiler", field: "compilerType" },
  "verification-inconclusive": {
    code: "verification-inconclusive",
    backend: "sourcify",
    reason: "internal_error: The server encountered an unexpected error.",
  },
  "source-mismatch": {
    code: "source-mismatch",
    path: "src/Greeter.sol",
    expected: `0x${"a".repeat(64)}`,
    actual: `0x${"b".repeat(64)}`,
  },
  "missing-api-key": { code: "missing-api-key", backend: "etherscan-v2" },
  "api-key-rejected": { code: "api-key-rejected", backend: "etherscan-v2" },
  "quota-exceeded": { code: "quota-exceeded", backend: "etherscan-v2" },
  "internal-error": { code: "internal-error" },
  "no-metadata-hash": { code: "no-metadata-hash", found: "version-only" },
  "metadata-unavailable": {
    code: "metadata-unavailable",
    hash: "ipfs:QmQXfzJLPTjPUD1LWY6XQHqnWgqgDYEravjDpAMCtW4Uvb",
    attempts: [
      { source: "sourcify", outcome: "not-found", status: 200 },
      { source: "ipfs", outcome: "unavailable", status: 429 },
    ],
  },
  "constructor-args-unavailable": {
    code: "constructor-args-unavailable",
    reason: "prefix-mismatch",
  },
};
