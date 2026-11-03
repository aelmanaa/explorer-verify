import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { ERROR_CODES, ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/index.ts";
import type {
  ErrorCode,
  ErrorDetails,
  ErrorJson,
  ExitCode,
  ExplorerVerifyErrorOptions,
  Handle,
} from "../../src/index.ts";
import { assertLinear, assertSameCost } from "./linear.ts";

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
    { secrets: [], cause: new Error(`GET https://api.example.org/?apikey=${DUMMY_KEY} timed out`) },
  );
}

function invalidInput(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    {
      code: "invalid-input",
      issues: [{ field: "chainId", message: "must be a positive integer" }],
    },
    "The input is invalid: chainId.",
    { secrets: [] },
  );
}

// Details for every code. A new code that is missing here fails to compile.
const SAMPLE_DETAILS: Record<ErrorCode, ErrorDetails> = {
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
  cancelled: { code: "cancelled", handle: handle(DUMMY_KEY) },
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
    hint: "Call again later. If the error persists, check the explorer's status page and report details.status and details.excerpt.",
    retryable: true,
    exitCode: 5,
  },
  "in-progress": {
    hint: "Wait for the explorer to finish its current verification of this contract, then call again.",
    retryable: true,
    exitCode: 5,
  },
  "unknown-state": {
    hint: "Do not retry automatically. Check the contract on the explorer and report details.excerpt.",
    retryable: false,
    exitCode: 6,
  },
  "job-not-found": {
    hint: "Do not retry automatically. Check the contract on the explorer; if it is not verified, call verify() again.",
    retryable: false,
    exitCode: 6,
  },
  cancelled: {
    hint: "The run was cancelled. If verify.submitted was printed, resume with checkStatus and that handle.",
    retryable: false,
    exitCode: 130,
  },
};

const HANDLE_CODES: readonly ErrorCode[] = [
  "not-confirmed",
  "unknown-state",
  "job-not-found",
  "cancelled",
];

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
        throw new ExplorerVerifyError(SAMPLE_DETAILS[code], `A ${code} error.`, { secrets: [] });
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
      secrets: [],
      hint: "Use sourcify.",
    });
    assert.equal(error.hint, "Use sourcify.");
  });

  it("copies details, so a later change to the input does not change the error", () => {
    const details: ErrorDetails = {
      code: "invalid-input",
      issues: [{ field: "chainId", message: "must be a positive integer" }],
    };
    const error = new ExplorerVerifyError(details, "message", { secrets: [] });
    details.issues.push({ field: "address", message: "late" });
    assert.ok(error.details.code === "invalid-input");
    assert.equal(error.details.issues.length, 1);
  });

  it("keeps cause as a copy with the same name, message and stack, and has none when not given", () => {
    const cause = new TypeError("socket closed");
    const withCause = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "m", {
      secrets: [],
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
      case "cancelled":
        assert.fail(`unexpected code ${details.code}`);
    }
  });

  it("cuts an excerpt to 300 characters (unexpected-response, unknown-state)", () => {
    const long = "x".repeat(1_000);
    const unexpected = new ExplorerVerifyError(
      { code: "unexpected-response", backend: "sourcify", status: 500, excerpt: long },
      "m",
      { secrets: [] },
    );
    const unknown = new ExplorerVerifyError(
      { code: "unknown-state", handle: handle(), excerpt: long },
      "m",
      { secrets: [] },
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

  it("sends in-progress to 5 and job-not-found to 6, and unexpected-response is retryable (R-AX-7)", () => {
    assert.equal(ERROR_EXIT_CODES["in-progress"], 5);
    assert.equal(ERROR_EXIT_CODES["job-not-found"], 6);
    assert.equal(ERROR_EXIT_CODES["unexpected-response"], 5);
    const unexpected = new ExplorerVerifyError(SAMPLE_DETAILS["unexpected-response"], "m", {
      secrets: [],
    });
    assert.equal(unexpected.retryable, true);
  });

  it("maps to 4 and 6 only codes whose details carry the handle, as R-AX-7 promises", () => {
    for (const code of ERROR_CODES) {
      const exit = ERROR_EXIT_CODES[code];
      if (exit === 4 || exit === 6) {
        assert.ok(HANDLE_CODES.includes(code), `${code} exits ${String(exit)} without a handle`);
      }
    }
  });

  it("reads exit code 2 in R-AX-7 as including a chain the backend does not support", () => {
    assert.match(
      section,
      /\| 2 +\| Usage or input error, including a chain the backend does not support; nothing was submitted for verification/,
    );
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
      const json = new ExplorerVerifyError(SAMPLE_DETAILS[code], "m", { secrets: [] }).toJSON();
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
      { secrets: [], cause: new TypeError(`fetch failed for ${LEAKY_URL}`) },
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
      secrets: [],
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
        secrets: [],
        cause,
      });
      assert.equal(error.cause, "[cause omitted]");
      assertNoKey(error);
    }
  });

  it("keeps an undefined, null, number or boolean cause as it is", () => {
    for (const cause of [undefined, null, 42, false]) {
      const error = new ExplorerVerifyError({ code: "in-progress", backend: "sourcify" }, "m", {
        secrets: [],
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
        secrets: [],
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
      const holding = [...rows].filter(([, cell]) => cell.includes(`\`${code}\``));
      assert.deepEqual(
        holding.map(([exit]) => exit),
        [ERROR_EXIT_CODES[code]],
        `${code} must appear in exactly the row for exit code ${String(ERROR_EXIT_CODES[code])}`,
      );
    }
  });

  it("links every docsUrl to an anchor that exists on the page (R-AX-10)", () => {
    for (const code of ERROR_CODES) {
      const error = new ExplorerVerifyError(SAMPLE_DETAILS[code], "m", { secrets: [] });
      const anchor = new URL(error.docsUrl).hash.slice(1);
      assert.ok(headings.includes(anchor), `no heading for #${anchor}`);
    }
  });
});

