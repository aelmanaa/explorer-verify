// Tests added after a mutation review of the Sourcify client (#109; R-BE-4, R-FLOW-4, R-SEC-1):
// each one fails on a code change that the other Sourcify tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context, ResolvedInput, Target } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { validateInput } from "../../src/input/validate.ts";
import { resolveRoute } from "../../src/routing/resolve.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Fixture, Step } from "../helpers/fake-fetch.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const TARGET: Target = { chainId: SEPOLIA, address: GREETER };
const SUBMIT_URL = `POST https://sourcify.dev/server/v2/verify/${String(SEPOLIA)}/${GREETER}`;
const LOOKUP_URL = `GET https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}`;

function fixture(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-02-${name}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A response whose body fails after the headers arrived. */
function brokenBody(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection reset"));
      },
    }),
    { status },
  );
}

interface SetupOptions {
  secrets?: string[];
  maxResponseBytes?: number;
}

function contextOf(fetch: typeof globalThis.fetch, options: SetupOptions): Context {
  return {
    route: resolveRoute(SEPOLIA, undefined, { allowSourcifyFallback: true }),
    http: {
      backend: "sourcify",
      fetch,
      secrets: options.secrets ?? [],
      random: () => 0,
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
    },
  };
}

/** A Sourcify context whose requests the shared `replay` helper answers with `steps`, in order. */
function setup(steps: Step[], options: SetupOptions = {}): { ctx: Context; sent: () => string[] } {
  const fake = replay(...steps);
  return {
    ctx: contextOf(fake.fetch, options),
    sent: () => fake.calls.map((call) => `${call.method} ${call.url}`),
  };
}

/**
 * A fetch that answers with a status-0 response, as a browser's opaque response has, whose body
 * fails. `replay` clones each response, which drops a changed status, so this case needs its own.
 */
function opaqueBrokenBody(sent: string[]): typeof globalThis.fetch {
  return async (request, init) => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    sent.push(`${init?.method ?? "GET"} ${url}`);
    const response = brokenBody(200);
    Object.defineProperty(response, "status", { value: 0 });
    return response;
  };
}

function input(): ResolvedInput {
  return validateInput({
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
  });
}

