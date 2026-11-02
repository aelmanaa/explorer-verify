import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { ERROR_CODES, ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/index.ts";
import type { ErrorCode, ErrorDetails, ErrorJson, ExitCode, Handle } from "../../src/index.ts";

// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const DOCS = "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md";
const LEAKY_URL = `https://api.example.org/v2/api?chainid=1&apikey=${DUMMY_KEY}&module=contract`;

function handle(jobId = "550e8400-e29b-41d4-a716-446655440000"): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    jobId,
  };
}

function notConfirmed(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "not-confirmed", handle: handle() },
    "Sourcify was still verifying when the time budget ran out.",
    { cause: new Error(`GET https://api.example.org/?apikey=${DUMMY_KEY} timed out`) },
  );
}

function invalidInput(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    {
      code: "invalid-input",
      issues: [{ field: "chainId", message: "must be a positive integer" }],
    },
    "The input is invalid: chainId.",
  );
}

// Details for every code. A new code that is missing here fails to compile.
const SAMPLE_DETAILS: Record<ErrorCode, ErrorDetails> = {
  "invalid-input": { code: "invalid-input", issues: [] },
  "not-confirmed": { code: "not-confirmed", handle: handle() },
  "unsupported-chain": { code: "unsupported-chain", chainId: 999_999, backend: "sourcify" },
  network: { code: "network", backend: "sourcify", attempts: 3 },
  "rate-limited": { code: "rate-limited", backend: "sourcify", retryAfterMs: 1_000 },
  timeout: { code: "timeout", backend: "sourcify", timeoutMs: 120_000 },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 502,
    excerpt: "<html>Bad gateway</html>",
  },
  "in-progress": { code: "in-progress", backend: "sourcify" },
  "unknown-state": { code: "unknown-state", handle: handle(), excerpt: '{"status":"weird"}' },
  "job-not-found": { code: "job-not-found", handle: handle() },
};

// Details for every code with the key planted in every string field that can hold one.
const LEAKY_DETAILS: Record<ErrorCode, ErrorDetails> = {
  "invalid-input": {
    code: "invalid-input",
    issues: [
      { field: `route.apiUrl?apikey=${DUMMY_KEY}`, message: `must not hold ${DUMMY_KEY}` },
      { field: "chainId", message: `see ${LEAKY_URL}` },
    ],
  },
  "not-confirmed": { code: "not-confirmed", handle: handle(DUMMY_KEY) },
  "unsupported-chain": { code: "unsupported-chain", chainId: 1, backend: "sourcify" },
  network: { code: "network", backend: "sourcify", attempts: 3 },
  "rate-limited": { code: "rate-limited", backend: "sourcify" },
  timeout: { code: "timeout", backend: "sourcify", timeoutMs: 1 },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 500,
    excerpt: `{"url":"${LEAKY_URL}","key":"${DUMMY_KEY}"}`,
  },
  "in-progress": { code: "in-progress", backend: "sourcify" },
  "unknown-state": {
    code: "unknown-state",
    handle: handle(DUMMY_KEY),
    excerpt: `result=${DUMMY_KEY}`,
  },
  "job-not-found": { code: "job-not-found", handle: handle(DUMMY_KEY) },
};

// The documented contract for every code (R-DX-3, R-AX-7, R-AX-10).
const EXPECTED: Record<ErrorCode, { hint: string; retryable: boolean; exitCode: ExitCode }> = {
  "invalid-input": {
    hint: "Fix the fields listed in details.issues, then call again.",
    retryable: false,
    exitCode: 2,
  },
  "not-confirmed": {
    hint: "Call checkStatus with details.handle later to continue polling.",
    retryable: true,
    exitCode: 4,
  },
  "unsupported-chain": {
    hint: "Check the chain ID, or pick a backend that serves this chain with the route option.",
    retryable: false,
    exitCode: 2,
  },
  network: {
    hint: "Check the network connection and the explorer's status page, then call again.",
    retryable: true,
    exitCode: 5,
  },
  "rate-limited": {
    hint: "Wait details.retryAfterMs, or a few seconds when it is not set, then call again.",
    retryable: true,
    exitCode: 5,
  },
  timeout: {
    hint: "Call again, or raise timeoutMs. The explorer had not accepted the submission yet.",
    retryable: true,
    exitCode: 5,
  },
  "unexpected-response": {
    hint: "Check the explorer's status page. If the error persists, report details.status and details.excerpt.",
    retryable: false,
    exitCode: 5,
  },
  "in-progress": {
    hint: "Wait for the explorer to finish its current verification of this contract, then check the contract again.",
    retryable: true,
    exitCode: 4,
  },
  "unknown-state": {
    hint: "Do not retry automatically. Check the contract on the explorer and report details.excerpt.",
    retryable: false,
    exitCode: 6,
  },
  "job-not-found": {
    hint: "Call verify() again to submit the contract again.",
    retryable: false,
    exitCode: 5,
  },
};