describe("ExplorerVerifyError hardening (R-SEC-1, R-AX-9)", () => {
  // A fake 34-character Etherscan-style key. Never a real one.
  const BARE_KEY = "FAKEKEY0HARDENING0TEST0Z9Y8X7W6V5U";

  it("drops an extra details field that holds a key, at full inspect depth", () => {
    const details: ErrorDetails = { code: "network", backend: "sourcify", attempts: 3 };
    Reflect.set(details, "url", LEAKY_URL);
    Reflect.set(details, "headers", { authorization: DUMMY_KEY });
    const error = new ExplorerVerifyError(details, "m", { secrets: [] });
    assert.deepEqual(Object.keys(error.details), ["code", "backend", "attempts"]);
    assertNoKey(error);
  });

  it("builds the handle from its five fields, dropping an extra url that holds a key", () => {
    const leaky = handle();
    Reflect.set(leaky, "url", LEAKY_URL);
    const all: ErrorDetails[] = [
      { code: "not-confirmed", handle: leaky },
      { code: "unknown-state", handle: leaky, excerpt: "x" },
      { code: "job-not-found", handle: leaky },
      { code: "cancelled", handle: leaky },
    ];
    for (const details of all) {
      const error = new ExplorerVerifyError(details, "m", { secrets: [] });
      assert.ok("handle" in error.details);
      assert.deepEqual(Object.keys(error.details.handle), [
        "version",
        "backend",
        "chainId",
        "address",
        "jobId",
      ]);
      assertNoKey(error);
    }
  });

  it("drops extra fields of every details variant and of an issue", () => {
    for (const code of ERROR_CODES) {
      const details = { ...SAMPLE_DETAILS[code] };
      Reflect.set(details, "url", LEAKY_URL);
      if (details.code === "invalid-input") {
        const issue = { field: "chainId", message: "bad" };
        Reflect.set(issue, "value", DUMMY_KEY);
        details.issues = [issue];
      }
      const error = new ExplorerVerifyError(details, "m", { secrets: [] });
      assert.ok(!Object.keys(error.details).includes("url"), code);
      assertNoKey(error);
    }
  });

  it('reports a backend name outside BACKEND_NAMES as "unknown" and coerces numbers and strings by type', () => {
    const details: ErrorDetails = {
      code: "unexpected-response",
      backend: "sourcify",
      status: 500,
      excerpt: "x",
    };
    Reflect.set(details, "backend", LEAKY_URL);
    Reflect.set(details, "status", "500");
    Reflect.set(details, "excerpt", { toString: () => DUMMY_KEY });
    const error = new ExplorerVerifyError(details, "m", { secrets: [] });
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "unknown",
      status: Number.NaN,
      excerpt: "",
    });
    assertNoKey(error);
    const notText: ErrorDetails = { code: "in-progress", backend: "sourcify" };
    Reflect.set(notText, "backend", 42);
    const other = new ExplorerVerifyError(notText, "m", { secrets: [] });
    assert.deepEqual(other.details, { code: "in-progress", backend: "unknown" });
  });

  it('reports "unknown" for every details variant that names a backend, never another backend', () => {
    for (const code of ERROR_CODES) {
      const details = { ...SAMPLE_DETAILS[code] };
      if (!("backend" in details)) {
        continue;
      }
      Reflect.set(details, "backend", "not-a-backend");
      const error = new ExplorerVerifyError(details, "m", { secrets: [] });
      assert.ok("backend" in error.details, code);
      assert.equal(error.details.backend, "unknown", code);
    }
  });

  it("keeps a valid Handle when its backend is outside BACKEND_NAMES, and never leaks it", () => {
    const leaky = handle();
    Reflect.set(leaky, "backend", LEAKY_URL);
    const error = new ExplorerVerifyError({ code: "job-not-found", handle: leaky }, "m", {
      secrets: [],
    });
    assert.ok(error.details.code === "job-not-found");
    assert.equal(error.details.handle.backend, "etherscan-compatible");
    assertNoKey(error);
  });

  it("keeps every known field of every variant, rate-limited with and without retryAfterMs and attempts", () => {
    for (const code of ERROR_CODES) {
      const error = new ExplorerVerifyError(SAMPLE_DETAILS[code], "m", { secrets: [] });
      assert.deepEqual(error.details, SAMPLE_DETAILS[code], code);
    }
    const bare = new ExplorerVerifyError({ code: "rate-limited", backend: "blockscout" }, "m", {
      secrets: [],
    });
    assert.deepEqual(bare.details, { code: "rate-limited", backend: "blockscout" });
  });

  it("requires secrets in ExplorerVerifyErrorOptions, so a forgotten key list fails to compile", () => {
    type Required = undefined extends ExplorerVerifyErrorOptions["secrets"] ? false : true;
    const required: Required = true;
    assert.equal(required, true);
  });

  it("redacts a bare 34-character key in the message and a string cause without secrets", () => {
    const error = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 1 },
      `Invalid API Key ${BARE_KEY} rejected`,
      { cause: `key was ${BARE_KEY}`, secrets: [] },
    );
    assert.equal(error.message, "Invalid API Key [redacted] rejected");
    assert.equal(error.cause, "key was [redacted]");
    assertNoKey(error, BARE_KEY);
  });

  it("falls back to the code's hint when the hint is empty or blank", () => {
    for (const hint of ["", "   ", "\n\t"]) {
      const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { hint, secrets: [] });
      assert.equal(error.hint, EXPECTED.network.hint, JSON.stringify(hint));
    }
  });

  it("redacts the cause's name", () => {
    const cause = new Error("m");
    cause.name = `Error ${DUMMY_KEY}`;
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", {
      cause,
      secrets: [DUMMY_KEY],
    });
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.name, "Error [redacted]");
    assertNoKey(error);
  });

  it("copies the cause as a plain Error with the original name, not the original class", () => {
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", {
      cause: new TypeError("x"),
      secrets: [],
    });
    assert.ok(error.cause instanceof Error);
    assert.ok(!(error.cause instanceof TypeError));
    assert.equal(error.cause.name, "TypeError");
  });

  it("keeps primitive code, errno and syscall, redacted, and drops other fields", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: `E_${DUMMY_KEY}`,
      errno: -111,
      syscall: `connect ${LEAKY_URL}`,
      url: LEAKY_URL,
    });
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", {
      cause,
      secrets: [DUMMY_KEY],
    });
    assert.ok(error.cause instanceof Error);
    assert.equal(Reflect.get(error.cause, "code"), "E_[redacted]");
    assert.equal(Reflect.get(error.cause, "errno"), -111);
    assert.equal(
      Reflect.get(error.cause, "syscall"),
      "connect https://api.example.org/v2/api?chainid=1&apikey=[redacted]&module=contract",
    );
    assert.equal(Reflect.get(error.cause, "url"), undefined);
    assertNoKey(error);
  });

  it("drops code, errno and syscall that are not primitives", () => {
    const cause = Object.assign(new Error("m"), {
      code: { key: DUMMY_KEY },
      errno: [DUMMY_KEY],
      syscall: 7,
    });
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    for (const field of ["code", "errno", "syscall"]) {
      assert.equal(Object.hasOwn(error.cause, field), false, field);
    }
    assertNoKey(error);
  });

  it("summarises an AggregateError's errors on one line, redacted", () => {
    const named = new Error("plain");
    Reflect.set(named, "name", 42);
    Reflect.set(named, "message", { key: DUMMY_KEY });
    const errors = [
      new TypeError(`fetch failed\n${LEAKY_URL}`),
      `string ${DUMMY_KEY}`,
      { key: DUMMY_KEY },
      named,
      new Error("fifth"),
      new Error("sixth, not listed"),
    ];
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", {
      cause: new AggregateError(errors, "all failed"),
      secrets: [DUMMY_KEY],
    });
    assert.ok(error.cause instanceof Error);
    assert.equal(
      Reflect.get(error.cause, "errors"),
      "6 errors: TypeError: fetch failed https://api.example.org/v2/api?chainid=1&apikey=[redacted]&module=contract; string [redacted]; object; Error: ; Error: fifth",
    );
    assertNoKey(error);
  });

  it("reads each cause field once, so a getter cannot return a key on a second read", () => {
    let reads = 0;
    const cause = new Error("m");
    Object.defineProperty(cause, "stack", {
      get(): unknown {
        reads++;
        return reads === 1 ? "first read" : { toString: () => DUMMY_KEY };
      },
    });
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.equal(reads, 1);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.stack, "Error: m");
    assertNoKey(error);
  });

  it("builds the stack from its own header and the original frame lines only", () => {
    const cause = new Error("m");
    Reflect.set(cause, "message", { toString: () => DUMMY_KEY });
    // V8 formats the stack header when the stack is first read, from the message set above.
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    const lines = (error.cause.stack ?? "").split("\n");
    assert.equal(lines[0], "Error");
    assert.ok(lines.length > 1);
    assert.ok(lines.slice(1).every((line) => line.startsWith("    at ")));
    assertNoKey(error);
  });

  it("keeps Firefox and Safari frames, redacted, and drops other and over-long lines", () => {
    const cause = new Error("boom");
    cause.stack = [
      `boom ${DUMMY_KEY}`,
      `fetchJson@https://app.example/main.js?apikey=${DUMMY_KEY}:10:5`,
      "@debugger eval code:1:1",
      `note ${DUMMY_KEY}`,
      `long@${"x".repeat(1_000)}:1:1`,
    ].join("\n");
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    assert.equal(
      error.cause.stack,
      [
        "Error: boom",
        // The value runs to the line end: a colon can be part of a key.
        "fetchJson@https://app.example/main.js?apikey=[redacted]",
        "@debugger eval code:1:1",
      ].join("\n"),
    );
  });

  it("redacts only strings: a message or name that is not a string is dropped", () => {
    const cause = new Error("m");
    Reflect.set(cause, "message", { toString: () => DUMMY_KEY });
    Reflect.set(cause, "name", { toString: () => DUMMY_KEY });
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "");
    assert.equal(error.cause.name, "Error");
    assertNoKey(error);
  });
});

