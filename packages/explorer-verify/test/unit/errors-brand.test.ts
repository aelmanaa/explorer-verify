// ExplorerVerifyError narrows by code and is recognised across copies of the package (#213,
// decision 0044; R-DX-3, R-DX-4, R-AX-5, R-SEC-1). The functions at the top are type tests: this
// file is type-checked under `strict` and `exactOptionalPropertyTypes`, so a narrowing that stops
// working fails `pnpm run typecheck`.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { newError } from "../../src/error-hints.ts";
import { ERROR_CODES, ERROR_HINTS, ExplorerVerifyError, toEnvelope } from "../../src/index.ts";
import type {
  AnyExplorerVerifyError,
  BackendOutcome,
  DetailsByCode,
  DetailsOf,
  ErrorDetails,
  Handle,
  VerifyEachResult,
  VerifyOutcome,
} from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";
import { SAMPLE_DETAILS } from "../helpers/sample-details.ts";

const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  jobId: "550e8400-e29b-41d4-a716-446655440000",
};

// Type tests (R-DX-3). Each returns what it narrowed to, so the runtime tests below also run them.

/** `ExplorerVerifyError.is(e, code)` narrows `details` to that code. */
function handleOf(error: unknown): Handle | undefined {
  return ExplorerVerifyError.is(error, "not-confirmed") ? error.details.handle : undefined;
}

/** `instanceof`, then a check of `code`, narrows `details`. */
function retryAfterOf(error: unknown): number | undefined {
  return error instanceof ExplorerVerifyError && error.code === "rate-limited"
    ? error.details.retryAfterMs
    : undefined;
}

/** A `switch` on `code` after `is()` narrows `details` in each case. */
function summary(error: unknown): string {
  if (!ExplorerVerifyError.is(error)) {
    return "not ours";
  }
  switch (error.code) {
    case "not-confirmed":
      return error.details.handle.jobId;
    case "rate-limited":
      return String(error.details.retryAfterMs ?? "none");
    case "source-mismatch": {
      const expected: `0x${string}` = error.details.expected;
      return expected;
    }
    case "incomplete-input": {
      const field: "input" | "compilerVersion" | "contract" | "sources" = error.details.field;
      return field;
    }
    // Listed, not `default`, so a new code fails the exhaustiveness lint here too.
    case "invalid-input":
    case "unsupported-chain":
    case "network":
    case "timeout":
    case "unexpected-response":
    case "in-progress":
    case "unknown-state":
    case "job-not-found":
    case "cancelled":
    case "insufficient-artifact":
    case "unsupported-compiler":
    case "verification-inconclusive":
    case "missing-api-key":
    case "api-key-rejected":
    case "quota-exceeded":
    case "internal-error":
    case "no-metadata-hash":
    case "metadata-unavailable":
    case "constructor-args-unavailable":
    case "proxy-link-pending":
    case "proxy-link-unknown-state":
      break;
  }
  return error.code;
}

/** A narrowed error is still an `ExplorerVerifyError`, and `DetailsOf` names one code's data. */
function widen(error: ExplorerVerifyError<"timeout">): [ExplorerVerifyError, DetailsOf<"timeout">] {
  const any: AnyExplorerVerifyError = error;
  const keyed: DetailsByCode["timeout"] = error.details;
  return [any, keyed];
}

/** An outcome of `verifyEach()` narrows its error by code, as the library hands it back. */
function pendingHandles(result: VerifyEachResult): Handle[] {
  return result.outcomes.flatMap((outcome: BackendOutcome) =>
    "error" in outcome && outcome.error.code === "not-confirmed"
      ? [outcome.error.details.handle]
      : [],
  );
}

/** A `VerifyOutcome` narrows its error by code. */
function timeoutOf(outcome: VerifyOutcome): number | undefined {
  return "code" in outcome && outcome.code === "timeout" ? outcome.details.timeoutMs : undefined;
}

/** A subclass keeps its own type through `instanceof`. */
class AppError extends ExplorerVerifyError<"internal-error"> {
  readonly app = "demo";
}

function appOf(value: unknown): string | undefined {
  return value instanceof AppError ? value.app : undefined;
}

/** The constructor infers the code from `details`. */
function built(): number {
  const error = new ExplorerVerifyError(
    { code: "timeout", backend: "sourcify", timeoutMs: 5 },
    "m",
    { secrets: [] },
  );
  return error.details.timeoutMs;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "../../dist/src");
const copies: string[] = [];