const HANDLE_CODES: readonly ErrorCode[] = ["not-confirmed", "unknown-state", "job-not-found"];

/** Every place an error can show its content, the full-depth inspect included. */
function renderings(error: ExplorerVerifyError): Record<string, string> {
  return {
    message: error.message,
    hint: error.hint,
    details: JSON.stringify(error.details),
    toJSON: JSON.stringify(error.toJSON()),
    "JSON.stringify": JSON.stringify(error),
    String: String(error),
    stack: error.stack ?? "",
    cause: inspect(error.cause, { depth: Infinity }),
    inspect: inspect(error, { depth: Infinity }),
    "inspect showHidden": inspect(error, { depth: Infinity, showHidden: true }),
  };
}

function assertNoKey(error: ExplorerVerifyError, key = DUMMY_KEY): void {
  for (const [where, text] of Object.entries(renderings(error))) {
    assert.ok(!text.includes(key), `${error.code}: ${where} holds the key`);
  }
}

describe("ExplorerVerifyError", () => {
  it("is an Error named ExplorerVerifyError with code, hint, retryable, details and docsUrl (R-DX-3, R-AX-10)", () => {
    const error = invalidInput();
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.name, "ExplorerVerifyError");
    assert.equal(error.code, "invalid-input");
    assert.equal(error.details.code, "invalid-input");
    assert.equal(error.message, "The input is invalid: chainId.");
    assert.equal(error.hint, "Fix the fields listed in details.issues, then call again.");
    assert.equal(error.retryable, false);
    assert.equal(error.docsUrl, `${DOCS}#invalid-input`);
    assert.equal(String(error), "ExplorerVerifyError: The input is invalid: chainId.");
  });

  it("marks not-confirmed as retryable and links its docs entry (R-FLOW-4, R-AX-10)", () => {
    const error = notConfirmed();
    assert.equal(error.code, "not-confirmed");
    assert.equal(error.retryable, true);
    assert.equal(error.hint, "Call checkStatus with details.handle later to continue polling.");
    assert.equal(error.docsUrl, `${DOCS}#not-confirmed`);
  });

  for (const code of ERROR_CODES) {
    it(`throws ${code} with its code, hint, docsUrl, retryable flag and details (R-DX-3, R-AX-10)`, () => {
      let thrown: unknown;
      try {
        throw new ExplorerVerifyError(SAMPLE_DETAILS[code], `A ${code} error.`);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof ExplorerVerifyError);
      assert.equal(thrown.code, code);
      assert.equal(thrown.details.code, code);
      assert.deepEqual(thrown.details, SAMPLE_DETAILS[code]);
      assert.equal(thrown.message, `A ${code} error.`);
      assert.equal(thrown.hint, EXPECTED[code].hint);
      assert.equal(thrown.retryable, EXPECTED[code].retryable);
      assert.equal(thrown.docsUrl, `${DOCS}#${code}`);
    });
  }

  it("takes a specific hint in place of the code's default (R-DX-3)", () => {
    const error = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "message", {
      hint: "Use sourcify.",
    });
    assert.equal(error.hint, "Use sourcify.");
  });

  it("copies details, so a later change to the input does not change the error", () => {
    const details: ErrorDetails = {
      code: "invalid-input",
      issues: [{ field: "chainId", message: "must be a positive integer" }],
    };
    const error = new ExplorerVerifyError(details, "message");
    details.issues.push({ field: "address", message: "late" });
    assert.ok(error.details.code === "invalid-input");
    assert.equal(error.details.issues.length, 1);
  });

  it("keeps cause as a copy with the same name, message and stack, and has none when not given", () => {
    const cause = new TypeError("socket closed");
    const withCause = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "m", {
      cause,
    });
    assert.notEqual(withCause.cause, cause);
    assert.ok(withCause.cause instanceof Error);
    assert.equal(withCause.cause.name, "TypeError");
    assert.equal(withCause.cause.message, "socket closed");
    assert.equal(withCause.cause.stack, cause.stack);
    assert.equal(Object.hasOwn(invalidInput(), "cause"), false);
  });

  it("narrows details on details.code without a cast (R-DX-3)", () => {
    const error: ExplorerVerifyError = notConfirmed();
    const details = error.details;
    switch (details.code) {
      case "not-confirmed":
        assert.equal(details.handle.jobId, "550e8400-e29b-41d4-a716-446655440000");
        break;
      case "invalid-input":
      case "unsupported-chain":
      case "network":
      case "rate-limited":
      case "timeout":
      case "unexpected-response":
      case "in-progress":
      case "unknown-state":
      case "job-not-found":
        assert.fail(`unexpected code ${details.code}`);
    }
  });

  it("cuts an excerpt to 300 characters (unexpected-response, unknown-state)", () => {
    const long = "x".repeat(1_000);
    const unexpected = new ExplorerVerifyError(
      { code: "unexpected-response", backend: "sourcify", status: 500, excerpt: long },
      "m",
    );
    const unknown = new ExplorerVerifyError(
      { code: "unknown-state", handle: handle(), excerpt: long },
      "m",
    );
    for (const error of [unexpected, unknown]) {
      assert.ok(
        error.details.code === "unexpected-response" || error.details.code === "unknown-state",
      );
      assert.equal(error.details.excerpt, "x".repeat(300));
    }
  });
});