describe("ExplorerVerifyError excerpts", () => {
  it("cuts a long excerpt to 300 characters, in linear time", () => {
    const body = "0x" + "6080604052".repeat(100_000);
    const error = new ExplorerVerifyError(
      { code: "unexpected-response", backend: "sourcify", status: 500, excerpt: body },
      "m",
      { secrets: [DUMMY_KEY] },
    );
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.excerpt, body.slice(0, 300));
    assertLinear(
      "excerpt",
      (size) => "6080604052".repeat(size / 10),
      (excerpt) =>
        new ExplorerVerifyError(
          { code: "unexpected-response", backend: "sourcify", status: 500, excerpt },
          "m",
          { secrets: [DUMMY_KEY] },
        ),
    );
  });

  // 256 KB of lines full of `@`: 999-character lines cost the same as 63-character lines only when
  // the frame check is linear in the line length.
  const SIZE = 1 << 18;
  const lines = (length: number): string => `${"@".repeat(length - 1)}\n`.repeat(SIZE / length);

  it("copies a cause whose stack is full of long @ lines as fast as short ones", () => {
    assertSameCost("cause stack", lines(63), lines(999), (stack) => {
      const cause = new Error("m");
      cause.stack = stack;
      return new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    });
  });

  it("copies a cause whose message is full of long @ lines as fast as short ones", () => {
    assertSameCost(
      "cause message",
      lines(63),
      lines(999),
      (message) =>
        new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", {
          cause: new Error(message),
          secrets: [],
        }),
    );
  });

  it("never shows part of a key that the redaction window cuts", () => {
    // Long known secrets before the cut shrink the text, which pulls later text forward.
    const long = "LONGSECRET".repeat(10);
    for (let offset = 250; offset < 520; offset++) {
      const body = `${long} ${"x".repeat(offset)}${DUMMY_KEY}${"y".repeat(400)}`;
      const error = new ExplorerVerifyError(
        { code: "unknown-state", handle: handle(), excerpt: body },
        "m",
        { secrets: [DUMMY_KEY, long] },
      );
      assert.ok(error.details.code === "unknown-state");
      assert.ok(!error.details.excerpt.includes(DUMMY_KEY.slice(0, 8)), `offset ${String(offset)}`);
      assert.ok(error.details.excerpt.length <= 300);
    }
  });

  it("cuts a short excerpt only after redacting it", () => {
    const error = new ExplorerVerifyError(
      { code: "unknown-state", handle: handle(), excerpt: `ok ${DUMMY_KEY}` },
      "m",
      { secrets: [DUMMY_KEY] },
    );
    assert.ok(error.details.code === "unknown-state");
    assert.equal(error.details.excerpt, "ok [redacted]");
  });
});