after(() => {
  for (const dir of copies) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The built package's entry point, copied to a folder of its own: a second copy of the package. */
async function loadCopy(): Promise<unknown> {
  const dir = mkdtempSync(path.join(tmpdir(), "explorer-verify-copy-"));
  copies.push(dir);
  cpSync(DIST, dir, { recursive: true });
  const entry: unknown = await import(pathToFileURL(path.join(dir, "index.js")).href);
  return entry;
}

/** An error built by the copy's constructor. */
function foreignError(entry: unknown, details: ErrorDetails): unknown {
  const ctor: unknown =
    typeof entry === "object" && entry !== null
      ? Reflect.get(entry, "ExplorerVerifyError")
      : undefined;
  assert.equal(typeof ctor, "function");
  assert.notEqual(ctor, ExplorerVerifyError, "the copy has its own class");
  if (typeof ctor !== "function") {
    throw new Error("unreachable");
  }
  const error: unknown = Reflect.construct(ctor, [details, "from the copy", { secrets: [] }]);
  return error;
}

describe("ExplorerVerifyError.is and instanceof (R-DX-3, decision 0044)", () => {
  it("narrows by code in the type tests, and returns the narrowed data", () => {
    const pending = newError({ code: "not-confirmed", handle: HANDLE }, "m", { secrets: [] });
    const limited = newError({ code: "rate-limited", backend: "sourcify", retryAfterMs: 7 }, "m", {
      secrets: [],
    });
    assert.deepEqual(handleOf(pending), HANDLE);
    assert.equal(handleOf(limited), undefined);
    assert.equal(retryAfterOf(limited), 7);
    assert.equal(retryAfterOf(pending), undefined);
    assert.equal(summary(pending), HANDLE.jobId);
    assert.equal(summary(limited), "7");
    assert.equal(
      summary(newError(SAMPLE_DETAILS["source-mismatch"], "m", { secrets: [] })),
      `0x${"a".repeat(64)}`,
    );
    assert.equal(
      summary(newError(SAMPLE_DETAILS["incomplete-input"], "m", { secrets: [] })),
      "compilerVersion",
    );
    assert.equal(summary(newError(SAMPLE_DETAILS.network, "m", { secrets: [] })), "network");
    assert.equal(summary(new Error("x")), "not ours");
    const timeout = newError({ code: "timeout", backend: "sourcify", timeoutMs: 1 }, "m", {
      secrets: [],
    });
    assert.deepEqual(widen(timeout), [timeout, timeout.details]);
    assert.equal(built(), 5);
  });

  it("checks the code only when one is given", () => {
    for (const code of ERROR_CODES) {
      const error = newError(SAMPLE_DETAILS[code], "m", { secrets: [] });
      assert.ok(ExplorerVerifyError.is(error), code);
      assert.ok(ExplorerVerifyError.is(error, code), code);
      const other = code === "network" ? "timeout" : "network";
      assert.ok(!ExplorerVerifyError.is(error, other), code);
      assert.ok(error instanceof ExplorerVerifyError, code);
      assert.ok(error instanceof Error, code);
    }
  });

  it("narrows verifyEach outcomes and VerifyOutcome by code in the type tests", () => {
    const pending = newError({ code: "not-confirmed", handle: HANDLE }, "m", { secrets: [] });
    const timeout = newError({ code: "timeout", backend: "sourcify", timeoutMs: 9 }, "m", {
      secrets: [],
    });
    assert.deepEqual(
      pendingHandles({
        outcomes: [
          { backend: "sourcify", ok: false, error: pending },
          { backend: "etherscan-v2", ok: false, error: timeout },
        ],
      }),
      [HANDLE],
    );
    assert.equal(timeoutOf(timeout), 9);
    assert.equal(timeoutOf(pending), undefined);
  });

  it("checks the prototype chain for a subclass, and the brand only for the class itself", () => {
    const sub = new AppError({ code: "internal-error" }, "m", { secrets: [] });
    const base = newError({ code: "internal-error" }, "m", { secrets: [] });
    assert.ok(sub instanceof AppError);
    assert.ok(sub instanceof ExplorerVerifyError);
    assert.ok(ExplorerVerifyError.is(sub, "internal-error"));
    assert.equal(appOf(sub), "demo");
    assert.equal(base instanceof AppError, false);
    assert.equal(appOf(base), undefined);
    assert.equal(Object.create(AppError.prototype) instanceof AppError, true);
  });

  it("reads the brand as an own property only, so a polluted Object.prototype brands nothing (R-SEC-1)", () => {
    const brand = Symbol.for("explorer-verify.error");
    assert.ok(Reflect.defineProperty(Object.prototype, brand, { value: true, configurable: true }));
    try {
      const plain = { code: "network" };
      assert.equal(ExplorerVerifyError.is(plain), false);
      assert.equal(plain instanceof ExplorerVerifyError, false);
      assert.ok(ExplorerVerifyError.is(newError(SAMPLE_DETAILS.network, "m", { secrets: [] })));
    } finally {
      Reflect.deleteProperty(Object.prototype, brand);
    }
    assert.equal(Reflect.get({}, brand), undefined);
  });

  it("toEnvelope() refuses a branded value without a usable toJSON() by naming toJSON() (R-AX-5)", () => {
    const brand = Symbol.for("explorer-verify.error");
    const values: unknown[] = [
      Object.defineProperty({ code: "network" }, brand, { value: true }),
      Object.defineProperty({ name: "ExplorerVerifyError", toJSON: 1 }, brand, { value: true }),
    ];
    for (const value of values) {
      if (!(value instanceof ExplorerVerifyError)) {
        assert.fail("the brand makes instanceof hold");
      }
      assert.throws(
        () => toEnvelope(value),
        (error: unknown) =>
          ExplorerVerifyError.is(error, "invalid-input") &&
          error.details.issues.some(
            (issue) =>
              issue.field === "outcome" &&
              issue.message.includes("toJSON() that returns an object"),
          ),
      );
    }
  });

  it("builds every error in the source through newError: no other source file calls the constructor", () => {
    const src = path.resolve(here, "../../src");
    const found = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        readFileSync(path.join(src, file), "utf8")
          .split("\n")
          // TSDoc examples show the constructor; only code counts.
          .some(
            (line) => !/^\s*(?:\*|\/\/)/.test(line) && /\bnew ExplorerVerifyError\b/.test(line),
          ),
      )
      .map((file) => file.split(path.sep).join("/"));
    assert.deepEqual(found, ["error-hints.ts"]);
  });

  it("rejects values that are not errors of this library, and never throws", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    const lookalike = { name: "ExplorerVerifyError", code: "network", details: {} };
    for (const value of [
      undefined,
      null,
      0,
      "ExplorerVerifyError",
      new Error("x"),
      lookalike,
      { [Symbol.for("explorer-verify.error")]: false },
      revoked.proxy,
      throwing,
    ]) {
      assert.equal(ExplorerVerifyError.is(value), false);
      assert.equal(ExplorerVerifyError.is(value, "network"), false);
      assert.equal(value instanceof ExplorerVerifyError, false);
    }
  });

  it("keeps the brand out of Object.keys, a spread and JSON (R-AX-5)", () => {
    const error = newError(SAMPLE_DETAILS["rate-limited"], "m", { secrets: [] });
    assert.deepEqual(Object.keys(error), ["code", "hint", "retryable", "details", "docsUrl"]);
    assert.deepEqual(Object.getOwnPropertySymbols(Object.assign({}, error)), []);
    const parsed: unknown = JSON.parse(JSON.stringify(error));
    assert.ok(typeof parsed === "object" && parsed !== null);
    assert.deepEqual(Object.keys(parsed), ["code", "message", "hint", "docsUrl", "retryable"]);
  });

  it("recognises an error built by a second copy of the package, with is() and instanceof", async () => {
    const first = await loadCopy();
    const second = await loadCopy();
    for (const entry of [first, second]) {
      const error = foreignError(entry, { code: "not-confirmed", handle: HANDLE });
      assert.ok(ExplorerVerifyError.is(error));
      assert.ok(ExplorerVerifyError.is(error, "not-confirmed"));
      assert.ok(!ExplorerVerifyError.is(error, "network"));
      assert.ok(error instanceof ExplorerVerifyError);
      assert.deepEqual(handleOf(error), HANDLE);
    }
    // The other way round: the copy recognises an error of this module.
    const ctor: unknown =
      typeof first === "object" && first !== null
        ? Reflect.get(first, "ExplorerVerifyError")
        : undefined;
    assert.equal(typeof ctor, "function");
    const own = newError(SAMPLE_DETAILS.network, "m", { secrets: [] });
    assert.ok(typeof ctor === "function" && own instanceof ctor);
    const is: unknown = Reflect.get(Object(ctor), "is");
    assert.ok(typeof is === "function");
    assert.equal(Reflect.apply(is, ctor, [own, "network"]), true);
    assert.equal(Reflect.apply(is, ctor, [own, "timeout"]), false);
  });

  it("toEnvelope() reads an error of another copy as that copy's, checked field by field (R-AX-5)", async () => {
    const copy = await loadCopy();
    const foreign = foreignError(copy, { code: "not-confirmed", handle: HANDLE });
    const own = newError({ code: "not-confirmed", handle: HANDLE }, "from the copy", {
      secrets: [],
    });
    assert.ok(foreign instanceof ExplorerVerifyError);
    const expected = toEnvelope(own);
    assert.ok("error" in expected);
    assert.deepEqual(toEnvelope(foreign), {
      ...expected,
      error: { ...expected.error, hint: `Read ${docsUrlOf("not-confirmed")} for what to do next.` },
    });
  });
});