describe("ERROR_EXIT_CODES (R-AX-7)", () => {
  const requirements = readFileSync(
    new URL("../../../../docs/contributor/requirements.md", import.meta.url),
    "utf8",
  );
  const section = requirements.slice(
    requirements.indexOf("**R-AX-7**"),
    requirements.indexOf("**R-AX-8**"),
  );
  const documented = new Set(
    [...section.matchAll(/^\s*\|\s*(\d+)\s*\|/gm)].map((match) => Number(match[1])),
  );

  it("reads the exit codes 0, 1, 2, 3, 4, 5, 6 and 130 from R-AX-7", () => {
    assert.deepEqual([...documented], [0, 1, 2, 3, 4, 5, 6, 130]);
  });

  it("maps every error code to exactly one exit code from R-AX-7 (R-AX-7)", () => {
    assert.deepEqual(Object.keys(ERROR_EXIT_CODES).toSorted(), [...ERROR_CODES].toSorted());
    for (const code of ERROR_CODES) {
      assert.ok(documented.has(ERROR_EXIT_CODES[code]), `${code} maps to an undocumented code`);
      assert.equal(ERROR_EXIT_CODES[code], EXPECTED[code].exitCode, code);
    }
  });

  it("sends unknown-state to 6 and timeout to 5, apart from each other (R-AX-5, R-AX-7, R-FLOW-4)", () => {
    assert.equal(ERROR_EXIT_CODES["unknown-state"], 6);
    assert.equal(ERROR_EXIT_CODES.timeout, 5);
    assert.equal(ERROR_EXIT_CODES.network, 5);
    assert.equal(ERROR_EXIT_CODES["not-confirmed"], 4);
  });
});

describe("ExplorerVerifyError.toJSON", () => {
  it("returns exactly the error object of the CLI envelope, in a stable order (R-AX-5, R-AX-12)", () => {
    const expected: ErrorJson = {
      code: "invalid-input",
      message: "The input is invalid: chainId.",
      hint: "Fix the fields listed in details.issues, then call again.",
      docsUrl: `${DOCS}#invalid-input`,
      retryable: false,
    };
    const json = invalidInput().toJSON();
    assert.deepEqual(json, expected);
    assert.deepEqual(Object.keys(json), ["code", "message", "hint", "docsUrl", "retryable"]);
  });

  it("adds the handle in its one-line form for not-confirmed (R-AX-5, R-FLOW-5)", () => {
    const json = notConfirmed().toJSON();
    assert.deepEqual(Object.keys(json), [
      "code",
      "message",
      "hint",
      "docsUrl",
      "retryable",
      "handle",
    ]);
    assert.equal(
      json.handle,
      "ev1:sourcify:11155111:0x5FbDB2315678afecb367f032d93F642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
    );
  });

  for (const code of ERROR_CODES) {
    const carries = HANDLE_CODES.includes(code);
    it(`${code}: has the R-AX-5 fields${carries ? " and the handle string" : " and no handle"} (R-AX-5)`, () => {
      const json = new ExplorerVerifyError(SAMPLE_DETAILS[code], "m").toJSON();
      const keys = ["code", "message", "hint", "docsUrl", "retryable"];
      assert.deepEqual(Object.keys(json), carries ? [...keys, "handle"] : keys);
      if (carries) {
        assert.equal(
          json.handle,
          "ev1:sourcify:11155111:0x5FbDB2315678afecb367f032d93F642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
        );
      }
    });
  }

  it("leaves out cause, stack and details, so JSON.stringify is safe to print (R-SEC-1, R-AX-9)", () => {
    const error = notConfirmed();
    const parsed: unknown = JSON.parse(JSON.stringify(error));
    assert.deepEqual(parsed, error.toJSON());
    const keys = Object.keys(error.toJSON());
    for (const left of ["cause", "stack", "details", "name"]) {
      assert.ok(!keys.includes(left), `toJSON() holds ${left}`);
    }
    assert.ok(!JSON.stringify(error).includes("timed out"), "the cause reached the JSON");
  });
});