describe("error reference page, exit code rows", () => {
  const page = readFileSync(
    new URL("../../../../docs/user/reference/errors.md", import.meta.url),
    "utf8",
  );

  it("says the explorer definitively rejected a failed submission (R-AX-7)", () => {
    assert.match(page, /^\| 1 +\| `failed`: the explorer definitively rejected the submission/m);
  });

  it("states the boundary between unexpected-response and unknown-state", () => {
    assert.match(page, /`unexpected-response` and `unknown-state` differ in who answered/);
  });
});

describe("cancelled (R-AX-7)", () => {
  it("maps to exit code 130, is not retryable and has the resume hint", () => {
    const error = new ExplorerVerifyError({ code: "cancelled" }, "Cancelled.", { secrets: [] });
    assert.equal(ERROR_EXIT_CODES.cancelled, 130);
    assert.equal(error.retryable, false);
    assert.equal(
      error.hint,
      "The run was cancelled. If verify.submitted was printed, resume with checkStatus and that handle.",
    );
    assert.equal(error.docsUrl, `${DOCS}#cancelled`);
  });

  it("has no handle in details or toJSON when the cancel came before a submission was accepted (R-AX-5)", () => {
    const error = new ExplorerVerifyError({ code: "cancelled" }, "Cancelled.", { secrets: [] });
    assert.deepEqual(error.details, { code: "cancelled" });
    assert.deepEqual(Object.keys(error.toJSON()), [
      "code",
      "message",
      "hint",
      "docsUrl",
      "retryable",
    ]);
  });

  it("carries the handle, redacted, when a submission was accepted before the cancel (R-AX-5)", () => {
    const error = new ExplorerVerifyError(
      { code: "cancelled", handle: handle(DUMMY_KEY) },
      "Cancelled.",
      { secrets: [DUMMY_KEY] },
    );
    assert.equal(
      error.toJSON().handle,
      "ev1:sourcify:11155111:0x5FbDB2315678afecb367f032d93F642f64180aa3:[redacted]",
    );
    assertNoKey(error);
  });

  it("is documented as created by the CLI, not thrown by the core", () => {
    const page = readFileSync(
      new URL("../../../../docs/user/reference/errors.md", import.meta.url),
      "utf8",
    );
    assert.match(page, /^\| 130 +\| Cancelled +\| `cancelled`/m);
    assert.match(page, /The CLI creates this error/);
  });
});

/** A V8 stack frame line of exactly `length` characters. */
function frame(length: number): string {
  return `    at f (${"x".repeat(length - 15)}:1:1)`;
}

describe("ExplorerVerifyError bounds", () => {
  it("turns a handle address that is not a string into 0x, without calling its toString", () => {
    for (const address of [5, { toString: () => `0x${DUMMY_KEY}` }]) {
      const bad = handle();
      Reflect.set(bad, "address", address);
      const error = new ExplorerVerifyError({ code: "job-not-found", handle: bad }, "m", {
        secrets: [],
      });
      assert.ok(error.details.code === "job-not-found");
      assert.equal(error.details.handle.address, "0x");
    }
  });

  it("keeps a cause stack frame line of 1000 characters and drops one of 1001", () => {
    assert.equal(frame(1_000).length, 1_000);
    const cause = new Error("boom");
    cause.stack = ["Error: boom", frame(1_000), frame(1_001)].join("\n");
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    assert.deepEqual(error.cause.stack?.split("\n"), ["Error: boom", frame(1_000)]);
  });
});
