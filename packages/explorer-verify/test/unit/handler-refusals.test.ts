// Each refusal of createVerifyHandler, end to end: the client calls verify() or linkProxy() with
// handlerUrl, its fetch hands each request to a real createVerifyHandler, and the handler's
// upstream is a fake Etherscan. The test checks the error code, retryable and the handler's code
// for each guard (R-SRV-4, R-SRV-5, R-FLOW-4, R-DX-3, decision 0048).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { ERROR_HINTS } from "../../src/error-hints.ts";
import { ERROR_CODES, ExplorerVerifyError, linkProxy, verify } from "../../src/index.ts";
import type { VerifyInput } from "../../src/index.ts";
import { createVerifyHandler } from "../../src/server/handler.ts";
import type { HandlerRefusal, VerifyHandlerOptions } from "../../src/server/handler.ts";
import { HANDLER_REFUSALS } from "../../src/server/refusals.ts";
import { etherscanFixture, json } from "../helpers/fake-explorer.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const DEPLOYER = "0x9d087fc03ae39b088326b67fa3c788236645b717";
const OTHER = "0x1111111111111111111111111111111111111111";
const HANDLER = "https://dapp.example/api/verify";
// A made-up key. Never a real one (R-SEC-1).
const KEY = "dummy-handler-key-215";
const NOT_VERIFIED = etherscanFixture("2026-11-03-getsourcecode-not-verified").body;

function input(): VerifyInput {
  return {
    chainId: SEPOLIA,
    address: GREETER,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: `contract Greeter {}${" ".repeat(400)}` } },
        settings: {},
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
  };
}

/** An upstream that answers every request with `answer()`, or throws when `answer` throws. */
function upstream(answer: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (_target, init) => {
      const body = init?.body;
      calls.push(
        body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "",
      );
      return await answer();
    },
  };
}

/** How the page's fetch changes a request before the handler gets it. */
type Tamper = (request: Request) => Request | Promise<Request>;

/**
 * A client fetch that hands each request to a real `createVerifyHandler`, after `tamper`, and
 * counts the requests.
 */
function throughHandler(
  options: Partial<VerifyHandlerOptions>,
  tamper: Tamper = (request) => request,
): { fetch: typeof fetch; sent: () => number } {
  const handler = createVerifyHandler({ apiKey: KEY, chains: [SEPOLIA], ...options });
  let sent = 0;
  return {
    sent: () => sent,
    fetch: async (target, init) => {
      sent += 1;
      const url = typeof target === "string" ? target : target instanceof URL ? target.href : "";
      assert.ok(url.startsWith(`${HANDLER}?`), url);
      return await handler(await tamper(new Request(url, init)));
    },
  };
}