describe("ExplorerVerifyError key redaction (R-SEC-1, R-AX-9)", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: no dummy key in message, hint, details, toJSON, JSON.stringify, String, stack or full-depth inspect`, () => {
      const nested = new Error(`retry 2 failed: ${LEAKY_URL}`);
      const cause = new TypeError(`fetch failed: ${LEAKY_URL}`, { cause: nested });
      const error = new ExplorerVerifyError(
        LEAKY_DETAILS[code],
        `POST ${LEAKY_URL} failed with key ${DUMMY_KEY}`,
        { hint: `Check ${DUMMY_KEY}.`, cause, secrets: [DUMMY_KEY] },
      );
      assert.ok(
        inspect(cause, { depth: Infinity }).includes(DUMMY_KEY),
        "the key reached the cause",
      );
      assertNoKey(error);
      assert.ok(error.message.includes("apikey=[redacted]"));
    });
  }

  it("redacts an apikey query value in a fetch TypeError cause without being told the key", () => {
    const error = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 3 },
      "Sourcify could not be reached.",
      { cause: new TypeError(`fetch failed for ${LEAKY_URL}`) },
    );
    assertNoKey(error);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.name, "TypeError");
    assert.equal(
      error.cause.message,
      "fetch failed for https://api.example.org/v2/api?chainid=1&apikey=[redacted]&module=contract",
    );
  });

  it("redacts a key in a cause chain, down to four levels, and drops deeper causes", () => {
    let chain: Error = new Error(`level 6 ${DUMMY_KEY}`);
    for (let level = 5; level >= 1; level--) {
      chain = new Error(`level ${String(level)} ${DUMMY_KEY}`, { cause: chain });
    }
    const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
      cause: chain,
      secrets: [DUMMY_KEY],
    });
    assertNoKey(error);
    const messages: string[] = [];
    let current: unknown = error.cause;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    assert.deepEqual(messages, [
      "level 1 [redacted]",
      "level 2 [redacted]",
      "level 3 [redacted]",
      "level 4 [redacted]",
    ]);
  });

  it("stops on a cause chain that loops back on itself", () => {
    const first = new Error(`first ${DUMMY_KEY}`);
    const second = new Error("second", { cause: first });
    first.cause = second;
    const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
      cause: first,
      secrets: [DUMMY_KEY],
    });
    assertNoKey(error);
  });

  it("turns a string cause into a redacted string", () => {
    const fromString = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
      cause: `GET ${LEAKY_URL}`,
    });
    assert.equal(
      fromString.cause,
      "GET https://api.example.org/v2/api?chainid=1&apikey=[redacted]&module=contract",
    );
  });

  it("replaces a cause that is an object, a function or a symbol with [cause omitted]", () => {
    const leaky = {
      apikey: DUMMY_KEY,
      toString: (): string => DUMMY_KEY,
    };
    for (const cause of [leaky, () => DUMMY_KEY, Symbol(DUMMY_KEY), 1n, [DUMMY_KEY]]) {
      const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
        cause,
      });
      assert.equal(error.cause, "[cause omitted]");
      assertNoKey(error);
    }
  });

  it("keeps an undefined, null, number or boolean cause as it is", () => {
    for (const cause of [undefined, null, 42, false]) {
      const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
        cause,
      });
      assert.equal(Object.hasOwn(error, "cause"), true);
      assert.equal(error.cause, cause);
    }
  });

  it("replaces a cause that throws when read with [unreadable cause]", () => {
    const hostileError = new Error("unread");
    Object.defineProperty(hostileError, "message", {
      get(): string {
        throw new Error(DUMMY_KEY);
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error(DUMMY_KEY);
        },
      },
    );
    for (const cause of [hostileError, hostileProxy]) {
      const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
        cause,
      });
      assert.equal(error.cause, "[unreadable cause]");
      assertNoKey(error);
    }
  });

  it("keeps the copy's own stack when the cause has none", () => {
    const cause = new Error(`no stack ${DUMMY_KEY}`);
    Reflect.deleteProperty(cause, "stack");
    const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
      cause,
      secrets: [DUMMY_KEY],
    });
    assert.ok(error.cause instanceof Error);
    assert.ok((error.cause.stack ?? "").startsWith("Error: no stack [redacted]"));
    assertNoKey(error);
  });

  it("redacts a key that straddles the 300-character excerpt cut", () => {
    const excerpt = `${"x".repeat(290)}${DUMMY_KEY}`;
    const error = new ExplorerVerifyError(
      { code: "unexpected-response", backend: "sourcify", status: 500, excerpt },
      "m",
      { secrets: [DUMMY_KEY] },
    );
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.excerpt, `${"x".repeat(290)}[redacted]`);
    assert.ok(!error.details.excerpt.includes(DUMMY_KEY.slice(0, 10)));
  });

  it("keeps the redacted message in the stack, which super builds from it", () => {
    const error = new ExplorerVerifyError(
      { code: "in-progress", backend: "sourcify" },
      `key ${DUMMY_KEY}`,
      {
        secrets: [DUMMY_KEY],
      },
    );
    assert.ok((error.stack ?? "").startsWith("ExplorerVerifyError: key [redacted]"));
  });
});

describe("ExplorerVerifyError.name", () => {
  it("is a getter, not an own field, and String(error) starts with the class name", () => {
    const error = invalidInput();
    assert.ok(!Object.keys(error).includes("name"));
    assert.equal(Object.hasOwn(error, "name"), false);
    assert.equal(error.name, "ExplorerVerifyError");
    assert.ok(String(error).startsWith("ExplorerVerifyError: "));
  });
});

describe("error reference page", () => {
  const page = readFileSync(
    new URL("../../../../docs/user/reference/errors.md", import.meta.url),
    "utf8",
  );
  const codesSection = page.slice(page.indexOf("\n## Codes\n"));
  const headings = [...codesSection.matchAll(/^### (.+)$/gm)].map((match) => match[1] ?? "");

  /** The text of one code's entry, from its heading to the next. */
  function entry(code: string): string {
    const start = codesSection.indexOf(`\n### ${code}\n`);
    const end = codesSection.indexOf("\n### ", start + 1);
    return codesSection.slice(start, end === -1 ? undefined : end);
  }

  it("has a heading for every code in ERROR_CODES (R-AX-10)", () => {
    for (const code of ERROR_CODES) {
      assert.ok(headings.includes(code), `errors.md has no "### ${code}"`);
    }
  });

  it("has no heading that names a code outside ERROR_CODES (R-AX-10)", () => {
    const codes: readonly string[] = ERROR_CODES;
    assert.equal(headings.length, ERROR_CODES.length);
    for (const heading of headings) {
      assert.ok(codes.includes(heading), `"### ${heading}" is not a code`);
    }
    assert.equal(page.match(/^### /gm)?.length, ERROR_CODES.length);
  });

  it("states each code's exit code once, equal to ERROR_EXIT_CODES (R-AX-7)", () => {
    for (const code of ERROR_CODES) {
      const lines = [...entry(code).matchAll(/^Exit code: (\d+)$/gm)];
      assert.equal(lines.length, 1, `${code} has ${String(lines.length)} exit code lines`);
      assert.equal(Number(lines[0]?.[1]), ERROR_EXIT_CODES[code], code);
    }
  });

  it("states each code's retry flag, equal to the catalogue (R-AX-10)", () => {
    for (const code of ERROR_CODES) {
      const retry = entry(code).match(/^Retryable: (yes|no)\b/m)?.[1];
      assert.equal(retry === "yes", EXPECTED[code].retryable, code);
    }
  });

  it("lists each code in the row of its exit code in the exit code table (R-AX-7)", () => {
    const rows = new Map(
      [...page.matchAll(/^\| (\d+) +\|[^|]*\|([^|]*)\|$/gm)].map((match) => [
        Number(match[1]),
        match[2] ?? "",
      ]),
    );
    assert.deepEqual([...rows.keys()], [0, 1, 2, 3, 4, 5, 6, 130]);
    for (const code of ERROR_CODES) {
      assert.ok(
        rows.get(ERROR_EXIT_CODES[code])?.includes(`\`${code}\``),
        `${code} is not in the row for exit code ${String(ERROR_EXIT_CODES[code])}`,
      );
    }
  });

  it("links every docsUrl to an anchor that exists on the page (R-AX-10)", () => {
    for (const code of ERROR_CODES) {
      const error = new ExplorerVerifyError(SAMPLE_DETAILS[code], "m");
      const anchor = new URL(error.docsUrl).hash.slice(1);
      assert.ok(headings.includes(anchor), `no heading for #${anchor}`);
    }
  });
});