async function errorOf(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome: unknown = await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

function assertUnexpected(error: ExplorerVerifyError, status: number, excerpt: string): void {
  assert.deepEqual(error.details, {
    code: "unexpected-response",
    backend: "sourcify",
    status,
    excerpt,
  });
}

describe("sourcify lookup: only a 200 or a 404 reads the match (R-BE-4, R-FLOW-4)", () => {
  it("throws unexpected-response on a 500 whose body has a null match, never 'not verified'", async () => {
    const body = { match: null, chainId: String(SEPOLIA), address: GREETER };
    const { ctx } = setup([json(500, body)]);
    const error = await errorOf(sourcify.lookup(TARGET, ctx));
    assertUnexpected(error, 500, JSON.stringify(body));
  });

  it("throws unexpected-response on a 400 that is not JSON", async () => {
    const { ctx, sent } = setup([new Response("Bad Request", { status: 400 })]);
    const error = await errorOf(sourcify.lookup(TARGET, ctx));
    assertUnexpected(error, 400, "Bad Request");
    assert.deepEqual(sent(), [LOOKUP_URL]);
  });
});

describe("sourcify submit: answers that are not 'maybe accepted' are thrown at once (R-BE-4, R-FLOW-4)", () => {
  it("throws a 400 that is not JSON, with no lookup and no second submit", async () => {
    const { ctx, sent } = setup([new Response("Bad Request", { status: 400 })]);
    const error = await errorOf(sourcify.submit(input(), ctx));
    assertUnexpected(error, 400, "Bad Request");
    assert.deepEqual(sent(), [SUBMIT_URL]);
  });

  it("throws a 400 whose body failed: only a 2xx body failure may hide an accepted submit", async () => {
    const { ctx, sent } = setup([brokenBody(400)]);
    const error = await errorOf(sourcify.submit(input(), ctx));
    assertUnexpected(error, 400, "");
    assert.ok(error.cause instanceof Error);
    assert.deepEqual(sent(), [SUBMIT_URL]);
  });

  it("throws a status-0 answer whose body failed, as a browser's opaque response gives", async () => {
    const sent: string[] = [];
    const ctx = contextOf(opaqueBrokenBody(sent), {});
    const error = await errorOf(sourcify.submit(input(), ctx));
    assertUnexpected(error, 0, "");
    assert.ok(error.cause instanceof Error);
    assert.deepEqual(sent, [SUBMIT_URL]);
  });

  it("throws a 202 whose body is too large: it has no cause, so it is not a failed read", async () => {
    const { ctx, sent } = setup([fixture("submit-accepted")], { maxResponseBytes: 16 });
    const error = await errorOf(sourcify.submit(input(), ctx));
    assert.equal(error.details.code, "unexpected-response");
    assert.equal(error.details.code === "unexpected-response" && error.details.status, 202);
    assert.equal(error.cause, undefined);
    assert.deepEqual(sent(), [SUBMIT_URL]);
  });

  it("looks up and submits again after a 200 whose body failed, as a 202 that failed does", async () => {
    const { ctx, sent } = setup([
      brokenBody(200),
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
    ]);
    const outcome = await sourcify.submit(input(), ctx);
    assert.deepEqual(outcome, {
      state: "submitted",
      handle: {
        version: 1,
        backend: "sourcify",
        chainId: SEPOLIA,
        address: GREETER,
        jobId: GREETER_JOB,
      },
    });
    assert.deepEqual(sent(), [SUBMIT_URL, LOOKUP_URL, SUBMIT_URL]);
  });

  it("throws on a 202 whose verificationId is an array, even one that holds a valid id", async () => {
    const body = { verificationId: [GREETER_JOB] };
    const { ctx, sent } = setup([json(202, body)]);
    const error = await errorOf(sourcify.submit(input(), ctx));
    assertUnexpected(error, 202, JSON.stringify(body));
    assert.deepEqual(sent(), [SUBMIT_URL]);
  });

  it("reads already_verified only from a 409", async () => {
    const body = { customCode: "already_verified", message: "already verified" };
    const { ctx } = setup([json(400, body)]);
    const error = await errorOf(sourcify.submit(input(), ctx));
    assertUnexpected(error, 400, JSON.stringify(body));
  });

  it("reads duplicate_verification_request only from a 429", async () => {
    const body = { customCode: "duplicate_verification_request", message: "in progress" };
    const { ctx } = setup([json(400, body)]);
    const error = await errorOf(sourcify.submit(input(), ctx));
    assertUnexpected(error, 400, JSON.stringify(body));
  });

  it("reads a 429 as in-progress only from the body's own customCode, not an inherited one", async () => {
    // A polluted Object.prototype makes the HTTP layer pass the 429 on as Sourcify's duplicate
    // answer; the client reads only own fields, so it does not report in-progress.
    Reflect.set(Object.prototype, "customCode", "duplicate_verification_request");
    try {
      const { ctx } = setup([json(429, {})]);
      const error = await errorOf(sourcify.submit(input(), ctx));
      assertUnexpected(error, 429, "{}");
    } finally {
      Reflect.deleteProperty(Object.prototype, "customCode");
    }
  });
});

describe("sourcify errors redact with the call's secrets (R-SEC-1)", () => {
  it("redacts in-progress with the call's secrets", async () => {
    const { ctx } = setup([fixture("submit-duplicate")], { secrets: [GREETER] });
    const error = await errorOf(sourcify.submit(input(), ctx));
    assert.deepEqual(error.details, { code: "in-progress", backend: "sourcify" });
    assert.equal(
      error.message,
      `Sourcify is already verifying [redacted] on chain ${String(SEPOLIA)}.`,
    );
  });

  it("redacts unsupported-chain from a lookup with the call's secrets", async () => {
    const { ctx } = setup([fixture("lookup-unsupported-chain")], {
      secrets: [String(SEPOLIA)],
    });
    const error = await errorOf(sourcify.lookup(TARGET, ctx));
    assert.equal(error.code, "unsupported-chain");
    assert.equal(error.message, "Sourcify does not support chain [redacted].");
  });

  it("redacts unsupported-chain from a submit with the call's secrets", async () => {
    const { ctx } = setup([fixture("submit-unsupported-chain")], {
      secrets: [String(SEPOLIA)],
    });
    const error = await errorOf(sourcify.submit(input(), ctx));
    assert.equal(error.code, "unsupported-chain");
    assert.equal(error.message, "Sourcify does not support chain [redacted].");
  });
});
