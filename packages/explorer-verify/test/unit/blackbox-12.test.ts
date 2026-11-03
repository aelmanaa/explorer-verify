// Black-box tests for issue #12: the error catalogue and API key redaction. They use only the
// public entry point and the promises in the issue, decision 0009, requirements.md (R-DX-3,
// R-SEC-1, R-AX-5, R-AX-7, R-AX-9, R-AX-10) and docs/user/reference/errors/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { ERROR_CODES, ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/index.ts";
import type { ErrorCode, ErrorDetails, Handle } from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";

// --- fixtures -----------------------------------------------------------------------------------

// A fake Etherscan-style key: 34 uppercase alphanumerics. Never a real key.
const KEY = "FAKEKEY0BLACKBOX0TEST0Z9Y8X7W6V5U4";
const ETHERSCAN_URL = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=verifysourcecode&apikey=${KEY}`;
const FORM_BODY = `apikey=${KEY}&module=contract`;

const handle: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: 11155111,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  jobId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const handleString = `ev1:sourcify:11155111:0x1234567890abcdef1234567890abcdef12345678:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`;

// Expected values, from the error pages and R-AX-7: exit codes 4 and 6 carry the handle, so in-progress
// (no handle, call again later) exits 5 and job-not-found (a person checks) exits 6.
const expected: Record<ErrorCode, { retryable: boolean; exit: number; hasHandle: boolean }> = {
  "invalid-input": { retryable: false, exit: 2, hasHandle: false },
  "not-confirmed": { retryable: true, exit: 4, hasHandle: true },
  "unsupported-chain": { retryable: false, exit: 2, hasHandle: false },
  network: { retryable: true, exit: 5, hasHandle: false },
  "rate-limited": { retryable: true, exit: 5, hasHandle: false },
  timeout: { retryable: true, exit: 5, hasHandle: false },
  "unexpected-response": { retryable: true, exit: 5, hasHandle: false },
  "in-progress": { retryable: true, exit: 5, hasHandle: false },
  "unknown-state": { retryable: false, exit: 6, hasHandle: true },
  "job-not-found": { retryable: false, exit: 6, hasHandle: true },
  cancelled: { retryable: false, exit: 130, hasHandle: true },
  "incomplete-input": { retryable: false, exit: 2, hasHandle: false },
  "insufficient-artifact": { retryable: false, exit: 2, hasHandle: false },
  "unsupported-compiler": { retryable: false, exit: 2, hasHandle: false },
  "verification-inconclusive": { retryable: true, exit: 4, hasHandle: false },
  "source-mismatch": { retryable: false, exit: 2, hasHandle: false },
  "missing-api-key": { retryable: false, exit: 3, hasHandle: false },
  "api-key-rejected": { retryable: false, exit: 3, hasHandle: false },
  "quota-exceeded": { retryable: false, exit: 3, hasHandle: false },
};

/** Details for each code; `text` goes into every free-text string the details allow. */
function detailsFor(code: ErrorCode, text: string): ErrorDetails {
  const all: { [C in ErrorCode]: Extract<ErrorDetails, { code: C }> } = {
    "invalid-input": {
      code: "invalid-input",
      issues: [{ field: "chainId", message: `bad value ${text}` }],
    },
    "not-confirmed": { code: "not-confirmed", handle },
    "unsupported-chain": { code: "unsupported-chain", chainId: 99999, backend: "sourcify" },
    network: { code: "network", backend: "sourcify", attempts: 3 },
    "rate-limited": { code: "rate-limited", backend: "sourcify", retryAfterMs: 2000 },
    timeout: { code: "timeout", backend: "sourcify", timeoutMs: 120000 },
    "unexpected-response": {
      code: "unexpected-response",
      backend: "etherscan-v2",
      status: 500,
      excerpt: `body ${text}`,
    },
    "in-progress": { code: "in-progress", backend: "sourcify" },
    "unknown-state": { code: "unknown-state", handle, excerpt: `state ${text}` },
    "job-not-found": { code: "job-not-found", handle },
    cancelled: { code: "cancelled", handle },
    "incomplete-input": {
      code: "incomplete-input",
      field: "contract",
      candidates: [`src/A.sol:A ${text}`],
    },
    "insufficient-artifact": { code: "insufficient-artifact", field: "input" },
    "unsupported-compiler": { code: "unsupported-compiler", field: "compilerType" },
    "verification-inconclusive": {
      code: "verification-inconclusive",
      backend: "sourcify",
      reason: `internal_error: ${text}`,
    },
    "source-mismatch": {
      code: "source-mismatch",
      path: `src/A.sol ${text}`,
      expected: `0x${"a".repeat(64)}`,
      actual: `0x${"b".repeat(64)}`,
    },
    "missing-api-key": { code: "missing-api-key", backend: "etherscan-v2" },
    "api-key-rejected": { code: "api-key-rejected", backend: "etherscan-v2" },
    "quota-exceeded": { code: "quota-exceeded", backend: "etherscan-v2" },
  };
  return all[code];
}

/** Every surface a person or a log could see. */
function surfaces(error: ExplorerVerifyError): Record<string, string> {
  return {
    message: error.message,
    hint: error.hint,
    toJSON: JSON.stringify(error.toJSON()),
    stringify: JSON.stringify(error),
    string: String(error),
    stack: error.stack ?? "",
    inspect: inspect(error, { depth: Infinity, showHidden: true }),
    inspectDetails: inspect(error.details, { depth: Infinity, showHidden: true }),
    inspectCause: inspect(error.cause, { depth: Infinity, showHidden: true }),
  };
}

function assertNoKey(error: ExplorerVerifyError, secret: string = KEY): void {
  for (const [where, text] of Object.entries(surfaces(error))) {
    assert.ok(!text.includes(secret), `key found in ${where}: ${text.replaceAll(secret, "<KEY>")}`);
  }
}

/** The page of one code, docs/user/reference/errors/<code>.md. */
function section(code: string): string {
  return readFileSync(
    new URL(`../../../../docs/user/reference/errors/${code}.md`, import.meta.url),
    "utf8",
  );
}

// --- catalogue ----------------------------------------------------------------------------------

describe("blackbox #12: catalogue", () => {
  it("ERROR_CODES has exactly the documented codes, and no duplicates", () => {
    assert.deepEqual(ERROR_CODES.toSorted(), Object.keys(expected).toSorted());
    assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  });

  for (const code of ERROR_CODES) {
    describe(code, () => {
      const want = expected[code];
      const error = new ExplorerVerifyError(
        detailsFor(code, "plain"),
        `Something failed: ${code}.`,
        { secrets: [] },
      );

      it("is an Error and an ExplorerVerifyError with name ExplorerVerifyError", () => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.name, "ExplorerVerifyError");
        assert.ok(!Object.hasOwn(error, "name"), "name is a getter, not an own field");
      });

      it("code equals details.code", () => {
        assert.equal(error.code, code);
        assert.equal(error.details.code, code);
      });

      it("retryable matches the issue table and the code's page (R-DX-3)", () => {
        assert.equal(error.retryable, want.retryable);
        const doc = section(code);
        assert.match(doc, want.retryable ? /^Retryable: yes/mu : /^Retryable: no/mu);
      });

      it("hint is a non-empty sentence (R-DX-3, R-AX-10)", () => {
        assert.equal(typeof error.hint, "string");
        assert.ok(error.hint.trim().length > 0);
      });

      it("docsUrl points at the code's own page (R-AX-10)", () => {
        assert.equal(error.docsUrl, docsUrlOf(code));
        const doc = section(code);
        assert.match(doc, /^Cause: /mu);
        assert.match(doc, /^Fix: /mu);
      });

      it("exit code equals the documented exit code (R-AX-7)", () => {
        assert.equal(ERROR_EXIT_CODES[code], want.exit);
        const doc = section(code);
        const match = /^Exit code: (\d+)$/mu.exec(doc);
        assert.ok(match, `the page of ${code} has no exit code`);
        assert.equal(Number(match[1]), want.exit);
      });

      it("toJSON is exactly the R-AX-5 error shape, in order", () => {
        const json = error.toJSON();
        const keys = ["code", "message", "hint", "docsUrl", "retryable"];
        if (want.hasHandle) keys.push("handle");
        assert.deepEqual(Object.keys(json), keys);
        assert.equal(json.code, code);
        assert.equal(json.message, error.message);
        assert.equal(json.hint, error.hint);
        assert.equal(json.docsUrl, error.docsUrl);
        assert.equal(json.retryable, want.retryable);
        if (want.hasHandle) assert.equal(json.handle, handleString);
        assert.equal(JSON.stringify(error), JSON.stringify(json));
      });

      it("toJSON has no cause, stack or details even when a cause is given", () => {
        const withCause = new ExplorerVerifyError(detailsFor(code, "plain"), "failed", {
          secrets: [],
          cause: new Error("inner"),
        });
        const parsed: unknown = JSON.parse(JSON.stringify(withCause));
        assert.ok(typeof parsed === "object" && parsed !== null);
        assert.ok(!("cause" in parsed));
        assert.ok(!("stack" in parsed));
        assert.ok(!("details" in parsed));
        assert.ok(!("name" in parsed));
      });

      it("String(error) is 'ExplorerVerifyError: <message>'", () => {
        assert.equal(String(error), `ExplorerVerifyError: Something failed: ${code}.`);
      });

      it("options.hint replaces the default hint", () => {
        const custom = new ExplorerVerifyError(detailsFor(code, "plain"), "m", {
          secrets: [],
          hint: "Do this specific thing.",
        });
        assert.equal(custom.hint, "Do this specific thing.");
        assert.equal(custom.toJSON().hint, "Do this specific thing.");
      });
    });
  }

  it("deterministic: the same input gives the same toJSON (R-AX-12)", () => {
    for (const code of ERROR_CODES) {
      const a = new ExplorerVerifyError(detailsFor(code, "x"), "m", { secrets: [] });
      const b = new ExplorerVerifyError(detailsFor(code, "x"), "m", { secrets: [] });
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    }
  });
});

// --- redaction ----------------------------------------------------------------------------------

describe("blackbox #12: redaction (R-SEC-1, R-AX-9)", () => {
  it("the fake key looks like an Etherscan key", () => {
    assert.match(KEY, /^[A-Z0-9]{34}$/u);
  });

  for (const code of ERROR_CODES) {
    describe(code, () => {
      it("bare key in message, hint and details strings is removed with `secrets`", () => {
        const error = new ExplorerVerifyError(detailsFor(code, KEY), `failed with ${KEY}`, {
          hint: `Check key ${KEY}.`,
          secrets: [KEY],
        });
        assertNoKey(error);
        assert.match(error.message, /\[redacted\]/u);
        assert.match(error.hint, /\[redacted\]/u);
      });

      it("Etherscan URL with apikey in message, hint and details, no `secrets`", () => {
        const error = new ExplorerVerifyError(
          detailsFor(code, ETHERSCAN_URL),
          `GET ${ETHERSCAN_URL}`,
          { secrets: [], hint: `Retry ${ETHERSCAN_URL}` },
        );
        assertNoKey(error);
        assert.ok(error.message.includes("module=contract"), "non-secret parameters stay readable");
      });

      it("form body in message, hint and details, no `secrets`", () => {
        const error = new ExplorerVerifyError(detailsFor(code, FORM_BODY), `POST ${FORM_BODY}`, {
          secrets: [],
          hint: `body was ${FORM_BODY}`,
        });
        assertNoKey(error);
        assert.ok(error.message.includes("&module=contract"));
      });

      it("cause Error whose message holds the Etherscan URL, no `secrets`", () => {
        const cause = new TypeError(`fetch failed: ${ETHERSCAN_URL}`);
        const error = new ExplorerVerifyError(detailsFor(code, "x"), "network failed", {
          secrets: [],
          cause,
        });
        assertNoKey(error);
        assert.ok(error.cause instanceof Error, "cause is kept as an Error copy");
        assert.notEqual(error.cause, cause, "cause is a copy, not the original");
      });

      it("cause chain of 3 Errors, key at every level", () => {
        const deepest = new Error(`level 3 ${FORM_BODY}`);
        const middle = new Error(`level 2 bare ${KEY}`, { cause: deepest });
        const top = new TypeError(`level 1 ${ETHERSCAN_URL}`, { cause: middle });
        const error = new ExplorerVerifyError(detailsFor(code, "x"), "failed", {
          cause: top,
          secrets: [KEY],
        });
        assertNoKey(error);
        const text = inspect(error, { depth: Infinity, showHidden: true });
        assert.match(text, /level 3/u, "the chain is kept for debugging");
      });
    });
  }

  it("cause chain deeper than four levels never leaks the key from the deepest level", () => {
    let cause = new Error(`level 7 ${ETHERSCAN_URL}`);
    for (let level = 6; level >= 1; level -= 1) {
      cause = new Error(`level ${String(level)}`, { cause });
    }
    const error = new ExplorerVerifyError(detailsFor("network", "x"), "failed", {
      secrets: [],
      cause,
    });
    assertNoKey(error);
  });

  it("cause stack holding the key is redacted", () => {
    const cause = new Error(`fetch failed ${ETHERSCAN_URL}`);
    assert.ok((cause.stack ?? "").includes(KEY), "precondition: the raw stack holds the key");
    const error = new ExplorerVerifyError(detailsFor("network", "x"), "failed", {
      secrets: [],
      cause,
    });
    assertNoKey(error);
  });

  it("extra own properties of the cause (url, body) do not leak", () => {
    const cause = Object.assign(new Error("request failed"), {
      url: ETHERSCAN_URL,
      body: FORM_BODY,
      headers: { authorization: `Bearer ${KEY}` },
    });
    const error = new ExplorerVerifyError(detailsFor("network", "x"), "failed", {
      secrets: [],
      cause,
    });
    assertNoKey(error);
  });

  it("a string cause is redacted", () => {
    const error = new ExplorerVerifyError(detailsFor("network", "x"), "failed", {
      secrets: [],
      cause: `GET ${ETHERSCAN_URL}`,
    });
    assertNoKey(error);
  });

  it("a non-Error object cause becomes [cause omitted]", () => {
    const error = new ExplorerVerifyError(detailsFor("network", "x"), "failed", {
      secrets: [],
      cause: { url: ETHERSCAN_URL, key: KEY },
    });
    assertNoKey(error);
    assert.equal(error.cause, "[cause omitted]");
  });

  it("key followed by a quote character is redacted", () => {
    const text = `{"url":"https://api.etherscan.io/v2/api?apikey=${KEY}"}`;
    const error = new ExplorerVerifyError(detailsFor("unexpected-response", text), text, {
      secrets: [],
    });
    assertNoKey(error);
    assert.ok(error.message.endsWith(`"}`), "the closing quote and brace stay");
  });

  it("apikey= in any case, with an unknown value, is redacted", () => {
    for (const name of ["apikey", "APIKEY", "ApiKey", "api_key", "key", "token"]) {
      const msg = `https://example.org/api?module=contract&${name}=${KEY}&x=1`;
      const error = new ExplorerVerifyError(detailsFor("unexpected-response", msg), msg, {
        secrets: [],
      });
      assertNoKey(error);
      assert.ok(error.message.includes("&x=1"), `${name}: following parameter stays`);
    }
  });

  it("key in a URL fragment, in URL credentials and as a bearer token is redacted", () => {
    for (const msg of [
      `https://example.org/cb#apikey=${KEY}`,
      `https://user:${KEY}@example.org/api`,
      `Authorization: Bearer ${KEY}`,
    ]) {
      const error = new ExplorerVerifyError(detailsFor("unexpected-response", msg), msg, {
        secrets: [],
      });
      assertNoKey(error);
    }
  });

  it("a handle whose jobId equals a secret does not leak through toJSON", () => {
    const leaky: Handle = { ...handle, jobId: KEY };
    const error = new ExplorerVerifyError({ code: "not-confirmed", handle: leaky }, "pending", {
      secrets: [KEY],
    });
    assertNoKey(error);
  });

  it("several secrets are all removed", () => {
    const other = "SECONDFAKEKEY0000000000000000000ZZ";
    const error = new ExplorerVerifyError(detailsFor("network", "x"), `${KEY} and ${other}`, {
      secrets: [KEY, other],
    });
    assertNoKey(error, KEY);
    assertNoKey(error, other);
  });

  it("the caller's details object is not used as-is: later mutation cannot inject a key", () => {
    const issues = [{ field: "chainId", message: "bad" }];
    const error = new ExplorerVerifyError({ code: "invalid-input", issues }, "invalid", {
      secrets: [KEY],
    });
    issues[0] = { field: "chainId", message: KEY };
    assertNoKey(error);
  });
});