describe("ExplorerVerifyError hint and JSON form (R-DX-3, R-AX-5)", () => {
  it("points to docsUrl when it is built without a hint, and to it also for a blank hint", () => {
    for (const code of ERROR_CODES) {
      for (const options of [{ secrets: [] }, { hint: "  ", secrets: [] }]) {
        const error = new ExplorerVerifyError(SAMPLE_DETAILS[code], "m", options);
        assert.equal(error.hint, `Read ${docsUrlOf(code)} for what to do next.`);
      }
    }
  });

  it("library errors carry ERROR_HINTS, and ERROR_HINTS has one non-empty hint per code", () => {
    assert.deepEqual(Object.keys(ERROR_HINTS).toSorted(), [...ERROR_CODES].toSorted());
    for (const code of ERROR_CODES) {
      assert.ok(ERROR_HINTS[code].trim().length > 0, code);
      assert.equal(newError(SAMPLE_DETAILS[code], "m", { secrets: [] }).hint, ERROR_HINTS[code]);
      assert.equal(
        newError(SAMPLE_DETAILS[code], "m", { hint: "Do this.", secrets: [] }).hint,
        "Do this.",
      );
    }
  });

  it("redacts a hint passed to the constructor (R-SEC-1)", () => {
    const key = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", {
      hint: `Use ${key}.`,
      secrets: [key],
    });
    assert.ok(!error.hint.includes(key));
  });

  it("pins the toJSON() form: code, message, hint, docsUrl, retryable, then handle", () => {
    const error = newError({ code: "not-confirmed", handle: HANDLE }, "Still verifying.", {
      secrets: [],
    });
    assert.deepEqual(error.toJSON(), {
      code: "not-confirmed",
      message: "Still verifying.",
      hint: ERROR_HINTS["not-confirmed"],
      docsUrl: docsUrlOf("not-confirmed"),
      retryable: true,
      handle: `ev1:sourcify:11155111:${HANDLE.address}:${HANDLE.jobId}`,
    });
  });
});

