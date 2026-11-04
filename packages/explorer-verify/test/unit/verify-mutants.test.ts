// Tests added after a mutation review of the verify flow (#109; R-DX-3, R-FLOW-3, R-FLOW-4,
// R-FLOW-6, R-SEC-1): each one fails on a code change that the other flow tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend, Target } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { openCall, routeOf, runVerify, settingsOf, settle } from "../../src/flow/verify.ts";
import type { Call, FlowDependencies } from "../../src/flow/verify.ts";
import type { Handle, VerifyInput, VerifyOptions } from "../../src/types.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const TARGET: Target = { chainId: SEPOLIA, address: GREETER };
const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: SEPOLIA,
  address: GREETER,
  jobId: GREETER_JOB,
};
const MESSAGE_START = `sourcify job ${GREETER_JOB} found the contract already verified, but`;

/** A fetch that must not be called: the backends in these tests answer without one. */
const noFetch: typeof fetch = async () => {
  throw new Error("no request expected");
};

/** Sourcify's client, whose poll says "already verified" without the grade, and `lookup`. */
function gradeUnknown(lookup: Backend["lookup"]): Backend {
  return { ...sourcify, poll: async () => ({ state: "already-verified" }), lookup };
}

function callWith(backend: Backend, options: VerifyOptions = {}): Call {
  const settings = settingsOf({ fetch: noFetch, ...options });
  const dependencies: FlowDependencies = { backends: { sourcify: backend }, random: () => 0 };
  return openCall(settings, routeOf(SEPOLIA, settings, dependencies), TARGET, dependencies);
}

async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

function networkError(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "network", backend: "sourcify", attempts: 5 },
    "no answer",
    { secrets: [] },
  );
}

describe("settle(): the grade lookup after an already-verified job (R-FLOW-3, R-FLOW-4)", () => {
  it("says the lookup found the contract not verified, with no cause", async () => {
    const call = callWith(gradeUnknown(async () => undefined));
    const error = errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
    assert.equal(
      error.message,
      `${MESSAGE_START} the lookup says it is not verified; the match is not known.`,
    );
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(error.details.code === "unknown-state" && error.details.excerpt, "");
  });

  it("says the lookup failed, with the lookup error as the cause", async () => {
    const call = callWith(
      gradeUnknown(async () => {
        throw networkError();
      }),
    );
    const error = errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
    assert.equal(
      error.message,
      `${MESSAGE_START} the lookup to read its match failed; the match is not known.`,
    );
    assert.equal(Object.hasOwn(error, "cause"), true);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "no answer");
  });

  it("keeps an excerpt only from an unexpected-response cause", async () => {
    const call = callWith(
      gradeUnknown(async () => {
        throw new ExplorerVerifyError(
          { code: "unknown-state", handle: HANDLE, excerpt: "an excerpt of another error" },
          "another error",
          { secrets: [] },
        );
      }),
    );
    const error = errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
    assert.equal(error.details.code === "unknown-state" && error.details.excerpt, "");
  });

  it("rethrows an error that is not an ExplorerVerifyError unchanged", async () => {
    const thrown = new TypeError("a bug in the client");
    const call = callWith(
      gradeUnknown(async () => {
        throw thrown;
      }),
    );
    assert.equal(await outcomeOf(settle(call, HANDLE, 0)), thrown);
  });

  it("maps a lookup error to unknown-state while the caller's signal has not aborted (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const call = callWith(
      gradeUnknown(async () => {
        throw networkError();
      }),
      { signal: controller.signal },
    );
    errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
  });

  it("rethrows a lookup error unchanged once the caller's signal aborted (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const thrown = networkError();
    const call = callWith(
      gradeUnknown(async () => {
        controller.abort(new Error("stopped by the caller"));
        throw thrown;
      }),
      { signal: controller.signal },
    );
    assert.equal(await outcomeOf(settle(call, HANDLE, 0)), thrown);
  });
});

describe("settingsOf(): options of the wrong kind (R-DX-3)", () => {
  for (const value of ["fast", 5, true]) {
    it(`throws invalid-input for options set to ${JSON.stringify(value)}`, () => {
      // `Reflect.apply` takes untyped arguments, so a JavaScript caller's value needs no cast.
      assert.throws(
        () => Reflect.apply(settingsOf, undefined, [value]),
        (error: unknown) => {
          const checked = errorOf(error, "invalid-input");
          assert.deepEqual(checked.details.code === "invalid-input" && checked.details.issues, [
            { field: "options", message: "must be an object" },
          ]);
          return true;
        },
      );
    });
  }

  it("says what a duration option must be", () => {
    const options: VerifyOptions = {};
    Reflect.set(options, "timeoutMs", "100");
    assert.throws(
      () => settingsOf(options),
      (error: unknown) => {
        const checked = errorOf(error, "invalid-input");
        assert.deepEqual(checked.details.code === "invalid-input" && checked.details.issues, [
          { field: "timeoutMs", message: "must be a positive finite number of milliseconds" },
        ]);
        return true;
      },
    );
  });
});

describe("verify(): which values of the route's query are secrets (R-SEC-1)", () => {
  it("redacts each value of 8 characters or more that is not all digits, and keeps the rest", async () => {
    const values = {
      letters: "abcdefghij",
      leadingDigits: "12345678abcd",
      trailingDigits: "abcd12345678",
      eight: "exactly8",
      digits: "987654321",
    };
    const query = new URLSearchParams(values).toString();
    const echo = Object.values(values).join(" ");
    const fetch: typeof globalThis.fetch = async () => new Response(echo, { status: 500 });
    const input: VerifyInput = {
      chainId: SEPOLIA,
      address: GREETER,
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: {
          language: "Solidity",
          sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
          settings: {},
        },
      },
      contractName: "contracts/Greeter.sol:Greeter",
    };
    const outcome = await outcomeOf(
      runVerify(
        input,
        { fetch, route: { apiUrl: `https://sourcify.example.org/server?${query}` } },
        { backends: { sourcify }, random: () => 0 },
      ),
    );
    const error = errorOf(outcome, "unexpected-response");
    assert.equal(
      error.details.code === "unexpected-response" && error.details.excerpt,
      "[redacted] [redacted] [redacted] [redacted] 987654321",
    );
  });
});