/** A copy of `request` with `body` and, optionally, other headers or another method. */
async function rebuilt(
  request: Request,
  edit: (body: URLSearchParams) => void,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Request> {
  const body = new URLSearchParams(await request.text());
  edit(body);
  return new Request(request.url, {
    method: init.method ?? request.method,
    headers: init.headers ?? { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function rejection(call: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome = await call.then(
    (value) => ({ value }),
    (error: unknown) => error,
  );
  // R-FLOW-4: a refusal never gives a result, verified or failed.
  assert.ok(outcome instanceof ExplorerVerifyError, JSON.stringify(outcome));
  return outcome;
}

/**
 * Runs `call` on the mock clock, 100 ms per event-loop turn, and returns its rejection. The clock
 * moves in steps, not with `runAll()`, because the handler's own timers and the client's timers
 * are pending at once: `runAll()` would fire the client's request timeout before the handler
 * answers. Loading a client takes some real turns; at 100 ms a turn, that spends a few seconds of
 * the 120-second budget at most.
 */
async function driven(t: TestContext, start: () => Promise<unknown>): Promise<ExplorerVerifyError> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const call = start();
  await driveMockClock(call, () => {
    t.mock.timers.tick(100);
  });
  return await rejection(call);
}

function assertNoKey(error: ExplorerVerifyError): void {
  const shown = JSON.stringify([error.message, error.hint, error.details, error.toJSON()]);
  assert.ok(!shown.includes(KEY), "the key is shown");
}

describe("each guard of createVerifyHandler that holds until its options change is handler-refused (R-SRV-4, decision 0048)", () => {
  it("chain-not-allowed: 403, hint names the chains option", async () => {
    const net = throughHandler({ chains: [1] });
    const error = await rejection(verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
    assert.ok(ExplorerVerifyError.is(error, "handler-refused"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, false);
    assert.equal(error.details.handlerCode, "chain-not-allowed");
    assert.equal(error.details.status, 403);
    assert.equal(error.details.backend, "etherscan-v2");
    assert.match(error.details.excerpt, /"code":"chain-not-allowed"/);
    assert.match(error.message, /^Your server handler answered the lookup with chain-not-allowed/);
    assert.match(error.hint, /chains option of createVerifyHandler/);
    assert.equal(error.docsUrl.endsWith("/reference/errors/handler-refused"), true);
    assert.equal(error.toJSON().retryable, false);
    assert.equal(net.sent(), 1, "not retried");
    assertNoKey(error);
  });

  it("address-not-allowed: 403, hint names the deployers option", async () => {
    const explorer = upstream(() =>
      json({
        status: "1",
        message: "OK",
        result: [{ contractAddress: GREETER, contractCreator: OTHER }],
      }),
    );
    const net = throughHandler({ deployers: [DEPLOYER], fetch: explorer.fetch });
    const error = await rejection(verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
    assert.ok(ExplorerVerifyError.is(error, "handler-refused"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, false);
    assert.equal(error.details.handlerCode, "address-not-allowed");
    assert.equal(error.details.status, 403);
    assert.match(error.hint, /deployers option of createVerifyHandler/);
    assert.equal(explorer.calls.length, 1, "only the creation lookup reached Etherscan");
    assertNoKey(error);
  });

  it("action-not-allowed: linkProxy without allowProxyLink, hint names allowProxyLink", async () => {
    const explorer = upstream(() => json(NOT_VERIFIED));
    const net = throughHandler({ fetch: explorer.fetch });
    const error = await rejection(
      linkProxy({ chainId: SEPOLIA, address: GREETER }, { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(ExplorerVerifyError.is(error, "handler-refused"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, false);
    assert.equal(error.details.handlerCode, "action-not-allowed");
    assert.equal(error.details.status, 403);
    assert.match(error.hint, /allowProxyLink/);
  });

  it("body-too-large: the submit is refused with 413, hint names maxBodyBytes; no result (R-FLOW-4)", async () => {
    const explorer = upstream(() => json(NOT_VERIFIED));
    const net = throughHandler({ maxBodyBytes: 300, fetch: explorer.fetch });
    const error = await rejection(verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
    assert.ok(ExplorerVerifyError.is(error, "handler-refused"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, false);
    assert.equal(error.details.handlerCode, "body-too-large");
    assert.equal(error.details.status, 413);
    assert.match(error.message, /answered the submit with body-too-large/);
    assert.match(error.hint, /maxBodyBytes/);
    assert.equal(explorer.calls.length, 1, "only the lookup reached Etherscan");
    assert.equal(net.sent(), 2, "the lookup, then one submit, never sent again");
  });

  const mismatch: [HandlerRefusal, number, Tamper][] = [
    [
      "forbidden-field",
      400,
      async (request) =>
        await rebuilt(request, (body) => {
          body.set("apikey", "dummy-page-key");
        }),
    ],
    [
      "bad-request",
      400,
      async (request) =>
        await rebuilt(request, (body) => {
          body.append("module", "contract");
        }),
    ],
    [
      "method-not-allowed",
      405,
      async (request) => await rebuilt(request, () => undefined, { method: "PUT" }),
    ],
    [
      "unsupported-media-type",
      415,
      async (request) =>
        await rebuilt(request, () => undefined, { headers: { "content-type": "text/plain" } }),
    ],
  ];
  for (const [code, status, tamper] of mismatch) {
    it(`${code}: ${String(status)}, with the code's default hint`, async () => {
      const net = throughHandler({}, tamper);
      const error = await rejection(verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
      assert.ok(
        ExplorerVerifyError.is(error, "handler-refused"),
        `${error.code}: ${error.message}`,
      );
      assert.equal(error.retryable, false);
      assert.equal(error.details.handlerCode, code);
      assert.equal(error.details.status, status);
      assert.equal(error.hint, ERROR_HINTS["handler-refused"]);
      assert.equal(net.sent(), 1, "not retried");
    });
  }
});

describe("the handler's transient refusals stay retryable (R-SRV-4, decision 0048)", () => {
  it("rate-limited: the handler's rateLimit refuses, and the client retries, then throws rate-limited", async (t) => {
    const net = throughHandler({ rateLimit: () => false });
    const error = await driven(
      t,
      async () => await verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(ExplorerVerifyError.is(error, "rate-limited"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, true);
    assert.ok(net.sent() > 1, "retried");
  });

  it("upstream-rate-limited: Etherscan's 429 reaches the client as rate-limited", async (t) => {
    const explorer = upstream(() => json({ status: "0", message: "NOTOK", result: "busy" }, 429));
    const net = throughHandler({ fetch: explorer.fetch });
    const error = await driven(
      t,
      async () => await verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(ExplorerVerifyError.is(error, "rate-limited"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, true);
  });

  it("upstream-error: Etherscan unreachable gives network after the retries, naming the code", async (t) => {
    const explorer = upstream(() => {
      throw new TypeError("fetch failed");
    });
    const net = throughHandler({ fetch: explorer.fetch });
    const error = await driven(
      t,
      async () => await verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(ExplorerVerifyError.is(error, "network"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, true);
    assert.equal(error.details.attempts, net.sent());
    assert.match(
      error.message,
      /^Your server handler answered the lookup with upstream-error \(status 502\)/,
    );
    assert.equal(error.hint, ERROR_HINTS.network);
    assert.ok(error.cause instanceof Error, "the HTTP layer's error is the cause");
    assertNoKey(error);
  });

  it("upstream-timeout: Etherscan not answering gives network after the retries", async (t) => {
    const explorer = upstream(async () => await new Promise<Response>(() => undefined));
    const net = throughHandler({ fetch: explorer.fetch, timeoutMs: 3_000 });
    const error = await driven(
      t,
      async () => await verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(ExplorerVerifyError.is(error, "network"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, true);
    assert.match(error.message, /with upstream-timeout \(status 504\)/);
  });

  it("request-timeout: a body that never arrives gives a retryable network error", async (t) => {
    const net = throughHandler({ timeoutMs: 3_000 }, (request) => {
      // `duplex` is required for a stream body, and the DOM types do not declare it yet.
      const init: RequestInit & { readonly duplex: "half" } = {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new ReadableStream<Uint8Array>({
          pull: async () => await new Promise(() => undefined),
        }),
        duplex: "half",
      };
      return new Request(request.url, init);
    });
    const error = await driven(
      t,
      async () => await verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(ExplorerVerifyError.is(error, "network"), `${error.code}: ${error.message}`);
    assert.equal(error.retryable, true);
    assert.equal(error.details.attempts, 1);
    assert.match(error.message, /answered the lookup with request-timeout \(status 408\)/);
  });

  it("address-not-indexed: the client waits as Retry-After asks, then throws a retryable unexpected-response", async (t) => {
    const explorer = upstream(() => json({ status: "1", message: "OK", result: [] }));
    const net = throughHandler({ deployers: [DEPLOYER], fetch: explorer.fetch });
    const error = await driven(
      t,
      async () => await verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }),
    );
    assert.ok(
      ExplorerVerifyError.is(error, "unexpected-response"),
      `${error.code}: ${error.message}`,
    );
    assert.equal(error.retryable, true);
    assert.equal(error.details.status, 503);
    assert.equal(error.details.retryAfterMs, 5_000);
    assert.match(error.message, /answered the lookup with address-not-indexed \(status 503\)/);
    assert.equal(error.hint, ERROR_HINTS["unexpected-response"]);
    assert.ok(net.sent() > 1, "retried");
  });

  it("internal-error: the handler failed; a retryable unexpected-response points at its logs", async () => {
    const net = throughHandler({
      rateLimit: () => {
        throw new Error("store down");
      },
    });
    const error = await rejection(verify(input(), { fetch: net.fetch, handlerUrl: HANDLER }));
    assert.ok(
      ExplorerVerifyError.is(error, "unexpected-response"),
      `${error.code}: ${error.message}`,
    );
    assert.equal(error.retryable, true);
    assert.equal(error.details.status, 500);
    assert.match(error.message, /answered the lookup with internal-error \(status 500\)/);
    assert.equal(error.hint, ERROR_HINTS["unexpected-response"]);
  });
});

describe("the refusal table (decision 0048)", () => {
  it("maps every refusal code to an error code of the catalogue", () => {
    const codes: readonly string[] = ERROR_CODES;
    for (const [refusal, [code, status]] of Object.entries(HANDLER_REFUSALS)) {
      assert.ok(codes.includes(code), `${refusal} maps to ${code}`);
      assert.ok(status >= 400 && status < 600, `${refusal} comes with ${String(status)}`);
    }
  });

  it("gives handler-refused a default hint that names createVerifyHandler", () => {
    assert.match(ERROR_HINTS["handler-refused"], /createVerifyHandler/);
  });
});