describe("ExplorerVerifyError details from code that bypasses the types (R-SEC-1)", () => {
  it("keeps closed-set fields within their set and hashes within 0x and 64 hex digits", () => {
    const incomplete: ErrorDetails = { code: "incomplete-input", field: "sources", candidates: [] };
    Reflect.set(incomplete, "field", "contract DUMMYKEY0123456789ABCDEFGHIJKLMNO");
    assert.deepEqual(newError(incomplete, "m", { secrets: [] }).details, {
      code: "incomplete-input",
      field: "input",
      candidates: [],
    });
    const artifact: ErrorDetails = { code: "insufficient-artifact", field: "input" };
    Reflect.set(artifact, "field", 42);
    assert.deepEqual(newError(artifact, "m", { secrets: [] }).details, {
      code: "insufficient-artifact",
      field: "input",
    });
    const compiler: ErrorDetails = { code: "unsupported-compiler", field: "language" };
    assert.deepEqual(newError(compiler, "m", { secrets: [] }).details, compiler);
    Reflect.set(compiler, "field", 42);
    assert.deepEqual(newError(compiler, "m", { secrets: [] }).details, {
      code: "unsupported-compiler",
      field: "",
    });
    const mismatch: ErrorDetails = {
      code: "source-mismatch",
      path: "A.sol",
      expected: `0x${"A".repeat(64)}`,
      actual: `0x${"b".repeat(63)}`,
    };
    Reflect.set(mismatch, "path", 7);
    assert.deepEqual(newError(mismatch, "m", { secrets: [] }).details, {
      code: "source-mismatch",
      path: "",
      expected: "0x",
      actual: "0x",
    });
  });
});
